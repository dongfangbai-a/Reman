/**
 * 写入之后的格式检查：按后缀判断结构化文件是否还能被解析，解析不了就把错误附在工具结果后面。
 *
 * 为什么放在工具里：文件后缀是确定的，校验是确定性的，所以不依赖模型是否记得自查——它写坏了，
 * 下一条工具结果里就会看到「这不是合法的 JSON，第几行第几列」，下一轮改一行就行。
 * 这也顺着工具调用链自然生效：直接调 write_file、经 run_tool_script 调 write_file，结果是一样的。
 *
 * 只查「能不能解析」，不查「内容是否符合任务要求」——后者没法在这里判断。
 */
import { parse as parseYaml } from 'yaml';

/** 一个后缀对应的一项检查。limit 是跳过校验的大小，按解析代价定：YAML 比 JSON 慢一到两个数量级。 */
interface IFormatCheck {
	readonly extensions: readonly string[];
	readonly kind: string;
	readonly limit: number;
	/** 合法时返回 undefined，不合法时返回原因（尽量带位置）。 */
	readonly inspect: (content: string) => string | undefined;
}

const MEGABYTE = 1024 * 1024;

/** 报错里只留这么长，避免库把整段上下文都塞进模型上下文。 */
const MAX_REASON = 200;

/** JSON.parse 的报错已经带位置（`at position 3463 (line 60 column 96)`），原样留下最好用。 */
function inspectJson(content: string): string | undefined {
	try {
		JSON.parse(content);
		return undefined;
	} catch (error) {
		return (error as Error).message.replace(/^SyntaxError:\s*/, '').replace(/\s*is not valid JSON\s*$/i, '');
	}
}

/** JSONL：逐行 parse，报出第一个坏掉的行号。空行按惯例跳过。 */
function inspectJsonLines(content: string): string | undefined {
	const lines = content.split(/\r?\n/);
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? '';
		if (line.trim() === '') continue;
		try {
			JSON.parse(line);
		} catch (error) {
			const reason = (error as Error).message.replace(/^SyntaxError:\s*/, '');
			return `第 ${index + 1} 行：${reason}`;
		}
	}
	return undefined;
}

/** YAML：yaml 库的报错自带 linePos，拼成「第几行第几列」更直观。 */
function inspectYaml(content: string): string | undefined {
	try {
		parseYaml(content);
		return undefined;
	} catch (error) {
		const failure = error as Error & { linePos?: readonly { line: number; col: number }[] };
		const position = failure.linePos?.[0];
		const message = failure.message.replace(/\s*at line \d+, column \d+.*/s, '').trim();
		return position ? `${message}（第 ${position.line} 行第 ${position.col} 列）` : message;
	}
}

/** 保留 BOM 的文件（覆盖写时会把原文件的 BOM 加回去）不算内容的一部分。 */
function stripBom(content: string): string {
	return content.charCodeAt(0) === 0xFEFF ? content.slice(1) : content;
}

const CHECKS: readonly IFormatCheck[] = [
	{ extensions: ['.json'], kind: 'JSON', limit: 64 * MEGABYTE, inspect: inspectJson },
	{ extensions: ['.jsonl', '.ndjson'], kind: 'JSONL', limit: 64 * MEGABYTE, inspect: inspectJsonLines },
	{ extensions: ['.yaml', '.yml'], kind: 'YAML', limit: 8 * MEGABYTE, inspect: inspectYaml },
];

/**
 * 检查刚写好的内容。返回要追加到工具结果末尾的提示，合法或不需要检查时返回空字符串。
 * @param path 文件路径，只看后缀
 * @param content 写入后的完整内容
 */
export function formatWarning(path: string, content: string): string {
	const dot = path.lastIndexOf('.');
	if (dot < 0) return '';
	const extension = path.slice(dot).toLowerCase();
	const check = CHECKS.find(item => item.extensions.includes(extension));
	if (!check) return '';
	// 空内容当成占位（先建文件、后面再写），不报：真正写坏的情况不会长这样。
	if (content.trim() === '') return '';
	// 大文件跳过：解析本身不慢，但会在主线程上占住内存和事件循环，写一次几 MB 以上本身就少见。
	if (content.length > check.limit) return '';
	const reason = check.inspect(stripBom(content));
	if (reason === undefined) return '';
	const shown = reason.length > MAX_REASON ? `${reason.slice(0, MAX_REASON)}…` : reason;
	return `\n⚠️ 不是合法的 ${check.kind}：${shown}。`;
}
