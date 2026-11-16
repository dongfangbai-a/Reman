import { Check, Copy } from 'lucide-react';
import { memo, useEffect, useMemo, useState } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useRuntimePlatform } from '../api/system.ts';
import { useCopy } from '../lib/clipboard.ts';
import { highlight } from '../lib/highlight.ts';
import { fileContentUrl, FileLink } from '../workbench/FileLink.tsx';
import { directoryOf, fixSpacedLinks, isFullPath, isWebLink, linkedFile, resolvePath, type Platform } from '../workbench/paths.ts';

/**
 * Markdown：AI 的消息、时间线，以及工作台里预览的 Markdown 文件。网址在新标签页打开，本机文件在工作台里预览。
 * 外部图片不加载，只显示成链接。file 是正在预览的 Markdown 文件：里面的相对路径按它所在的目录算，本机图片直接显示。
 */
export const Markdown = memo(function Markdown({ text, file }: { text: string; file?: string }) {
	const platform = useRuntimePlatform();
	const components = useMemo(() => markdownComponents(platform, file), [platform, file]);
	return (
		<div className="markdown break-words">
			<ReactMarkdown remarkPlugins={[remarkGfm]} components={components} urlTransform={keepFileUrls}>{fixSpacedLinks(text)}</ReactMarkdown>
		</div>
	);
});

/** 盘符路径（E:/a.md 会被当成 E: 协议）和 file: 网址原样留给下面判断，别的照常过滤（javascript: 这类去掉）。 */
function keepFileUrls(url: string): string {
	return /^(file:|[A-Za-z]:[\\/])/i.test(url) ? url : defaultUrlTransform(url);
}

function markdownComponents(platform: Platform | undefined, file: string | undefined): Components {
	/** 地址指向的本机文件：完整路径；预览文件时相对路径按文件所在的目录算。 */
	const target = (href: string | undefined): string | undefined => {
		if (!href) return undefined;
		const full = linkedFile(href, platform);
		if (full || !file || isWebLink(href) || href.startsWith('#')) return full;
		return resolvePath(directoryOf(file), safeDecode(href));
	};
	return {
		...COMPONENTS,
		a: ({ node: _, href, children, ...props }) => {
			if (href && isWebLink(href)) return <a {...props} href={href} target="_blank" rel="noreferrer noopener">{children}</a>;
			const path = target(href);
			// 相对路径、页内锚点不做成链接，照原样显示文字。
			return path ? <FileLink path={path} variant="link">{children}</FileLink> : <span>{children}</span>;
		},
		img: ({ src, alt }) => {
			const source = typeof src === 'string' ? src : '';
			const path = target(source);
			if (path && file) return <img src={fileContentUrl(path)} alt={alt ?? ''} className="max-w-full" />;
			const label = `[图片${alt ? `：${alt}` : ''}]`;
			if (path) return <FileLink path={path} variant="link">{label}</FileLink>;
			return <a href={source || undefined} target="_blank" rel="noreferrer noopener">{label}</a>;
		},
		// 代码块由 pre 整个画，这里只会是行内代码：整段是完整路径时可以点开。
		code: ({ node: _, children, ...props }) => {
			const text = typeof children === 'string' ? children : '';
			if (isFullPath(text, platform)) return <FileLink path={text}><code {...props}>{children}</code></FileLink>;
			return <code {...props}>{children}</code>;
		},
	};
}

function safeDecode(text: string): string {
	try {
		return decodeURI(text);
	} catch {
		return text;
	}
}

interface IHastNode {
	readonly type: string;
	readonly value?: string;
	readonly tagName?: string;
	readonly properties?: { className?: unknown };
	readonly children?: readonly IHastNode[];
}

const COMPONENTS: Components = {
	pre: ({ node }) => {
		const code = (node as IHastNode | undefined)?.children?.find(child => child.tagName === 'code');
		const classes = Array.isArray(code?.properties?.className) ? code.properties.className as string[] : [];
		const language = classes.find(name => name.startsWith('language-'))?.slice('language-'.length) ?? '';
		return <CodeBlock code={textOf(code).replace(/\n$/, '')} language={language} />;
	},
};

function textOf(node: IHastNode | undefined): string {
	if (!node) return '';
	if (node.type === 'text') return node.value ?? '';
	return (node.children ?? []).map(textOf).join('');
}

/** 代码块：高亮好之前和不认识的语言显示纯文本。右上角可以复制。工具卡片里写文件的内容也用它。 */
export function CodeBlock({ code, language }: { code: string; language: string }) {
	const [html, setHtml] = useState<string>();
	const { state, copy } = useCopy();
	useEffect(() => {
		let cancelled = false;
		void highlight(code, language).then(result => !cancelled && setHtml(result));
		return () => {
			cancelled = true;
		};
	}, [code, language]);
	return (
		<div className="relative my-2 overflow-hidden rounded-lg border border-line bg-code">
			<div className="flex h-7 items-center justify-between border-b border-line px-3 text-xs text-fg-3">
				<span>{language || '代码'}</span>
				<button type="button" onClick={() => copy(code)} className="flex items-center gap-1 hover:text-fg" aria-label="复制代码">
					{state === 'copied' ? <><Check size={13} />已复制</> : state === 'failed' ? <>复制失败</> : <><Copy size={13} />复制</>}
				</button>
			</div>
			{html
				? <div className="overflow-x-auto px-3 py-2 font-mono text-[12.5px] leading-relaxed [&_pre]:m-0" dangerouslySetInnerHTML={{ __html: html }} />
				: <pre className="m-0 overflow-x-auto px-3 py-2 font-mono text-[12.5px] leading-relaxed"><code>{code}</code></pre>}
		</div>
	);
}
