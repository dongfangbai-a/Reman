import { homedir } from 'node:os';
import { isAbsolute, parse, relative } from 'node:path';
import { clipEnd } from '../../common/text.ts';
import { contains, resolveToolPath } from '../paths.ts';
import { isShellCommandOption, POSIX_SHELLS, wildcardBase, type CommandLanguage, type CommandParser, type Directories, type IWord } from './commandParser.ts';

/** cmd /c 里的命令按 cmd 的写法拆。 */
type Syntax = CommandLanguage | 'cmd';

/** 套了几层 shell 的命令最多拆几层。 */
const MAX_DEPTH = 3;
/** 报错里的命令最多写多少字。 */
const SHOWN_CHARS = 200;

const DISK_EFFECT = '会格式化、分区或擦除磁盘';
const POWER_EFFECT = '会关机、重启、休眠或注销电脑';
const BOOT_EFFECT = '会破坏系统的启动配置、还原点或备份';

/** PowerShell 里这些都是 Remove-Item 的别名。 */
const REMOVE_ITEM_ALIASES: ReadonlySet<string> = new Set(['rm', 'del', 'erase', 'rd', 'rmdir']);
const DISK_TOOLS: ReadonlySet<string> = new Set([
	'mkfs', 'mke2fs', 'mkswap', 'wipefs', 'format', 'diskpart', 'fdisk', 'sfdisk', 'cfdisk', 'gdisk', 'sgdisk', 'parted',
	'format-volume', 'clear-disk', 'initialize-disk',
]);
const POWER_COMMANDS: ReadonlySet<string> = new Set(['shutdown', 'reboot', 'halt', 'poweroff', 'logoff', 'stop-computer', 'restart-computer']);
/** 加在命令前面、后面才是真正要执行的命令；值是带参数的选项。 */
const PREFIXES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
	['sudo', new Set(['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-U', '-T'])],
	['doas', new Set(['-u', '-C'])],
	['env', new Set(['-u', '-C'])],
	['nice', new Set(['-n'])],
	['nohup', new Set()],
	['time', new Set()],
	['command', new Set()],
	['exec', new Set()],
	['builtin', new Set()],
]);

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const PWSH_RECURSE = /^-r(e(c(u(r(s(e)?)?)?)?)?)?(:\$?true)?$/i;
/** Remove-Item 里带值、值又不是路径的参数。 */
const PWSH_VALUE_PARAMETER = /^-(inc|exc|fil|cred|str)/i;
const ICACLS_CHANGE = /^\/(grant|deny|remove|setowner|reset|restore|setintegritylevel|inheritance)/i;
/** 磁盘设备：/dev/sda、/dev/nvme0n1、/dev/disk2、\\.\PhysicalDrive0、\\.\C: 这类。 */
const DISK_DEVICE = /^(?:\/dev\/(?:sd|hd|vd|xvd|nvme|mmcblk|r?disk|md\d|dm-|mapper\/)|[\\/]{2}[.?][\\/](?:physicaldrive\d|[a-z]:))/i;
/** :(){ :|:& };: 和换了函数名的写法。 */
const FORK_BOMB = /(?:^|[\s;&|(])(?:function\s+)?([\w.:-]+)\s*(?:\(\s*\))?\s*\{\s*\1\s*\|\s*\1\s*&/;

interface IRefusal {
	readonly command: string;
	readonly effect: string;
}

/** 拆出来的一条命令：参数是词，路径按当时的目录解析。 */
interface ICommand {
	readonly text: string;
	readonly name: string;
	readonly args: readonly IWord[];
	readonly directories: Directories;
}

/**
 * 灾难级命令的拒绝原因，见设计文档「直接拒绝的命令」。只看命令的文字：
 * 看不清的（变量拼的路径、写进脚本再执行、命令解析失败）不拒绝，交给审批。directory 是开始执行时的当前目录，看不清时是 undefined。
 */
export async function refusedCommandReason(
	parser: CommandParser, language: CommandLanguage, command: string, directory: string | undefined,
): Promise<string | undefined> {
	const refusal = await check(parser, language, command, directory === undefined ? undefined : [[directory]], 0);
	if (!refusal) return undefined;
	const shown = refusal.command.trim().replace(/\s+/g, ' ');
	return `${clipEnd(shown, SHOWN_CHARS)} ${refusal.effect}，不能由 AI 执行；确有需要时，请用户自行运行`;
}

async function check(parser: CommandParser, syntax: Syntax, commandLine: string, directories: Directories, depth: number): Promise<IRefusal | undefined> {
	if (FORK_BOMB.test(commandLine)) return { command: commandLine, effect: '是 fork 炸弹，会耗尽系统资源' };
	let commands: ICommand[];
	if (syntax === 'bash') {
		const script = await parser.bash(commandLine, directories?.[0]?.at(-1));
		if (!script) return undefined;
		const device = script.redirects.find(redirect => redirect.kind === 'write' && !redirect.target.dynamic && DISK_DEVICE.test(redirect.target.text));
		if (device) return { command: commandLine, effect: `会直接写入磁盘设备 ${device.target.text}` };
		commands = script.commands.map(command => ({ text: command.text, name: command.name.dynamic ? '' : programName(command.name.text), args: command.args, directories: command.directories }));
	} else {
		const texts = syntax === 'cmd' ? splitCmd(commandLine) : await parser.powershellCommands(commandLine);
		commands = (texts ?? []).flatMap(text => {
			const words = stripPrefixes(tokenize(text));
			return words.length ? [{ text, name: programName(words[0]!), args: words.slice(1).map(expandWord), directories }] : [];
		});
	}
	for (const command of commands) {
		const { name, args } = command;
		if (!name) continue;
		const inner = unwrap(syntax, name, args.map(arg => arg.text));
		if (inner) {
			const refusal = depth < MAX_DEPTH ? await check(parser, inner.syntax, inner.command, command.directories, depth + 1) : undefined;
			if (refusal) return refusal;
			continue;
		}
		const texts = args.map(arg => arg.text);
		const effect = targetEffect(deletionTargets(syntax, name, args), command.directories, phrase => `会删除${phrase}`)
			?? targetEffect(permissionTargets(name, args), command.directories, phrase => `会递归修改${phrase}${phrase.endsWith('）') ? '' : ' '}的权限或所有者`)
			?? diskEffect(name, texts) ?? powerEffect(name, texts) ?? bootEffect(name, texts);
		if (effect) return { command: command.text, effect };
	}
	return undefined;
}

/** 按空白拆成词，去掉引号。反斜杠照原样保留：Windows 路径常不加引号。 */
function tokenize(command: string): string[] {
	const words: string[] = [];
	let current = '';
	let quote: string | undefined;
	let started = false;
	for (const char of command) {
		if (quote) {
			if (char === quote) quote = undefined;
			else current += char;
		} else if (char === '"' || char === '\'') {
			quote = char;
			started = true;
		} else if (/\s/.test(char)) {
			if (started) words.push(current);
			current = '';
			started = false;
		} else {
			current += char;
			started = true;
		}
	}
	if (started) words.push(current);
	return words;
}

/** cmd 的命令按 &、&&、|、|| 拆开（引号里的不算）。 */
function splitCmd(commandLine: string): string[] {
	const commands: string[] = [];
	let current = '';
	let quoted = false;
	for (const char of commandLine) {
		if (char === '"') quoted = !quoted;
		if (!quoted && (char === '&' || char === '|')) {
			commands.push(current);
			current = '';
		} else {
			current += char;
		}
	}
	commands.push(current);
	return commands.map(command => command.trim().replace(/^@/, '')).filter(Boolean);
}

/** 去掉命令前面的临时环境变量和 sudo、env 这类前缀。 */
function stripPrefixes(words: readonly string[]): readonly string[] {
	let index = 0;
	while (index < words.length && ASSIGNMENT.test(words[index]!)) index++;
	for (let options = PREFIXES.get(programName(words[index] ?? '')); options; options = PREFIXES.get(programName(words[index] ?? ''))) {
		index++;
		while (index < words.length && (words[index]!.startsWith('-') || ASSIGNMENT.test(words[index]!))) {
			index += options.has(words[index]!) ? 2 : 1;
		}
	}
	return words.slice(index);
}

/** 程序名：去掉路径和 .exe，转小写。和 commandParser 的 commandName 不同，带路径的也认（/usr/bin/rm 是 rm）。 */
function programName(word: string): string {
	return word.split(/[\\/]/).at(-1)!.replace(/\.(exe|com)$/i, '').toLowerCase();
}

/** PowerShell、cmd 的词：展开 ~ 和指向用户目录、系统目录的变量，其余变量看不清。 */
function expandWord(word: string): IWord {
	const home = homedir();
	const systemRoot = process.env['SystemRoot'];
	let text = word.replace(/^~(?=$|[\\/])/, home).replace(/\$\{HOME\}|\$HOME\b|\$env:(USERPROFILE|HOME)\b|%USERPROFILE%/gi, home);
	if (systemRoot) text = text.replace(/\$env:(SystemRoot|windir)\b|%(SystemRoot|windir)%/gi, systemRoot);
	const dynamic = /[$%`]/.test(text);
	return { text, dynamic, prefix: dynamic ? '' : text, glob: /[*?[]/.test(text) };
}

/** cmd /c、powershell -Command 里面的命令；不是 bash 时还有 bash -c（bash 的由解析时取出）。 */
function unwrap(syntax: Syntax, name: string, args: readonly string[]): { syntax: Syntax; command: string } | undefined {
	if (POSIX_SHELLS.has(name) && syntax !== 'bash') {
		const index = args.findIndex(isShellCommandOption);
		return index >= 0 && index + 1 < args.length ? { syntax: 'bash', command: args[index + 1]! } : undefined;
	}
	if (name === 'powershell' || name === 'pwsh') {
		const index = args.findIndex(arg => /^[-/]c(o(m(m(a(n(d)?)?)?)?)?)?$/i.test(arg));
		return index >= 0 ? { syntax: 'powershell', command: joinWords(args.slice(index + 1), '\'') } : undefined;
	}
	if (name === 'cmd') {
		// Git Bash 里要写成 cmd //c。
		const index = args.findIndex(arg => /^\/\/?[ck]$/i.test(arg));
		return index >= 0 ? { syntax: 'cmd', command: joinWords(args.slice(index + 1), '"') } : undefined;
	}
	return undefined;
}

/** 后面的词拼回命令：只有一个词时它就是整条命令（cmd /c "rd /s C:\"），几个词时带空格的加上引号。 */
function joinWords(words: readonly string[], quote: string): string {
	return words.length === 1 ? words[0]! : words.map(word => /\s/.test(word) ? `${quote}${word}${quote}` : word).join(' ');
}

/** 递归删除的目标；不是递归删除时返回 undefined。 */
function deletionTargets(syntax: Syntax, name: string, args: readonly IWord[]): readonly IWord[] | undefined {
	if (name === 'remove-item' || name === 'ri' || (syntax === 'powershell' && REMOVE_ITEM_ALIASES.has(name))) {
		if (!args.some(arg => PWSH_RECURSE.test(arg.text))) return undefined;
		const paths: IWord[] = [];
		for (let index = 0; index < args.length; index++) {
			const arg = args[index]!;
			if (arg.text.startsWith('-')) {
				if (PWSH_VALUE_PARAMETER.test(arg.text)) index++;
			} else {
				paths.push(...arg.text.split(',').filter(Boolean).map(text => ({ ...arg, text })));
			}
		}
		return paths;
	}
	if (name === 'rm') return unixRecursive(args, /^-[a-zA-Z]*[rR][a-zA-Z]*$/) ? operands(args) : undefined;
	// cmd 的 rd /s、del /s。
	if (['rd', 'rmdir', 'del', 'erase'].includes(name)) {
		return args.some(arg => /^\/s$/i.test(arg.text)) ? args.filter(arg => !/^\/[a-z?]$/i.test(arg.text)) : undefined;
	}
	return undefined;
}

/** 递归改权限、所有者的目标。chmod、chown 的第一个参数是权限或所有者，按路径算也不会是要紧的目录，一起检查。 */
function permissionTargets(name: string, args: readonly IWord[]): readonly IWord[] | undefined {
	if (name === 'chmod' || name === 'chown' || name === 'chgrp') {
		return unixRecursive(args, /^-[a-zA-Z]*R[a-zA-Z]*$/) ? operands(args) : undefined;
	}
	const lower = args.map(arg => arg.text.toLowerCase());
	if (name === 'icacls') return lower.includes('/t') && lower.some(arg => ICACLS_CHANGE.test(arg)) && args[0] ? [args[0]] : undefined;
	if (name === 'takeown') {
		const file = lower.indexOf('/f');
		return lower.includes('/r') && file >= 0 && args[file + 1] ? [args[file + 1]!] : undefined;
	}
	return undefined;
}

function unixRecursive(args: readonly IWord[], shortOption: RegExp): boolean {
	const end = args.findIndex(arg => arg.text === '--');
	return (end < 0 ? args : args.slice(0, end)).some(arg => arg.text === '--recursive' || shortOption.test(arg.text));
}

/** 不是选项的参数；-- 之后的都算。 */
function operands(args: readonly IWord[]): IWord[] {
	const end = args.findIndex(arg => arg.text === '--');
	const before = (end < 0 ? args : args.slice(0, end)).filter(arg => !arg.text.startsWith('-'));
	return end < 0 ? before : [...before, ...args.slice(end + 1)];
}

function targetEffect(targets: readonly IWord[] | undefined, directories: Directories, effect: (phrase: string) => string): string | undefined {
	for (const target of targets ?? []) {
		for (const path of resolveTarget(target, directories)) {
			const phrase = criticalPhrase(path);
			if (phrase) return effect(phrase);
		}
	}
	return undefined;
}

/** 目标按当前目录解析成路径（当前目录可能有几种）；带通配符的取通配符前面的目录，看不清的没有路径。 */
function resolveTarget(word: IWord, directories: Directories): string[] {
	if (word.dynamic) return [];
	const text = word.glob ? wildcardBase(word.text) : word.text;
	try {
		if (isAbsolute(text) || /^[a-zA-Z]:[\\/]/.test(text)) return [resolveToolPath(process.cwd(), text)];
		return (directories ?? []).map(stack => resolveToolPath(stack.at(-1)!, text));
	} catch {
		return [];
	}
}

/** 磁盘根目录、用户目录、系统目录，或者它们的上级：返回给人看的说法。 */
function criticalPhrase(path: string): string | undefined {
	if (parse(path).root === path) return `磁盘根目录 ${path}`;
	const home = homedir();
	const systems = systemDirectories();
	if (relative(path, home) === '') return `整个用户目录 ${home}`;
	const system = systems.find(directory => relative(path, directory) === '');
	if (system) return `系统目录 ${system}`;
	if (contains(path, home)) return ` ${path}（其中有用户目录）`;
	const inside = systems.find(directory => contains(path, directory));
	return inside ? ` ${path}（其中有系统目录 ${inside}）` : undefined;
}

function systemDirectories(): string[] {
	if (process.platform === 'win32') {
		const env = process.env;
		const drive = env['SystemDrive'] ?? 'C:';
		return [
			env['SystemRoot'] ?? `${drive}\\Windows`, env['ProgramFiles'] ?? `${drive}\\Program Files`,
			env['ProgramFiles(x86)'] ?? `${drive}\\Program Files (x86)`, env['ProgramData'] ?? `${drive}\\ProgramData`, `${drive}\\Users`,
		];
	}
	return ['/bin', '/boot', '/dev', '/etc', '/lib', '/lib64', '/sbin', '/usr', '/var', '/home', '/Users', '/System', '/Library', '/Applications'];
}

function diskEffect(name: string, args: readonly string[]): string | undefined {
	if (name === 'dd') {
		const target = args.find(arg => /^of=/i.test(arg))?.slice(3);
		return target && DISK_DEVICE.test(target) ? `会直接写入磁盘设备 ${target}` : undefined;
	}
	if (name === 'diskutil') return /^(erase|partition|zero|random|secureerase|reformat)/i.test(args[0] ?? '') ? DISK_EFFECT : undefined;
	if (!DISK_TOOLS.has(name) && !name.startsWith('mkfs.')) return undefined;
	// 只列出分区（fdisk -l、parted -l）不算。
	return args.some(arg => arg === '-l' || arg === '--list') ? undefined : DISK_EFFECT;
}

function powerEffect(name: string, args: readonly string[]): string | undefined {
	// shutdown /a 是取消关机。
	if (POWER_COMMANDS.has(name)) return name === 'shutdown' && args.some(arg => /^[-/]a$/i.test(arg)) ? undefined : POWER_EFFECT;
	if (name === 'systemctl') return args.some(arg => /^(poweroff|reboot|halt|kexec|suspend|hibernate|hybrid-sleep)$/.test(arg)) ? POWER_EFFECT : undefined;
	if (name === 'init' || name === 'telinit') return args.some(arg => arg === '0' || arg === '6') ? POWER_EFFECT : undefined;
	return undefined;
}

function bootEffect(name: string, args: readonly string[]): string | undefined {
	const lower = args.map(arg => arg.toLowerCase());
	if (name === 'bcdedit') return BOOT_EFFECT;
	if ((name === 'vssadmin' || name === 'wbadmin') && lower[0] === 'delete') return BOOT_EFFECT;
	if (name === 'wmic' && lower.includes('shadowcopy') && lower.includes('delete')) return BOOT_EFFECT;
	return undefined;
}
