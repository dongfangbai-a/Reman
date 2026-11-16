import clsx from 'clsx';
import { Check, Copy } from 'lucide-react';
import type { ReactNode, Ref } from 'react';
import { useCopy } from '../lib/clipboard.ts';

/**
 * 消息、时间线里的复制按钮：一个小图标，复制后短暂变成对勾。
 * 电脑上移到外面带 group/copy 的那一条（那一块）上才出现；手机上没有悬停，一直浅灰显示。
 */
export function CopyButton({ text, className }: { text: string; className?: string }) {
	const { state, copy } = useCopy();
	const label = state === 'copied' ? '已复制' : state === 'failed' ? '复制失败' : '复制';
	return (
		<button
			type="button"
			aria-label={label}
			title={label}
			onClick={() => copy(text)}
			className={clsx(
				'inline-flex size-5 shrink-0 items-center justify-center rounded transition-opacity hover:bg-hover hover:text-fg-2 focus-visible:opacity-100 [@media(hover:none)]:opacity-100',
				state === 'idle' ? 'text-fg-3 opacity-0 group-hover/copy:opacity-100' : state === 'copied' ? 'text-accent' : 'text-danger',
				className,
			)}
		>
			{state === 'copied' ? <Check size={12} /> : <Copy size={12} />}
		</button>
	);
}

/**
 * 会滚动的一块等宽字，右上角复制。className 给高度上限、字的颜色。
 * 复制按钮放在滚动区域里、粘在顶上，而不是盖在外面：滚动区域的内容宽度不含滚动条，按钮自动让开滚动条，
 * 有没有滚动条、滚动条多宽都不用算；往下翻时也一直在右上角。
 */
export function CodeScroll({ text, className, ref, onScroll }: { text: string; className?: string; ref?: Ref<HTMLDivElement>; onScroll?: () => void }) {
	return (
		<div ref={ref} onScroll={onScroll} className={clsx('group/copy overflow-auto rounded-md bg-code', className)}>
			<div className="sticky top-0 z-10 flex h-0 justify-end">
				<CopyButton text={text} className="mr-1 mt-1 bg-code" />
			</div>
			<pre className="whitespace-pre-wrap break-words py-1.5 pl-2 pr-7 font-mono text-xs">{text}</pre>
		</div>
	);
}

/** 一块内容，右上角是复制按钮。buttonClassName 给按钮一个和这块一样的底色，盖住下面的文字。会滚动的用 CodeScroll。 */
export function CopyCorner({ text, buttonClassName = 'bg-code', children }: { text: string; buttonClassName?: string; children: ReactNode }) {
	return (
		<div className="group/copy relative">
			{children}
			<CopyButton text={text} className={clsx('absolute right-1 top-1', buttonClassName)} />
		</div>
	);
}
