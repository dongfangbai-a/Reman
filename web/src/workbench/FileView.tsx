import { keepPreviousData, useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Code, Download, Eye, FileText, RotateCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client.ts';
import type { ILocalFileInfo } from '../api/types.ts';
import { Markdown } from '../chat/Markdown.tsx';
import { formatSize, shortTime } from '../lib/format.ts';
import { highlight } from '../lib/highlight.ts';
import { IconButton } from '../ui/Button.tsx';
import { CenteredMessage } from '../ui/CenteredMessage.tsx';
import { fileContentUrl } from './FileLink.tsx';
import { directoryOf } from './paths.ts';
import { fileViewState, reloadFile, saveFileViewState, useFileReloads } from './tabs.ts';

/** 文本最多显示开头这么多字节，超出的可以下载看全部。 */
const MAX_TEXT_BYTES = 1024 * 1024;
/** 超过这么多字的文本不高亮：太慢。 */
const MAX_HIGHLIGHT_CHARS = 200_000;
/** 回到标签时等内容长到上次的位置，最多等这么久；还不够长（文件变短了）就停在最后。 */
const RESTORE_TIMEOUT_MS = 10_000;
/** 这些事说明使用者自己在滚，不再替他滚回上次的位置。 */
const USER_SCROLL_EVENTS = ['wheel', 'pointerdown', 'keydown', 'touchstart'] as const;

/** 工作台里预览的一个文件：第二行是路径、大小、修改时间和操作，下面按类型显示内容。 */
export function FileView({ path }: { path: string }) {
	const reloads = useFileReloads(state => state[path] ?? 0);
	// 切到这个标签（重新挂上）、点了链接或刷新时重新读；读的时候先显示原来的，不闪。
	const info = useQuery({
		queryKey: ['file', path, reloads],
		queryFn: () => api<ILocalFileInfo>('GET', `/v1/files?path=${encodeURIComponent(path)}`),
		staleTime: 0,
		retry: false,
		placeholderData: keepPreviousData,
	});
	const [source, setSource] = useState(() => fileViewState(path).source);
	const toggleSource = () => {
		setSource(!source);
		saveFileViewState(path, { source: !source });
	};
	const scroll = useRememberedScroll(path);
	const file = info.data;
	const renderable = file?.mime === 'text/markdown' || file?.mime === 'text/html';
	const directory = directoryOf(path);
	return (
		<>
			<div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-line bg-pane px-3 py-1.5 text-xs">
				<div className="flex min-w-48 flex-1 items-center gap-1.5 text-fg-2" title={path}>
					<FileText size={14} className="shrink-0 text-fg-3" />
					{/* 太长时截掉目录，留着文件名。 */}
					<span className="min-w-0 truncate font-mono text-[11px] text-fg-3">{path.slice(0, directory.length)}</span>
					<span className="-ml-1.5 shrink-0 font-mono text-[11px]">{path.slice(directory.length)}</span>
					{file?.kind === 'file' && <span className="shrink-0 text-fg-3">· {formatSize(file.size!)} · {shortTime(file.modifiedAt)}</span>}
				</div>
				<div className="flex shrink-0 items-center gap-0.5">
					{renderable && (
						<IconButton label={source ? '显示渲染结果' : '源码'} className="size-6" onClick={toggleSource}>
							{source ? <Eye size={14} /> : <Code size={14} />}
						</IconButton>
					)}
					<IconButton label="刷新" className="size-6" onClick={() => reloadFile(path)}><RotateCw size={14} /></IconButton>
					{file?.kind === 'file' && (
						<a href={fileContentUrl(path, { download: true })} aria-label="下载" title="下载" className="flex size-6 items-center justify-center rounded-md text-fg-2 hover:bg-hover hover:text-fg">
							<Download size={14} />
						</a>
					)}
				</div>
			</div>
			<div ref={scroll.ref} onScroll={scroll.onScroll} className="min-h-0 flex-1 overflow-auto">
				{info.isError && <CenteredMessage title={info.error.message} />}
				{/* 文件变了也不换掉整块：读到新内容前先显示原来的，看到的位置不被挤回开头。 */}
				{file && <FileContent file={file} source={source} />}
			</div>
		</>
	);
}

/**
 * 记住这个文件看到的位置。回来时内容可能晚一点才出来（缓存过期了要重新取，代码高亮也要一会儿）：
 * 等内容长到那个位置再滚过去，这期间使用者自己滚了就不再滚；替他滚的时候不记。
 */
function useRememberedScroll(path: string) {
	const ref = useRef<HTMLDivElement>(null);
	const restoring = useRef(false);
	useEffect(() => {
		const element = ref.current;
		const target = fileViewState(path).scrollTop;
		if (!element || target <= 0) return;
		restoring.current = true;
		const started = performance.now();
		let frame = 0;
		const stop = () => {
			restoring.current = false;
			cancelAnimationFrame(frame);
			for (const type of USER_SCROLL_EVENTS) element.removeEventListener(type, stop);
		};
		const step = () => {
			const max = element.scrollHeight - element.clientHeight;
			element.scrollTop = Math.min(target, max);
			if (max >= target || performance.now() - started > RESTORE_TIMEOUT_MS) stop();
			else frame = requestAnimationFrame(step);
		};
		for (const type of USER_SCROLL_EVENTS) element.addEventListener(type, stop, { passive: true });
		step();
		return stop;
	}, [path]);
	const onScroll = () => {
		if (!restoring.current && ref.current) saveFileViewState(path, { scrollTop: ref.current.scrollTop });
	};
	return { ref, onScroll };
}

function FileContent({ file, source }: { file: ILocalFileInfo; source: boolean }) {
	const [failedUrl, setFailedUrl] = useState<string>();
	if (file.kind === 'directory') return <CenteredMessage title="该路径是文件夹" />;
	const mime = file.mime!;
	const url = fileContentUrl(file.path, { version: file.modifiedAt });
	const setFailed = () => setFailedUrl(url);
	if (failedUrl === url) return <CenteredMessage title="浏览器无法播放该格式" detail="可下载后使用其他程序打开" />;
	if (mime.startsWith('image/')) return <ImageView url={url} name={file.name} />;
	if (mime === 'application/pdf') return <iframe src={url} title={file.name} className="size-full" />;
	if (mime.startsWith('audio/')) return <div className="p-4"><audio controls src={url} onError={setFailed} className="w-full" /></div>;
	if (mime.startsWith('video/')) return <div className="flex h-full items-center justify-center bg-black"><video controls src={url} onError={setFailed} className="max-h-full max-w-full" /></div>;
	if (mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml') return <TextFile file={file} source={source} />;
	return <CenteredMessage title={file.name} detail={`${formatSize(file.size!)} · ${mime} · 无法预览，可下载`} />;
}

/** 图片放不下时缩小到放得下，点击看原尺寸。 */
function ImageView({ url, name }: { url: string; name: string }) {
	const [natural, setNatural] = useState(false);
	return (
		<div className={clsx('flex min-h-full p-3', !natural && 'items-center justify-center')}>
			<img src={url} alt={name} onClick={() => setNatural(value => !value)} className={clsx(natural ? 'max-w-none cursor-zoom-out' : 'max-h-full max-w-full cursor-zoom-in')} />
		</div>
	);
}

/** 文本类文件：只读开头 1 MB。Markdown 和 HTML 默认渲染，可以切到源码。 */
function TextFile({ file, source }: { file: ILocalFileInfo; source: boolean }) {
	const truncated = file.size! > MAX_TEXT_BYTES;
	const text = useQuery({
		queryKey: ['fileText', file.path, file.modifiedAt, file.size],
		queryFn: async () => {
			const response = await fetch(fileContentUrl(file.path), { headers: truncated ? { Range: `bytes=0-${MAX_TEXT_BYTES - 1}` } : {} });
			if (!response.ok) throw new Error(`读取失败（${response.status}）`);
			return response.text();
		},
		staleTime: 0,
		retry: false,
		// 文件变了重新读时先留着原来的内容，读到了再换上。
		placeholderData: keepPreviousData,
	});
	if (text.isError) return <CenteredMessage title={text.error.message} />;
	if (text.data === undefined) return null;
	const note = truncated && <div className="border-b border-line bg-pane px-3 py-1 text-xs text-fg-3">文件过大，仅显示开头 1 MB</div>;
	if (!source && file.mime === 'text/markdown') return <>{note}<div className="px-5 py-4 text-sm"><Markdown text={text.data} file={file.path} /></div></>;
	// 放在不同源的沙箱里：页面的脚本照常执行，但拿不到网页端的登录状态。
	if (!source && file.mime === 'text/html') return <iframe sandbox="allow-scripts" srcDoc={text.data} title={file.name} className="size-full bg-white" />;
	return <>{note}<CodeLines code={text.data} language={/\.([^./\\]+)$/.exec(file.path)?.[1] ?? ''} /></>;
}

/**
 * 带行号的代码：按扩展名高亮，太长或不认识的语言显示纯文本。
 * 行号是左边单独的一列，复制时不带。不用 CSS 计数器画在每行前面：行多时 Edge 里拖动分隔线会一卡一卡的。
 */
function CodeLines({ code, language }: { code: string; language: string }) {
	const text = code.replace(/\n$/, '');
	const [highlighted, setHighlighted] = useState<{ html: string; lines: number }>();
	useEffect(() => {
		let cancelled = false;
		// 换了内容时，高亮好之前先显示原来的（行号也是原来的）；新内容太长不高亮时直接显示纯文本。
		if (text.length <= MAX_HIGHLIGHT_CHARS) void highlight(text, language).then(html => !cancelled && setHighlighted(html === undefined ? undefined : { html, lines: lineCount(text) }));
		else setHighlighted(undefined);
		return () => {
			cancelled = true;
		};
	}, [text, language]);
	const lines = highlighted?.lines ?? lineCount(text);
	return (
		<div className="flex w-max min-w-full px-3 py-2 font-mono text-[12.5px] leading-relaxed">
			<pre aria-hidden className="m-0 mr-[1em] min-w-[2.5em] shrink-0 select-none text-right text-fg-3">{Array.from({ length: lines }, (_, index) => index + 1).join('\n')}</pre>
			{highlighted
				? <div className="[&_pre]:m-0 [&_pre]:bg-transparent!" dangerouslySetInnerHTML={{ __html: highlighted.html }} />
				: <pre className="m-0"><code>{text}</code></pre>}
		</div>
	);
}

function lineCount(text: string): number {
	let count = 1;
	for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) count++;
	return count;
}
