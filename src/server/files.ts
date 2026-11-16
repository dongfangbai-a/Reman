import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, isAbsolute } from 'node:path';
import { forbidden, invalid, notFound } from '../common/errors.ts';
import { mimeType } from '../common/mime.ts';
import type { DataProtection } from '../tools/protection.ts';

/** 网页端预览的本机文件的信息。文件夹没有 size、mime。 */
export interface ILocalFileInfo {
	readonly path: string;
	readonly name: string;
	readonly kind: 'file' | 'directory';
	readonly size?: number;
	readonly modifiedAt: number;
	readonly mime?: string;
}

const TEXT = 'text/plain';
/** 认不出的扩展名，看开头这么多字节是不是文字。 */
const SNIFF_BYTES = 8192;

/** 文件的信息：要完整路径；不返回运行时的敏感文件。 */
export async function localFileInfo(protection: DataProtection, path: string): Promise<ILocalFileInfo> {
	checkLocalPath(path);
	await checkNotSensitive(protection, path);
	const stats = await stat(path).catch((error: NodeJS.ErrnoException) => {
		throw error.code === 'ENOENT' || error.code === 'ENOTDIR' ? notFound('文件不存在') : error.code === 'EACCES' || error.code === 'EPERM' ? forbidden('没有权限读取该文件') : error;
	});
	const name = basename(path) || path;
	if (stats.isDirectory()) return { path, name, kind: 'directory', modifiedAt: stats.mtimeMs };
	return { path, name, kind: 'file', size: stats.size, modifiedAt: stats.mtimeMs, mime: mimeType(path) ?? await sniff(path) };
}

/** 网页端给的本机路径（本机文件、Git 仓库）：要完整路径，不接受网络路径。 */
export function checkLocalPath(path: string): void {
	if (!isAbsolute(path)) throw invalid('须为完整路径');
	// Windows 的网络路径：一读就连到那台机器，交出当前用户的登录凭据，而链接可能是模型照着网页写的。
	if (process.platform === 'win32' && /^[\\/]{2}/.test(path)) throw invalid('不支持读取网络路径');
}

/** 运行时的令牌、密钥这些敏感文件不在网页端显示。 */
export async function checkNotSensitive(protection: DataProtection, path: string): Promise<void> {
	const touch = await protection.touch(path);
	if (touch?.kind === 'sensitive') throw forbidden(`${touch.reason.split('：')[0]}，不在网页端显示`);
}

/** 认不出的扩展名：开头没有 NUL、是合法的 UTF-8 就当纯文本。 */
async function sniff(path: string): Promise<string> {
	const file = await open(path, 'r');
	try {
		const buffer = Buffer.alloc(SNIFF_BYTES);
		const { bytesRead } = await file.read(buffer, 0, SNIFF_BYTES, 0);
		const head = buffer.subarray(0, bytesRead);
		if (head.includes(0)) return 'application/octet-stream';
		try {
			// 截在多字节字符中间时最后几个字节不完整，不算错。
			new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: bytesRead === SNIFF_BYTES });
			return TEXT;
		} catch {
			return 'application/octet-stream';
		}
	} finally {
		await file.close();
	}
}

/** 浏览器打开时能执行脚本的类型（XML 里可以写 XHTML 的 script），按纯文本发。 */
const SCRIPTABLE = new Set(['text/html', 'application/xhtml+xml', 'application/xml', 'text/xml']);

/**
 * 发回文件内容时的类型和安全相关的头。文件可能是成员写的，不能在网页端的源里当网页执行，否则能带着用户的 Cookie 调接口：
 * HTML、XML 按纯文本发，SVG 带 CSP sandbox，都带 nosniff。
 */
export function contentHeaders(mime: string): Record<string, string> {
	const type = SCRIPTABLE.has(mime) ? TEXT : mime;
	return {
		'Content-Type': type.startsWith('text/') || type === 'application/json' ? `${type}; charset=utf-8` : type,
		'X-Content-Type-Options': 'nosniff',
		...type === 'image/svg+xml' ? { 'Content-Security-Policy': 'sandbox' } : {},
	};
}

/** 发回本机文件的内容，支持单个 Range（拖进度、只取开头）。 */
export function sendLocalFile(request: IncomingMessage, response: ServerResponse, info: ILocalFileInfo, download: boolean): void {
	if (info.kind !== 'file') throw invalid('该路径是文件夹');
	const size = info.size!;
	const headers: Record<string, string> = {
		...contentHeaders(info.mime!),
		'Cache-Control': 'no-cache',
		'Accept-Ranges': 'bytes',
		'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(info.name)}`,
	};
	const range = parseRange(request.headers.range, size);
	if (range === null) {
		response.writeHead(416, { 'Content-Range': `bytes */${size}` });
		response.end();
		return;
	}
	const [start, end] = range ?? [0, size - 1];
	response.writeHead(range ? 206 : 200, { ...headers, 'Content-Length': String(Math.max(0, end - start + 1)), ...range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {} });
	if (size === 0) {
		response.end();
		return;
	}
	const stream = createReadStream(info.path, { start, end });
	stream.on('error', () => response.destroy());
	stream.pipe(response);
}

/** 单个 bytes 范围；没给时是 undefined，给错了（不满足）时是 null。多个范围按没给处理。 */
function parseRange(header: string | undefined, size: number): [number, number] | null | undefined {
	const match = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null;
	if (!match || (!match[1] && !match[2])) return undefined;
	let start: number;
	let end: number;
	if (!match[1]) {
		start = Math.max(0, size - Number(match[2]));
		end = size - 1;
	} else {
		start = Number(match[1]);
		end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
	}
	return start >= size || start > end ? null : [start, end];
}
