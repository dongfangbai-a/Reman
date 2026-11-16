/**
 * read_pdf 的子进程：读 PDF、提取文字、需要时渲染页面。放在子进程里，超时或取消时直接结束进程，
 * 损坏或特意构造的 PDF 也不会卡住运行时。参数从命令行传入，结果通过 IPC 发回。
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { errorMessage } from '../../common/errors.ts';

export interface IPdfRequest {
	readonly path: string;
	readonly firstPage: number;
	readonly lastPage: number;
	readonly includeImages: boolean;
}

export type PdfMessage =
	| { readonly type: 'page'; readonly pageNumber: number; readonly text: string; readonly image: Uint8Array | null }
	| { readonly type: 'done'; readonly pageCount: number; readonly lastPage: number }
	| { readonly type: 'error'; readonly message: string };

const MAX_IMAGE_DIMENSION = 2048;
const RENDER_SCALE = 2;

interface IPdfPage {
	getViewport(input: { scale: number }): { width: number; height: number };
	getTextContent(): Promise<{ items: readonly unknown[] }>;
	render(input: Record<string, unknown>): { promise: Promise<void> };
	cleanup(): void;
}

interface IPdfDocument {
	readonly numPages: number;
	getPage(pageNumber: number): Promise<IPdfPage>;
}

interface IPdfLoadingTask {
	readonly promise: Promise<IPdfDocument>;
	destroy(): Promise<void>;
}

class PdfError extends Error { }

async function main(): Promise<void> {
	const request = JSON.parse(process.argv[2] ?? '{}') as IPdfRequest;
	const bytes = readFileSync(request.path);
	if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') throw new PdfError('不是 PDF 文件');

	const require = createRequire(import.meta.url);
	const modulePath = require.resolve('pdfjs-dist/legacy/build/pdf.mjs');
	const root = join(dirname(modulePath), '..', '..');
	const pdfjs = await import(pathToFileURL(modulePath).href) as {
		GlobalWorkerOptions: { workerSrc: string };
		getDocument(input: Record<string, unknown>): IPdfLoadingTask;
	};
	pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(join(root, 'legacy', 'build', 'pdf.worker.mjs')).href;
	const directoryUrl = (name: string) => pathToFileURL(join(root, name) + sep).href;
	const loading = pdfjs.getDocument({
		data: new Uint8Array(bytes), standardFontDataUrl: directoryUrl('standard_fonts'), cMapUrl: directoryUrl('cmaps'), cMapPacked: true,
		wasmUrl: directoryUrl('wasm'), iccUrl: directoryUrl('iccs'), isEvalSupported: false,
	});
	let document: IPdfDocument;
	try {
		document = await loading.promise;
	} catch (error) {
		throw new PdfError((error as { name?: string }).name === 'PasswordException' ? 'PDF 已加密，无法读取' : 'PDF 文件已损坏或格式有误');
	}
	const pageCount = document.numPages;
	if (request.firstPage > pageCount) throw new PdfError(`页码超出范围：该 PDF 共 ${pageCount} 页`);
	const lastPage = Math.min(request.lastPage, pageCount);
	const canvas = request.includeImages ? await import('@napi-rs/canvas') : undefined;
	for (let pageNumber = request.firstPage; pageNumber <= lastPage; pageNumber++) {
		const page = await document.getPage(pageNumber);
		try {
			const text = pageText(await page.getTextContent());
			const image = canvas ? await render(page, canvas) : null;
			await send({ type: 'page', pageNumber, text, image });
		} finally {
			page.cleanup();
		}
	}
	await loading.destroy();
	await send({ type: 'done', pageCount, lastPage });
}

/** 按 PDF.js 给的文字片段拼成文字：有换行标记的换行，相邻片段之间需要时补空格。 */
function pageText(content: { items: readonly unknown[] }): string {
	const items = content.items.flatMap(item => {
		const { str, hasEOL } = item as { str?: unknown; hasEOL?: unknown };
		return typeof str === 'string' ? [{ str: str.replace(/\r\n?/g, '\n'), hasEOL: hasEOL === true }] : [];
	});
	const chunks: string[] = [];
	items.forEach((item, index) => {
		chunks.push(item.str);
		if (item.hasEOL) {
			chunks.push('\n');
			return;
		}
		const next = items.slice(index + 1).find(other => other.str.length > 0)?.str;
		if (item.str && next && !/\s$/u.test(item.str) && !/^\s/u.test(next)) chunks.push(' ');
	});
	return chunks.join('').split('\n').map(line => line.trimEnd()).join('\n').trim();
}

/** 白底渲染成 PNG，长边不超过 2048 像素。 */
async function render(page: IPdfPage, canvasModule: typeof import('@napi-rs/canvas')): Promise<Uint8Array> {
	const base = page.getViewport({ scale: 1 });
	const viewport = page.getViewport({ scale: Math.min(RENDER_SCALE, MAX_IMAGE_DIMENSION / Math.max(base.width, base.height)) });
	const width = Math.max(1, Math.floor(viewport.width));
	const height = Math.max(1, Math.floor(viewport.height));
	const canvas = canvasModule.createCanvas(width, height);
	const context = canvas.getContext('2d');
	context.fillStyle = '#ffffff';
	context.fillRect(0, 0, width, height);
	await page.render({ canvasContext: context, canvas, viewport, background: '#ffffff' }).promise;
	return new Uint8Array(await canvas.encode('png'));
}

function send(message: PdfMessage): Promise<void> {
	return new Promise((resolve, reject) => process.send!(message, undefined, undefined, error => error ? reject(error) : resolve()));
}

main().catch(async (error: unknown) => {
	const message = error instanceof PdfError ? error.message : `读取 PDF 失败：${errorMessage(error)}`;
	await send({ type: 'error', message }).catch(() => undefined);
}).finally(() => process.disconnect());
