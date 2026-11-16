import { fork } from 'node:child_process';
import { statSync, type Stats } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { invalid } from '../../common/errors.ts';
import type { IInputImage, IToolImage, Resources } from '../../resources/resources.ts';
import { resolveToolPath } from '../paths.ts';
import type { DataProtection } from '../protection.ts';
import type { ITool, IToolText } from '../tools.ts';
import type { IPdfRequest, PdfMessage } from './readPdfChild.ts';

const CHILD_PATH = fileURLToPath(new URL('./readPdfChild.ts', import.meta.url));
const MAX_PAGES = 5;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const TIMEOUT_MS = 2 * 60 * 1000;
/** 一次返回的文字最多多少字，超出的截掉并说明。 */
const MAX_TEXT_CHARS = 25_000;

/** 读到的几页：nextPage 是还没读的下一页，读完了是 null。 */
export interface IPdfResult {
	readonly path: string;
	readonly pageCount: number;
	readonly pages: readonly { readonly page: number; readonly text: string; readonly image?: IToolImage }[];
	readonly nextPage: number | null;
}

/** 读本地 PDF 的文字，需要时带上页面渲染图。 */
export function createReadPdfTool(resources: Resources, protection: DataProtection): ITool<IPdfResult> {
	return {
		name: 'read_pdf',
		label: '读取 PDF',
		progressive: true,
		description: [
			`读取本地 PDF 的文字，每次最多读取 ${MAX_PAGES} 页。`,
			'提取的文字可能不准确：涉及表格、图表、公式或版式，或文字显得混乱、有缺失时，传入 include_images: true，同时查看每页的渲染图。',
		].join('\n'),
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'PDF 路径，相对路径以工作目录为基准' },
				first_page: { type: 'integer', minimum: 1, description: '起始页码，默认 1' },
				last_page: { type: 'integer', minimum: 1, description: `结束页码，默认为从 first_page 起共 ${MAX_PAGES} 页` },
				include_images: { type: 'boolean', description: '是否同时返回每页的渲染图，默认 false' },
			},
			required: ['path'],
			additionalProperties: false,
		},
		returns: '{ path: string; pageCount: number; pages: { page: number; text: string; image?: InputImage }[]; nextPage: number | null }',
		defaultPolicy: 'allow',
		protectedReasons: (context, args) => protection.readReasons([pdfPath(context.workingDirectory, args['path'])]),
		async execute(context, args) {
			const absolute = pdfPath(context.workingDirectory, args['path']);
			const firstPage = args['first_page'] ?? 1;
			if (typeof firstPage !== 'number' || !Number.isInteger(firstPage) || firstPage < 1) throw invalid('first_page 必须是正整数');
			const lastPage = args['last_page'] ?? firstPage + MAX_PAGES - 1;
			if (typeof lastPage !== 'number' || !Number.isInteger(lastPage) || lastPage < firstPage) throw invalid('last_page 必须是不小于 first_page 的整数');
			if (lastPage - firstPage + 1 > MAX_PAGES) throw invalid(`每次最多读取 ${MAX_PAGES} 页`);
			const includeImages = args['include_images'] ?? false;
			if (typeof includeImages !== 'boolean') throw invalid('include_images 必须是 true 或 false');
			let stat: Stats;
			try {
				stat = statSync(absolute);
			} catch {
				throw invalid(`文件不存在：${absolute}`);
			}
			if (!stat.isFile()) throw invalid(`${absolute} 不是文件`);
			if (stat.size > MAX_FILE_BYTES) throw invalid(`PDF 过大，最大 ${MAX_FILE_BYTES / 1024 / 1024} MB`);
			const messages = await runChild({ path: absolute, firstPage, lastPage, includeImages }, context.signal);
			return toResult(absolute, messages, resources);
		},
		format: formatResult,
	};
}

/** PDF 的绝对路径，相对路径从工作目录算起。 */
function pdfPath(workingDirectory: string, path: unknown): string {
	if (typeof path !== 'string' || !path.trim()) throw invalid('path 不能为空');
	return resolveToolPath(workingDirectory, path);
}

/** 在子进程里读 PDF，收齐它发回的消息。超时或取消时结束子进程。 */
function runChild(request: IPdfRequest, signal: AbortSignal): Promise<PdfMessage[]> {
	signal.throwIfAborted();
	return new Promise((resolvePromise, reject) => {
		const child = fork(CHILD_PATH, [JSON.stringify(request)], { serialization: 'advanced', stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
		const messages: PdfMessage[] = [];
		let stderr = '';
		let failure: Error | undefined;
		const stop = (error: Error) => {
			failure ??= error;
			child.kill();
		};
		const timer = setTimeout(() => stop(invalid(`读取超过 ${TIMEOUT_MS / 1000} 秒，已停止`)), TIMEOUT_MS);
		const onAbort = () => stop(signal.reason instanceof Error ? signal.reason : new Error('已取消'));
		signal.addEventListener('abort', onAbort, { once: true });
		child.stderr?.on('data', (chunk: Buffer) => stderr = (stderr + chunk.toString()).slice(-2000));
		child.on('message', message => messages.push(message as PdfMessage));
		child.on('error', error => stop(error));
		child.on('exit', () => {
			clearTimeout(timer);
			signal.removeEventListener('abort', onAbort);
			if (failure) return reject(failure);
			const error = messages.find(message => message.type === 'error');
			if (error) return reject(invalid(error.message));
			if (!messages.some(message => message.type === 'done')) return reject(new Error(`读取 PDF 的进程异常退出：${stderr.trim()}`));
			resolvePromise(messages);
		});
	});
}

/** 子进程发回的消息整理成结果，渲染图存成资源。 */
function toResult(path: string, messages: readonly PdfMessage[], resources: Resources): IPdfResult {
	const done = messages.find(message => message.type === 'done')!;
	const pages = messages.filter(message => message.type === 'page').map(page => ({
		page: page.pageNumber, text: page.text, ...page.image && { image: resources.toolImage(Buffer.from(page.image), `${path} 第 ${page.pageNumber} 页`) },
	}));
	return { path, pageCount: done.pageCount, pages, nextPage: done.lastPage < done.pageCount ? done.lastPage + 1 : null };
}

/** 直接调用时的文字：每页一段，渲染图按顺序跟在后面；文字太长时截掉后面的。 */
function formatResult(result: IPdfResult): IToolText {
	const images: IInputImage[] = [];
	const parts = result.pages.map(page => {
		if (page.image) images.push(page.image);
		const text = page.text || '（本页未提取到文字，可能是扫描件或图片，可传入 include_images: true 查看渲染图）';
		return `--- 第 ${page.page} 页${page.image ? `（渲染图为第 ${images.length} 张）` : ''} ---\n${text}`;
	});
	const first = result.pages[0]?.page ?? 0;
	const last = result.pages.at(-1)?.page ?? 0;
	let text = [`${result.path}：共 ${result.pageCount} 页，本次读取第 ${first}–${last} 页。`, ...parts].join('\n\n');
	if (text.length > MAX_TEXT_CHARS) text = `${text.slice(0, MAX_TEXT_CHARS)}\n\n……（文字过长，其后截去 ${text.length - MAX_TEXT_CHARS} 字，可减少每次读取的页数）`;
	if (result.nextPage !== null) text += `\n\n后续还有内容，继续读取请传入 first_page: ${result.nextPage}。`;
	return { text, images };
}
