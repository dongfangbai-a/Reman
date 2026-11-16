import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import { invalid } from '../../common/errors.ts';
import { contains, isInside, resolveToolPath } from '../paths.ts';
import type { DataProtection } from '../protection.ts';
import type { IBuiltinToolGroup, ITool, IToolContext } from '../tools.ts';
import { formatWarning } from './formatCheck.ts';

/** 写文件和改文件在设置里是一项，成员文件的 tools 里写这个名字。 */
export const FILES_GROUP = 'files';

const PATH_HINT = '路径可以是相对于工作目录的相对路径，也可以是绝对路径。';

/** 一处替换。 */
interface IEdit {
	readonly oldText: string;
	readonly newText: string;
	readonly replaceAll: boolean;
}

/**
 * 写文件和改文件：内容和原文都原样放在参数里，不用 diff 的前缀格式。每次调用一个文件，读当前内容、改、写回，同步执行，中间不让出：
 * 运行时只有一个进程，不同成员对同一个文件的修改一个接一个，后到的在前一次改完的内容上找原文。
 */
export function createFileTools(protection: DataProtection): IBuiltinToolGroup {
	const shared = {
		group: FILES_GROUP,
		defaultPolicy: 'auto',
		autoPolicy: { label: '工作目录外须审批', description: '仅修改工作目录中的文件时直接执行，修改工作目录以外的文件须审批' },
		needsApproval: async (context: IToolContext, args: Record<string, unknown>) => {
			const path = targetPath(context, args);
			return await isInside(context.workingDirectory, path) ? undefined : `工作目录以外：${path}`;
		},
		protectedReasons: async (context: IToolContext, args: Record<string, unknown>) => {
			const touch = await protection.touch(targetPath(context, args));
			return touch ? [touch.reason] : [];
		},
	} as const;

	const writeFile: ITool<string> = {
		...shared,
		name: 'write_file',
		label: '写入文件',
		description: `新建文本文件，或整体替换已有文件的内容。内容按原样写入；上级文件夹不存在时自动创建，无需事先创建。文件已存在时，仅在 overwrite 为 true 时替换。${PATH_HINT}`,
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string', description: '文件路径' },
				content: { type: 'string', description: '文件的全部内容' },
				overwrite: { type: 'boolean', description: '为 true 时替换已存在的文件' },
			},
			required: ['path', 'content'],
			additionalProperties: false,
		},
		execute(context, args) {
			const path = targetPath(context, args);
			const content = args['content'];
			if (typeof content !== 'string') throw invalid('content 必须是字符串');
			if (args['overwrite'] !== undefined && typeof args['overwrite'] !== 'boolean') throw invalid('overwrite 必须是 true 或 false');
			const shown = display(context.workingDirectory, path);
			if (!existsSync(path)) {
				mkdirSync(dirname(path), { recursive: true });
				writeFileSync(path, content, { flag: 'wx' });
				return `已新建 ${shown}，${lineCount(content)} 行${formatWarning(path, content)}`;
			}
			if (args['overwrite'] !== true) throw invalid(`文件已存在：${shown}。如需整体替换，将 overwrite 设为 true`);
			const original = readText(path);
			const written = bomOf(original) + (usesCrlf(original) ? content.replace(/\r?\n/g, '\r\n') : content);
			writeFileSync(path, written);
			return `已覆盖 ${shown}，原有 ${lineCount(original)} 行，现有 ${lineCount(content)} 行${formatWarning(path, written)}`;
		},
	};

	const editFile: ITool<string> = {
		...shared,
		name: 'edit_file',
		label: '修改文件',
		description: [
			'修改文本文件：将文件中的原文替换为新文本，一次可修改多处。',
			'每处的原文须与文件内容一致，且在文件中只出现一次；不唯一时，多带几行上下文；需要全部替换时，设置 replace_all。',
			`多处按顺序修改，后一处在前一处修改后的内容中查找；任一处失败则全部不修改。${PATH_HINT}`,
		].join(''),
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string', description: '文件路径' },
				edits: {
					type: 'array',
					minItems: 1,
					description: '要修改的各处',
					items: {
						type: 'object',
						properties: {
							old_text: { type: 'string', description: '要替换的原文' },
							new_text: { type: 'string', description: '替换后的新文本；删除时为空' },
							replace_all: { type: 'boolean', description: '为 true 时替换所有匹配之处' },
						},
						required: ['old_text', 'new_text'],
						additionalProperties: false,
					},
				},
			},
			required: ['path', 'edits'],
			additionalProperties: false,
		},
		execute(context, args) {
			const path = targetPath(context, args);
			const edits = parseEdits(args['edits']);
			const shown = display(context.workingDirectory, path);
			if (!existsSync(path)) throw invalid(`文件不存在：${shown}。新建文件请使用 write_file`);
			const original = readText(path);
			const bom = bomOf(original);
			const { text, count } = applyEdits(original.slice(bom.length), edits, usesCrlf(original) ? '\r\n' : '\n');
			writeFileSync(path, bom + text);
			return `已修改 ${shown}，${count} 处${formatWarning(path, text)}`;
		},
	};

	return { name: FILES_GROUP, label: '修改文件', description: '新建、整体替换和修改文本文件', tools: [writeFile, editFile] };
}

function targetPath(context: IToolContext, args: Record<string, unknown>): string {
	const path = args['path'];
	if (typeof path !== 'string') throw invalid('path 必须是字符串');
	return resolveToolPath(context.workingDirectory, path);
}

function parseEdits(value: unknown): IEdit[] {
	if (!Array.isArray(value) || value.length === 0) throw invalid('edits 必须是非空数组');
	return value.map((item, index) => {
		const where = value.length > 1 ? `第 ${index + 1} 处的 ` : '';
		const record = typeof item === 'object' && item !== null ? item as Record<string, unknown> : {};
		const { old_text: oldText, new_text: newText, replace_all: replaceAll } = record;
		if (typeof oldText !== 'string' || !oldText) throw invalid(`${where}old_text 必须是非空字符串`);
		if (typeof newText !== 'string') throw invalid(`${where}new_text 必须是字符串`);
		if (replaceAll !== undefined && typeof replaceAll !== 'boolean') throw invalid(`${where}replace_all 必须是 true 或 false`);
		return { oldText: oldText.replace(/\r\n/g, '\n'), newText: newText.replace(/\r\n/g, '\n'), replaceAll: replaceAll === true };
	});
}

/**
 * 按顺序替换，返回新内容和一共替换了几处。有一处不行就报错，什么都不改。
 * 原文和新文的换行换成文件用的 eol 再找、再写；文件里换行混用时，用别的换行的行只在宽松查找时找得到，其他行原样不动。
 */
function applyEdits(text: string, edits: readonly IEdit[], eol: string): { text: string; count: number } {
	let current = text;
	let count = 0;
	edits.forEach((edit, index) => {
		const where = edits.length > 1 ? `第 ${index + 1} 处：` : '';
		let ranges = exactRanges(current, edit.oldText.replace(/\n/g, eol));
		if (ranges.length === 0) ranges = looseRanges(current, edit.oldText);
		if (ranges.length === 0) throw invalid(`${where}文件中未找到原文`);
		if (ranges.length > 1 && !edit.replaceAll) {
			throw invalid(`${where}原文在文件中出现了 ${ranges.length} 处。请多带几行上下文使其唯一，或设置 replace_all 全部替换`);
		}
		const newText = edit.newText.replace(/\n/g, eol);
		for (const [start, end] of ranges.reverse()) current = current.slice(0, start) + newText + current.slice(end);
		count += ranges.length;
	});
	return { text: current, count };
}

function exactRanges(text: string, search: string): [number, number][] {
	const ranges: [number, number][] = [];
	for (let index = text.indexOf(search); index >= 0; index = text.indexOf(search, index + search.length)) ranges.push([index, index + search.length]);
	return ranges;
}

/** 忽略每行行尾的空格和制表符再找，换行是 LF 还是 CRLF 都行：行尾空白在命令的输出里看不出来，照着输出抄的原文常常少了它。 */
function looseRanges(text: string, search: string): [number, number][] {
	if (!search.includes('\n')) return [];
	const lines = search.split('\n');
	const pattern = lines.map((line, index) => escapeRegExp(index < lines.length - 1 ? line.replace(/[ \t]+$/, '') : line)).join('[ \\t]*\\r?\\n');
	return [...text.matchAll(new RegExp(pattern, 'g'))].map(match => [match.index, match.index + match[0].length]);
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readText(path: string): string {
	if (!statSync(path).isFile()) throw invalid('不是文件');
	const content = readFileSync(path);
	if (content.includes(0)) throw invalid('该文件为二进制文件，只能写入和修改文本文件');
	return content.toString('utf8');
}

/** 文件开头的 BOM，写回时保留；没有时是空字符串。 */
function bomOf(text: string): string {
	return text.charCodeAt(0) === 0xFEFF ? text[0]! : '';
}

/** 按第一个换行判断文件用不用 CRLF。 */
function usesCrlf(text: string): boolean {
	const index = text.indexOf('\n');
	return index > 0 && text[index - 1] === '\r';
}

function lineCount(text: string): number {
	if (!text) return 0;
	return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

function display(workingDirectory: string, path: string): string {
	return contains(workingDirectory, path) ? relative(workingDirectory, path) || '.' : path;
}
