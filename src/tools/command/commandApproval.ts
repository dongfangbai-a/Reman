import { isAbsolute } from 'node:path';
import type { IShell } from '../../shells/shells.ts';
import { contains, isInside, resolveToolPath } from '../paths.ts';
import type { DataProtection } from '../protection.ts';
import { wildcardBase, type CommandLanguage, type CommandParser, type Directories, type IWord } from './commandParser.ts';
import { commandEffects } from './commandRules.ts';

/** 命令的判断结果。 */
interface ICommandCheck {
	/** 审批方式是 auto 时要审批的原因；空的就是放行。 */
	readonly reasons: readonly string[];
	/** 碰到运行时的数据，不管审批方式都要审批的原因。 */
	readonly protectedReasons: readonly string[];
}

interface ICheckOptions {
	/** 命令开始执行时的当前目录；看不清时是 undefined（终端里 cd 过、又没报出目录）。 */
	readonly directory: string | undefined;
	/** 成员的工作目录：写文件只在它里面放行。 */
	readonly workingDirectory: string;
	readonly protection: DataProtection;
}

/** 按哪种语法解析这个 shell 的命令。 */
export function commandLanguage(shell: IShell): CommandLanguage {
	return shell.kind === 'pwsh' || shell.kind === 'powershell' ? 'powershell' : 'bash';
}

/**
 * 判断命令要不要审批，见设计文档「命令的自动判断」。bash 的命令解析成结构化的命令，按清单判断，读写的文件交给路径检查：
 * 写只在工作目录里、又不是受保护的数据时放行，读敏感文件算受保护。PowerShell 的命令都要审批，只按词检查受保护的数据。
 */
export async function checkCommand(parser: CommandParser, shell: IShell, command: string, options: ICheckOptions): Promise<ICommandCheck> {
	const checker = new Checker(options);
	const script = commandLanguage(shell) === 'bash' ? await parser.bash(command, options.directory) : undefined;
	if (!script) {
		checker.reasons.add(commandLanguage(shell) === 'bash' ? '命令无法自动判断' : 'PowerShell 命令均须审批');
		for (const word of commandWords(command)) await checker.touch(textWord(word), options.directory === undefined ? undefined : [[options.directory]]);
		return checker.result();
	}
	if (script.hasError) checker.reasons.add('命令无法自动判断');
	for (const item of script.unclear) checker.reasons.add(`无法解析的写法：${item}`);
	if (script.variables.length) checker.reasons.add(`设置环境变量：${[...new Set(script.variables)].join('、')}`);
	for (const redirect of script.redirects) await checker.access(redirect.kind, redirect.target, redirect.directories);
	for (const item of script.commands) {
		if (item.assignments.length) checker.reasons.add(`临时设置环境变量：${item.assignments.join('、')}`);
		const effects = commandEffects(item);
		for (const effect of effects) {
			if (effect.kind === 'approve') checker.reasons.add(effect.reason);
			else await checker.access(effect.kind, effect.word, item.directories);
		}
		// 要审批的命令不知道哪些参数是路径：每个参数都按路径看，碰到受保护的数据就算受保护的调用。
		if (effects.some(effect => effect.kind === 'approve')) {
			for (const word of [item.name, ...item.args]) {
				await checker.touch(word, item.directories);
				const equals = word.text.indexOf('=');
				if (equals > 0 && !word.dynamic) await checker.touch({ ...word, text: word.text.slice(equals + 1), prefix: word.text.slice(equals + 1) }, item.directories);
			}
		}
	}
	return checker.result();
}

/** 写到这些地方不算写文件。 */
const DEVICES: ReadonlySet<string> = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/stdin', '/dev/tty']);

class Checker {
	readonly reasons = new Set<string>();
	private readonly protectedReasons = new Set<string>();
	private readonly options: ICheckOptions;

	constructor(options: ICheckOptions) {
		this.options = options;
	}

	result(): ICommandCheck {
		return { reasons: [...this.reasons], protectedReasons: [...this.protectedReasons] };
	}

	/** 读写一个文件：看不清的要审批；写到工作目录外的要审批；写受保护的数据、读敏感文件算受保护。 */
	async access(kind: 'read' | 'write' | 'copyFrom', word: IWord, directories: Directories): Promise<void> {
		const paths = resolveWord(word, directories, this.options.workingDirectory, true);
		if (!paths) {
			this.reasons.add(kind === 'write' ? `无法确定写入位置：${word.text}` : `无法确定读取的文件：${word.text}`);
			return;
		}
		for (const path of paths) {
			if (kind !== 'read' && !await isInside(this.options.workingDirectory, path)) {
				this.reasons.add(kind === 'write' ? `写入工作目录以外：${word.text}` : `从工作目录以外复制：${word.text}`);
			}
			const touch = await this.options.protection.touch(path);
			if (touch && (kind === 'write' || touch.kind === 'sensitive')) this.protectedReasons.add(touch.reason);
		}
	}

	/** 不知道读还是写的词：碰到受保护的数据都算。看不清的跳过。 */
	async touch(word: IWord, directories: Directories): Promise<void> {
		for (const path of resolveWord(word, directories, this.options.workingDirectory, false) ?? []) {
			const touch = await this.options.protection.touch(path);
			if (touch) this.protectedReasons.add(touch.reason);
		}
	}
}

/**
 * 词按当前目录解析成路径；当前目录有几种可能就有几个。看不清时返回 undefined：含变量、相对路径又不知道当前目录；
 * 带通配符的取通配符前面的目录，strict 时这个目录在工作目录外也算看不清。
 */
function resolveWord(word: IWord, directories: Directories, workingDirectory: string, strict: boolean): string[] | undefined {
	if (word.dynamic) return undefined;
	let text = word.text;
	if (!text.trim() || DEVICES.has(text)) return [];
	if (word.glob) text = wildcardBase(text);
	let paths: string[];
	try {
		if (isAbsolute(text) || /^[a-zA-Z]:[\\/]/.test(text)) paths = [resolveToolPath(workingDirectory, text)];
		else if (!directories) return undefined;
		else paths = [...new Set(directories.map(stack => resolveToolPath(stack.at(-1)!, text)))];
	} catch {
		return [];
	}
	if (strict && word.glob && paths.some(path => !contains(workingDirectory, path))) return undefined;
	return paths;
}

function textWord(text: string): IWord {
	return { text, dynamic: false, prefix: text, glob: false };
}

/**
 * PowerShell 命令里可能是路径的词：按空白和分隔符拆开，去掉引号；--name=value 也取等号后面的部分。
 * 带通配符的取通配符前面的目录（可能匹配到它下面的任何文件）；含变量的看不出指向哪里，跳过。
 */
export function commandWords(command: string): string[] {
	const words: string[] = [];
	let current = '';
	let quote: string | undefined;
	let quoted = false;
	const finish = () => {
		if (current || quoted) words.push(current);
		current = '';
		quoted = false;
	};
	for (const char of command) {
		if (quote) {
			if (char === quote) quote = undefined;
			else current += char;
		} else if (char === '"' || char === '\'') {
			quote = char;
			quoted = true;
		} else if (/\s/.test(char) || ';|&()<>{}`,'.includes(char)) {
			finish();
		} else {
			current += char;
		}
	}
	finish();
	const result = new Set<string>();
	for (const word of words.flatMap(item => item.includes('=') ? [item, item.slice(item.indexOf('=') + 1)] : [item])) {
		if (word && !/[$%]/.test(word)) result.add(wildcardBase(word));
	}
	return [...result];
}
