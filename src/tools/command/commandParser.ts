import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Language, Node, Parser, Query } from '@vscode/tree-sitter-wasm';
import { resolveToolPath } from '../paths.ts';

type TreeSitterModule = typeof import('@vscode/tree-sitter-wasm');

/** 按哪种 shell 的语法解析命令。 */
export type CommandLanguage = 'bash' | 'powershell';

/** 命令里的一个词。 */
export interface IWord {
	/** 去掉引号、处理转义、合并拼接以后的文字；变量和命令替换保留原文。~ 和 $HOME 换成用户目录。 */
	readonly text: string;
	/** 含有变量或命令替换，值看不清。 */
	readonly dynamic: boolean;
	/** 看不清的部分前面那段文字；dynamic 为 false 时就是整个词。为空时这个词可能展开成选项。 */
	readonly prefix: string;
	/** 含有没加引号的通配符（* ? [ 和 {a,b}）。 */
	readonly glob: boolean;
}

/**
 * 当前目录可能是哪些：cd 可能失败，失败时还在原来的目录，所以是一组。每一项是目录栈，最后一个是当前目录（pushd、popd 用）。
 * undefined 表示看不清。
 */
export type Directories = readonly (readonly string[])[] | undefined;

/** 一个简单命令，套壳（sudo、env、timeout 这类）已经去掉。 */
export interface ISimpleCommand {
	/** 原文，用于说明。 */
	readonly text: string;
	/** 命令前面临时设的环境变量名，包括 env 设的。 */
	readonly assignments: readonly string[];
	/** 去掉的套壳的命令名，如 sudo、xargs。 */
	readonly wrappers: readonly string[];
	readonly name: IWord;
	readonly args: readonly IWord[];
	readonly directories: Directories;
}

/** 重定向读写的文件。 */
interface IRedirect {
	readonly kind: 'read' | 'write';
	readonly target: IWord;
	readonly directories: Directories;
}

interface IBashScript {
	readonly commands: readonly ISimpleCommand[];
	readonly redirects: readonly IRedirect[];
	/** 设置、导出、删除的变量名。 */
	readonly variables: readonly string[];
	/** 看不清的写法：定义函数、bash -c 后面跟着变量这类。 */
	readonly unclear: readonly string[];
	/** 有语法错误。 */
	readonly hasError: boolean;
}

/**
 * 用 tree-sitter 解析命令。bash 解析成结构化的命令（见设计文档「命令的自动判断」）；PowerShell 只拆出子命令的原文。
 * 语法加载失败时解析结果是 undefined，用的地方按看不清处理。
 */
export class CommandParser {
	private readonly parsers: Promise<IParsers | undefined>;

	constructor() {
		this.parsers = loadParsers().catch(error => {
			console.warn('命令解析：tree-sitter 加载失败，所有命令均须审批', error);
			return undefined;
		});
	}

	/** 解析 bash 命令。directory 是开始执行时的当前目录，看不清时为 undefined。 */
	async bash(commandLine: string, directory: string | undefined): Promise<IBashScript | undefined> {
		const parsers = await this.parsers;
		const grammar = parsers?.languages.bash;
		if (!parsers || !grammar) return undefined;
		const walker = new BashWalker(parsers.parser, grammar);
		try {
			walker.script(commandLine, directory === undefined ? undefined : [[directory]], 0);
		} catch (error) {
			console.warn('命令解析：解析命令失败', error);
			return undefined;
		}
		return walker.result();
	}

	/** PowerShell 命令拆成子命令的原文（包括 $(...)、脚本块里的）；解析失败时返回 undefined。 */
	async powershellCommands(commandLine: string): Promise<string[] | undefined> {
		const parsers = await this.parsers;
		const grammar = parsers?.languages.powershell;
		if (!parsers || !grammar) return undefined;
		let query: Query | undefined;
		try {
			parsers.parser.setLanguage(grammar);
			// 语法遇到 --flag=value 会把命令截断，先把 = 换成空格再解析（位置不变），取文字时从原文里截。
			const tree = parsers.parser.parse(commandLine.replace(/(^|\s)(-{1,2}[\w-]+)=/g, (_, before: string, flag: string) => `${before}${flag} `));
			if (!tree) return undefined;
			try {
				if (tree.rootNode.hasError) return undefined;
				query = new parsers.treeSitter.Query(grammar, '(command) @command');
				return query.captures(tree.rootNode).map(capture => commandLine.substring(capture.node.startIndex, capture.node.endIndex));
			} finally {
				tree.delete();
			}
		} catch (error) {
			console.warn('命令解析：解析命令失败', error);
			return undefined;
		} finally {
			query?.delete();
		}
	}
}

interface IParsers {
	readonly treeSitter: TreeSitterModule;
	readonly parser: Parser;
	readonly languages: Partial<Record<CommandLanguage, Language>>;
}

async function loadParsers(): Promise<IParsers> {
	const { default: treeSitter } = await import('@vscode/tree-sitter-wasm') as unknown as { default: TreeSitterModule };
	const directory = dirname(createRequire(import.meta.url).resolve('@vscode/tree-sitter-wasm'));
	await treeSitter.Parser.init({ locateFile: () => join(directory, 'tree-sitter.wasm') });
	const load = async (fileName: string) => treeSitter.Language.load(new Uint8Array(await readFile(join(directory, fileName))));
	// 一种语法加载失败不影响另一种。
	const [bash, powershell] = await Promise.allSettled([load('tree-sitter-bash.wasm'), load('tree-sitter-powershell.wasm')]);
	return {
		treeSitter,
		parser: new treeSitter.Parser(),
		languages: {
			...bash.status === 'fulfilled' ? { bash: bash.value } : {},
			...powershell.status === 'fulfilled' ? { powershell: powershell.value } : {},
		},
	};
}

/** bash -c 里的命令最多再拆几层。 */
const MAX_DEPTH = 3;
/** 当前目录最多记几种可能，再多就算看不清。 */
const MAX_DIRECTORIES = 8;
export const POSIX_SHELLS: ReadonlySet<string> = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const DIRECTORY_COMMANDS: ReadonlySet<string> = new Set(['cd', 'pushd', 'popd']);

/** 执行一段命令以后当前目录的可能：after 是不管成功失败，success 是成功时（&& 后面的命令用）。 */
interface IFlow {
	readonly after: Directories;
	readonly success: Directories;
}

/** 按执行顺序走一遍语法树，拆出简单命令和重定向，同时跟踪当前目录。 */
class BashWalker {
	private readonly parser: Parser;
	private readonly grammar: Language;
	private readonly home = homedir();
	private readonly commands: ISimpleCommand[] = [];
	private readonly redirects: IRedirect[] = [];
	private readonly variables: string[] = [];
	private readonly unclear: string[] = [];
	private hasError = false;

	constructor(parser: Parser, grammar: Language) {
		this.parser = parser;
		this.grammar = grammar;
	}

	result(): IBashScript {
		return { commands: this.commands, redirects: this.redirects, variables: this.variables, unclear: this.unclear, hasError: this.hasError };
	}

	/** 解析一段脚本并走一遍。depth 是套在第几层 bash -c 里。 */
	script(text: string, directories: Directories, depth: number): void {
		this.parser.setLanguage(this.grammar);
		const tree = this.parser.parse(text);
		if (!tree) {
			this.hasError = true;
			return;
		}
		try {
			if (tree.rootNode.hasError) this.hasError = true;
			this.sequence(children(tree.rootNode), directories, depth);
		} finally {
			tree.delete();
		}
	}

	/** 一串语句按顺序执行；后面跟 & 的在后台的子 shell 里执行，不影响当前目录。 */
	private sequence(nodes: readonly Node[], directories: Directories, depth: number): IFlow {
		let flow: IFlow = { after: directories, success: directories };
		for (const node of nodes) {
			if (!node.isNamed || node.type === 'comment') continue;
			const result = this.statement(node, flow.after, depth);
			flow = node.nextSibling?.type === '&' ? { after: flow.after, success: flow.after } : result;
		}
		return flow;
	}

	/**
	 * redirects 是这条语句的重定向。tree-sitter 把 a && b > f、a | b > f 的重定向挂在整个 list、pipeline 上，
	 * bash 里它属于最后一条命令，所以一直往下传给最后一条。
	 */
	private statement(node: Node, directories: Directories, depth: number, redirects: readonly Node[] = []): IFlow {
		const same = { after: directories, success: directories };
		if (node.type === 'redirected_statement') {
			const own = node.childrenForFieldName('redirect').filter(isNode);
			const body = node.childForFieldName('body');
			if (body) return this.statement(body, directories, depth, [...own, ...redirects]);
			for (const redirect of [...own, ...redirects]) this.redirect(redirect, directories, depth);
			return same;
		}
		if (node.type === 'list') {
			const [left, right] = children(node).filter(isStatement);
			const operator = node.children.find(child => child && !child.isNamed)?.type;
			if (!left || !right) {
				this.nested(node, directories, depth);
				for (const redirect of redirects) this.redirect(redirect, directories, depth);
				return { after: undefined, success: undefined };
			}
			const first = this.statement(left, directories, depth);
			const second = this.statement(right, operator === '&&' ? first.success : first.after, depth, redirects);
			return {
				after: union(first.after, second.after),
				success: operator === '&&' ? second.success : union(first.success, second.success),
			};
		}
		if (node.type === 'pipeline') {
			// 管道的每一段都在子 shell 里执行，里面的 cd 不影响外面。
			const parts = children(node).filter(isStatement);
			parts.forEach((part, index) => this.statement(part, directories, depth, index === parts.length - 1 ? redirects : []));
			return same;
		}
		// 重定向在命令执行前、按原来的目录打开文件。
		for (const redirect of redirects) this.redirect(redirect, directories, depth);
		switch (node.type) {
			case 'command':
				return this.command(node, directories, depth);
			case 'subshell':
				// 括号里的命令在子 shell 里执行，里面的 cd 不影响外面。
				this.sequence(children(node), directories, depth);
				return same;
			case 'negated_command':
			case 'compound_statement': {
				const flow = this.sequence(children(node), directories, depth);
				return node.type === 'negated_command' ? { after: flow.after, success: flow.after } : flow;
			}
			case 'if_statement':
			case 'case_statement':
				return this.branches(node, directories, depth);
			case 'for_statement':
			case 'c_style_for_statement':
			case 'while_statement': {
				// 循环体里换目录的，每次进来的目录都不一样，算看不清。
				const changes = node.descendantsOfType('command').some(command => DIRECTORY_COMMANDS.has(command?.childForFieldName('name')?.text ?? ''));
				const inside = changes ? undefined : directories;
				this.nested(node, inside, depth);
				return { after: changes ? undefined : directories, success: changes ? undefined : directories };
			}
			case 'function_definition': {
				this.unclear.push(`定义函数 ${node.childForFieldName('name')?.text ?? ''}`.trim());
				this.nested(node, directories, depth);
				return same;
			}
			case 'variable_assignment':
			case 'variable_assignments':
			case 'declaration_command':
			case 'unset_command':
				this.variables.push(...variableNames(node));
				this.nested(node, directories, depth);
				return same;
			case 'test_command':
				this.nested(node, directories, depth);
				return same;
			default:
				// 语法错误和不认识的写法：拆出里面的命令一起检查，整条判断不了。
				this.hasError = true;
				this.nested(node, directories, depth);
				return { after: undefined, success: undefined };
		}
	}

	/** if、case：条件先执行，之后进哪个分支不知道，结束后的目录是各种可能合在一起。 */
	private branches(node: Node, directories: Directories, depth: number): IFlow {
		const conditions = node.childrenForFieldName(node.type === 'case_statement' ? 'value' : 'condition').filter(isNode);
		for (const value of conditions.filter(child => child.isNamed && !isStatement(child))) this.word(value, directories, depth);
		const condition = this.sequence(conditions.filter(isStatement), directories, depth);
		let after = condition.after;
		const bodies: Node[] = [];
		for (const child of children(node)) {
			if (conditions.some(item => item.id === child.id) || !child.isNamed) continue;
			if (child.type === 'elif_clause' || child.type === 'else_clause' || child.type === 'case_item') {
				const clause = children(child);
				const clauseConditions = child.type === 'elif_clause' ? clause.filter(item => child.childrenForFieldName('condition').some(field => field?.id === item.id)) : [];
				if (child.type === 'case_item') for (const value of child.childrenForFieldName('value')) if (value) this.word(value, condition.after, depth);
				const start = this.sequence(clauseConditions, condition.after, depth);
				const body = this.sequence(clause.filter(item => isStatement(item) && !clauseConditions.includes(item)), start.after, depth);
				after = union(after, union(start.after, body.after));
			} else if (isStatement(child)) {
				bodies.push(child);
			}
		}
		if (bodies.length) after = union(after, this.sequence(bodies, condition.after, depth).after);
		return { after, success: after };
	}

	/** 拆出节点里所有的命令（循环体、条件、词里的命令替换），不跟踪它们对当前目录的影响。 */
	private nested(node: Node, directories: Directories, depth: number): void {
		for (const child of children(node)) {
			if (isStatement(child)) this.statement(child, directories, depth);
			else if (child.type === 'file_redirect' || child.type === 'heredoc_redirect' || child.type === 'herestring_redirect') this.redirect(child, directories, depth);
			else if (child.isNamed) this.word(child, directories, depth);
		}
	}

	private command(node: Node, directories: Directories, depth: number): IFlow {
		const same = { after: directories, success: directories };
		const assignments: string[] = [];
		const args: IWord[] = [];
		let nameWord: IWord | undefined;
		for (let index = 0; index < node.childCount; index++) {
			const child = node.child(index);
			if (!child) continue;
			const field = node.fieldNameForChild(index);
			if (child.type === 'variable_assignment') {
				assignments.push(child.childForFieldName('name')?.text ?? child.text);
				const value = child.childForFieldName('value');
				if (value) this.word(value, directories, depth);
			} else if (field === 'name') {
				nameWord = this.word(child.namedChildren[0] ?? child, directories, depth);
			} else if (field === 'argument') {
				args.push(this.word(child, directories, depth));
			} else if (child.type === 'file_redirect' || child.type === 'herestring_redirect' || child.type === 'heredoc_redirect') {
				this.redirect(child, directories, depth);
			}
		}
		if (!nameWord) return same;
		const unwrapped = unwrap(nameWord, args);
		const command: ISimpleCommand = {
			text: node.text, assignments: [...assignments, ...unwrapped.assignments], wrappers: unwrapped.wrappers,
			name: unwrapped.name, args: unwrapped.args, directories: unwrapped.directory ? changeDirectory(directories, [unwrapped.directory], 'cd', this.home) : directories,
		};
		this.commands.push(command);
		const name = commandName(command.name) ?? '';
		// bash -c '...'：把字符串再解析一遍，里面的 cd 不影响外面。
		if (POSIX_SHELLS.has(name)) {
			const script = shellScript(command.args);
			if (script && !script.dynamic && depth < MAX_DEPTH) this.script(script.text, command.directories, depth + 1);
			else if (script) this.unclear.push(`${name} -c`);
		}
		// 套了 sudo、env 这类的 cd 在别的进程里执行，不影响当前目录；command、builtin、time 还是在这个 shell 里。
		if (!DIRECTORY_COMMANDS.has(name) || command.wrappers.some(item => !IN_SHELL_WRAPPERS.has(item))) return same;
		const changed = changeDirectory(directories, command.args, name, this.home);
		return { after: union(directories, changed), success: changed };
	}

	private redirect(node: Node, directories: Directories, depth: number): void {
		if (node.type !== 'file_redirect') {
			// heredoc、herestring 只是给命令输入内容；里面可能有命令替换，heredoc 后面还可能跟着别的重定向和管道。
			this.nested(node, directories, depth);
			return;
		}
		const operator = node.children.find(child => child && !child.isNamed)?.type ?? '';
		const destination = node.childrenForFieldName('destination').filter(isNode);
		if (!destination.length) return;
		const target = this.concatenate(destination, directories, depth);
		// 复制、关闭文件描述符：>&2、2>&1、<&0、>&-。
		if ((operator === '>&' || operator === '<&') && /^(\d+|-|\d+-)$/.test(target.text) && !target.dynamic) return;
		this.redirects.push({ kind: operator.startsWith('<') && operator !== '<>' ? 'read' : 'write', target, directories });
	}

	/** 词节点转成 IWord；里面的命令替换拆出来按当前目录检查。 */
	private word(node: Node, directories: Directories, depth: number): IWord {
		return this.concatenate([node], directories, depth);
	}

	private concatenate(nodes: readonly Node[], directories: Directories, depth: number): IWord {
		const builder = new WordBuilder();
		for (const node of nodes) this.part(node, builder, directories, depth, false);
		return builder.word();
	}

	private part(node: Node, builder: WordBuilder, directories: Directories, depth: number, quoted: boolean): void {
		switch (node.type) {
			case 'word':
			case 'number':
			case 'extglob_pattern':
				if (quoted) builder.literal(node.text);
				else builder.unquoted(node.text, this.home, builder.empty);
				return;
			case 'string_content':
				builder.literal(unescapeDoubleQuoted(node.text));
				return;
			case 'raw_string':
				builder.literal(node.text.slice(1, -1));
				return;
			case 'ansi_c_string':
				builder.literal(unescapeAnsiC(node.text.slice(2, -1)));
				return;
			case 'string':
			case 'translated_string':
				for (const child of children(node)) if (child.isNamed) this.part(child, builder, directories, depth, true);
				return;
			case 'concatenation':
				for (const child of children(node)) this.part(child, builder, directories, depth, quoted);
				return;
			case 'simple_expansion':
			case 'expansion': {
				// $HOME、${HOME} 换成用户目录，其他变量看不清。
				const named = node.namedChildren.filter(isNode);
				if (named.length === 1 && named[0]!.type === 'variable_name' && named[0]!.text === 'HOME') builder.literal(this.home);
				else builder.dynamic(node.text);
				this.nested(node, directories, depth);
				return;
			}
			case 'command_substitution':
			case 'process_substitution':
				// 在子 shell 里执行，里面的 cd 不影响外面。
				builder.dynamic(node.text);
				this.sequence(children(node), directories, depth);
				return;
			default:
				if (node.isNamed) {
					builder.dynamic(node.text);
					this.nested(node, directories, depth);
				} else {
					builder.literal(node.text);
				}
		}
	}
}

/** 一个词由几段拼起来：记下文字、看不清的部分和通配符。 */
class WordBuilder {
	private text = '';
	private prefix = '';
	private isDynamic = false;
	private isGlob = false;

	get empty(): boolean {
		return !this.text;
	}

	literal(text: string): void {
		this.text += text;
		if (!this.isDynamic) this.prefix += text;
	}

	/** 没加引号的文字：处理反斜杠转义，开头的 ~ 换成用户目录，记下通配符。 */
	unquoted(raw: string, home: string, atStart: boolean): void {
		let text = raw;
		if (atStart && (text === '~' || text.startsWith('~/'))) {
			this.literal(home);
			text = text.slice(1);
		} else if (atStart && text.startsWith('~')) {
			this.dynamic(raw);
			return;
		}
		let result = '';
		for (let index = 0; index < text.length; index++) {
			const char = text[index]!;
			if (char === '\\' && index + 1 < text.length) {
				result += text[++index];
			} else {
				if ('*?[{'.includes(char)) this.isGlob = true;
				result += char;
			}
		}
		this.literal(result);
	}

	dynamic(source: string): void {
		this.text += source;
		this.isDynamic = true;
	}

	word(): IWord {
		return { text: this.text, dynamic: this.isDynamic, prefix: this.isDynamic ? this.prefix : this.text, glob: this.isGlob };
	}
}

/** 双引号里只有 \$ \` \" \\ 和反斜杠换行是转义。 */
function unescapeDoubleQuoted(text: string): string {
	return text.replace(/\\([$`"\\\n])/g, (_, char: string) => char === '\n' ? '' : char);
}

/** $'...' 里常见的转义；其余的照原样。 */
function unescapeAnsiC(text: string): string {
	const escapes: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', '\'': '\'', '"': '"', a: '\x07', b: '\b', e: '\x1b', f: '\f', v: '\v' };
	return text.replace(/\\(x[0-9a-fA-F]{1,2}|[0-7]{1,3}|.)/g, (match, code: string) => {
		if (code.startsWith('x')) return String.fromCharCode(parseInt(code.slice(1), 16));
		if (/^[0-7]+$/.test(code)) return String.fromCharCode(parseInt(code, 8));
		return escapes[code] ?? match;
	});
}

function children(node: Node): Node[] {
	return node.children.filter(isNode);
}

function isNode(node: Node | null): node is Node {
	return node !== null;
}

const STATEMENTS: ReadonlySet<string> = new Set([
	'command', 'redirected_statement', 'list', 'pipeline', 'subshell', 'negated_command', 'compound_statement', 'if_statement', 'case_statement',
	'for_statement', 'c_style_for_statement', 'while_statement', 'function_definition', 'variable_assignment', 'variable_assignments',
	'declaration_command', 'unset_command', 'test_command',
]);

function isStatement(node: Node): boolean {
	return STATEMENTS.has(node.type);
}

function variableNames(node: Node): string[] {
	if (node.type === 'variable_assignment') return [node.childForFieldName('name')?.text ?? node.text];
	return node.namedChildren.flatMap(child => {
		if (child?.type === 'variable_assignment') return [child.childForFieldName('name')?.text ?? child.text];
		if (child?.type === 'variable_name' || (child?.type === 'word' && node.type === 'unset_command')) return [child.text];
		return [];
	});
}

/** cd、pushd、popd 成功以后的目录。cd 不带目标是用户目录；cd -、pushd +1 这类和看不清的目标算看不清。 */
function changeDirectory(directories: Directories, args: readonly IWord[], command: string, home: string): Directories {
	if (!directories) return undefined;
	let index = 0;
	while (index < args.length && !args[index]!.dynamic && /^-[LPe@]+$/.test(args[index]!.text)) index++;
	if (args[index]?.text === '--' && !args[index]!.dynamic) index++;
	const target = args[index];
	if (command === 'popd') return target ? undefined : directories.map(stack => stack.length > 1 ? stack.slice(0, -1) : stack);
	if (!target && command === 'pushd') return undefined;
	if (target && (target.dynamic || target.glob || /^[-+]/.test(target.text))) return undefined;
	const next: (readonly string[])[] = [];
	for (const stack of directories) {
		let path: string;
		try {
			path = target ? resolveToolPath(stack.at(-1)!, target.text) : home;
		} catch {
			return undefined;
		}
		next.push(command === 'pushd' ? [...stack, path] : [...stack.slice(0, -1), path]);
	}
	return next;
}

function union(first: Directories, second: Directories): Directories {
	if (!first || !second) return undefined;
	const result = new Map<string, readonly string[]>();
	for (const stack of [...first, ...second]) result.set(stack.join('\0'), stack);
	return result.size > MAX_DIRECTORIES ? undefined : [...result.values()];
}

/** bash -c 后面的脚本；不是 -c 的写法时返回 undefined。 */
function shellScript(args: readonly IWord[]): IWord | undefined {
	const index = args.findIndex(arg => !arg.dynamic && isShellCommandOption(arg.text));
	return index >= 0 ? args[index + 1] : undefined;
}

/** bash -c、sh -lc 这类后面跟着命令字符串的选项。 */
export function isShellCommandOption(text: string): boolean {
	return /^-[a-z]*c[a-z]*$/i.test(text);
}

/**
 * 带通配符的路径取通配符前面的目录（可能匹配到它下面的任何文件）：a/b?/c 是 a/，/* 是 /，开头就是通配符时是当前目录。
 * 没有通配符时原样返回。
 */
export function wildcardBase(text: string): string {
	const segments = text.split(/[\\/]/);
	const wildcard = segments.findIndex(segment => /[*?[{]/.test(segment));
	return wildcard < 0 ? text : wildcard === 0 ? '.' : `${segments.slice(0, wildcard).join('/')}/`;
}

interface IWrapper {
	/** 不带值的选项。 */
	readonly flags: ReadonlySet<string>;
	/** 带一个值的选项。 */
	readonly values: ReadonlySet<string>;
}

function wrapper(flags: string, values: string): IWrapper {
	return { flags: new Set(flags.split(' ').filter(Boolean)), values: new Set(values.split(' ').filter(Boolean)) };
}

/** 套在命令外面、后面才是真正要执行的命令。 */
const WRAPPERS: ReadonlyMap<string, IWrapper> = new Map([
	['sudo', wrapper('-E -H -n -P -S -A -B --preserve-env --set-home --non-interactive --stdin --askpass --bell', '-u -g -h -p -C -D -r -t -U -T --user --group --host --prompt --close-from --chdir --role --type --other-user --command-timeout')],
	['doas', wrapper('-n', '-u -C')],
	['env', wrapper('-i -0 -v --ignore-environment --null --debug', '-u -C --unset --chdir')],
	['nice', wrapper('', '-n --adjustment')],
	['timeout', wrapper('-v --preserve-status --foreground --verbose', '-k -s --kill-after --signal')],
	['nohup', wrapper('', '')],
	['time', wrapper('-p', '')],
	['command', wrapper('-p', '')],
	['exec', wrapper('', '-a')],
	['builtin', wrapper('', '')],
	['xargs', wrapper('-0 -r -t -x --null --no-run-if-empty --verbose --exit', '-n -L -P -s -d -E -I --max-args --max-lines --max-procs --max-chars --delimiter --eof --replace')],
]);
/** 这些套壳里的命令还在当前 shell 里执行，cd 照样换目录。 */
const IN_SHELL_WRAPPERS: ReadonlySet<string> = new Set(['command', 'builtin', 'time']);

interface IUnwrapped {
	readonly name: IWord;
	readonly args: readonly IWord[];
	readonly wrappers: readonly string[];
	readonly assignments: readonly string[];
	/** env -C、sudo -D 换了目录。 */
	readonly directory?: IWord;
}

/** 去掉 sudo、env、timeout 10、xargs 这类套壳，取出里面的命令。套壳的参数看不懂时不再往里取，套壳本身当成命令。 */
function unwrap(name: IWord, args: readonly IWord[]): IUnwrapped {
	const wrappers: string[] = [];
	const assignments: string[] = [];
	let current = { name, args };
	let directory: IWord | undefined;
	for (;;) {
		const wrapperName = commandName(current.name);
		const spec = wrapperName === undefined ? undefined : WRAPPERS.get(wrapperName);
		if (!spec || !wrapperName) break;
		let index = 0;
		let understood = true;
		let replace: string | undefined;
		while (index < current.args.length) {
			const arg = current.args[index]!;
			const text = arg.text;
			if (arg.dynamic) {
				understood = false;
				break;
			}
			if (text === '--') {
				index++;
				break;
			}
			if (wrapperName === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(text)) {
				assignments.push(text.slice(0, text.indexOf('=')));
				index++;
				continue;
			}
			if (!text.startsWith('-') || text === '-') break;
			const option = text.includes('=') ? text.slice(0, text.indexOf('=')) : text;
			if (!spec.flags.has(option) && !spec.values.has(option) && !(wrapperName === 'nice' && /^-\d+$/.test(text))) {
				understood = false;
				break;
			}
			const value = text.includes('=') ? { ...arg, text: text.slice(text.indexOf('=') + 1), prefix: text.slice(text.indexOf('=') + 1) } : current.args[index + 1];
			// env -C、sudo -D 换目录；xargs -I 把读到的内容替换进参数。
			if ((wrapperName === 'env' && (option === '-C' || option === '--chdir')) || (wrapperName === 'sudo' && (option === '-D' || option === '--chdir'))) directory = value;
			if (wrapperName === 'xargs' && (option === '-I' || option === '--replace')) replace = value?.text;
			index += spec.values.has(option) && !text.includes('=') ? 2 : 1;
		}
		if (!understood) break;
		// timeout 的第一个参数是时长。
		if (wrapperName === 'timeout') index++;
		const inner = current.args.slice(index);
		if (!inner.length) break;
		wrappers.push(wrapperName);
		let innerArgs = inner.slice(1);
		if (wrapperName === 'xargs') {
			// xargs 把读到的内容加在参数后面（-I 时替换进参数里），这些参数看不清。
			const unknown: IWord = { text: 'xargs 读取的内容', dynamic: true, prefix: '', glob: false };
			const marker = replace;
			innerArgs = marker
				? innerArgs.map(arg => arg.text.includes(marker) ? { ...arg, dynamic: true, prefix: arg.dynamic ? arg.prefix : arg.text.slice(0, arg.text.indexOf(marker)) } : arg)
				: [...innerArgs, unknown];
		}
		current = { name: inner[0]!, args: innerArgs };
	}
	return { name: current.name, args: current.args, wrappers, assignments, ...directory && { directory } };
}

/** 命令名：去掉 .exe，Windows 上不区分大小写。带路径的（./build.sh、C:\tools\x.exe）、看不清的返回 undefined。 */
export function commandName(word: IWord): string | undefined {
	if (word.dynamic || /[\\/]/.test(word.text) || !word.text) return undefined;
	const name = word.text.replace(/\.exe$/i, '');
	return process.platform === 'win32' ? name.toLowerCase() : name;
}
