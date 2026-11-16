import * as Popover from '@radix-ui/react-popover';
import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';
import type { ContextCategory, IContextUsageInfo } from '../api/types.ts';
import { formatTokens } from '../lib/format.ts';

/** 各部分在卡片里的名字和颜色，按上下文里的先后排。 */
const CATEGORIES: readonly { readonly key: ContextCategory; readonly label: string; readonly color: string }[] = [
	{ key: 'system', label: '系统提示词', color: 'bg-series-1' },
	{ key: 'tools', label: '工具提示词', color: 'bg-series-2' },
	{ key: 'memory', label: '记忆', color: 'bg-series-7' },
	{ key: 'incoming', label: '收到的消息', color: 'bg-series-3' },
	{ key: 'toolCalls', label: '工具调用', color: 'bg-series-4' },
	{ key: 'outputs', label: '输出和思考', color: 'bg-series-5' },
	{ key: 'summaries', label: '摘要', color: 'bg-series-6' },
];
/** 50% 起提醒；70% 起是运行时压缩的线。 */
const WARNING_RATIO = 0.5;
const DANGER_RATIO = 0.7;
const RADIUS = 7;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
/** 用量很少时至少画出这么长的弧，不然看起来像空的。 */
const MIN_ARC = 0.04;
const OPEN_DELAY_MS = 150;
const CLOSE_DELAY_MS = 120;

/** 上下文用量圆环：填充的比例是已用占上下文长度的比例。悬停或点击显示各部分的用量。 */
export function ContextRing({ usage }: { usage: IContextUsageInfo }) {
	const [open, setOpen] = useState(false);
	const timer = useRef<number | undefined>(undefined);
	const pointer = useRef('mouse');
	useEffect(() => () => window.clearTimeout(timer.current), []);

	const ratio = Math.min(1, usage.usedTokens / usage.contextWindow);
	const arc = usage.usedTokens > 0 ? Math.max(ratio, MIN_ARC) : 0;
	const percent = ratio > 0 && ratio < 0.01 ? '<1%' : `${Math.round(ratio * 100)}%`;
	const summary = `${formatTokens(usage.usedTokens)} / ${formatTokens(usage.contextWindow)} · ${percent}`;
	// 鼠标靠悬停打开和关闭；触屏没有悬停，点一下打开。
	const hover = (next: boolean) => {
		window.clearTimeout(timer.current);
		timer.current = window.setTimeout(() => setOpen(next), next ? OPEN_DELAY_MS : CLOSE_DELAY_MS);
	};
	const hoverHandlers = {
		onPointerEnter: (event: { pointerType: string }) => event.pointerType === 'mouse' && hover(true),
		onPointerLeave: (event: { pointerType: string }) => event.pointerType === 'mouse' && hover(false),
	};

	return (
		<Popover.Root open={open} onOpenChange={setOpen}>
			<Popover.Trigger asChild>
				<button
					type="button"
					aria-label={`上下文 ${summary}`}
					{...hoverHandlers}
					onPointerDown={event => { pointer.current = event.pointerType; }}
					onClick={event => { if (pointer.current === 'mouse') event.preventDefault(); }}
					className="inline-flex size-6 shrink-0 items-center justify-center rounded-md outline-none focus-visible:outline-2 focus-visible:outline-accent"
				>
					<svg width={16} height={16} viewBox="0 0 16 16" className="-rotate-90" aria-hidden>
						<circle cx={8} cy={8} r={RADIUS} fill="none" strokeWidth={2} className="stroke-line-strong" />
						{arc > 0 && (
							<circle
								cx={8} cy={8} r={RADIUS} fill="none" strokeWidth={2} strokeLinecap="round"
								strokeDasharray={`${arc * CIRCUMFERENCE} ${CIRCUMFERENCE}`}
								className={ratio >= DANGER_RATIO ? 'stroke-danger' : ratio >= WARNING_RATIO ? 'stroke-warning' : 'stroke-fg-2'}
							/>
						)}
					</svg>
				</button>
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content
					side="bottom"
					align="start"
					sideOffset={6}
					onOpenAutoFocus={event => event.preventDefault()}
					{...hoverHandlers}
					className="z-50 w-60 rounded-lg border border-line bg-raised p-3 text-[13px] shadow-lg"
				>
					<div className="flex items-baseline justify-between gap-3">
						<span className="font-medium">上下文</span>
						<span className="tabular-nums text-fg-2">{summary}</span>
					</div>
					<div className="mt-2 flex h-1.5 gap-0.5 overflow-hidden rounded-full bg-selected">
						{CATEGORIES.filter(category => usage.categories[category.key] > 0).map(category => (
							<div key={category.key} className={clsx('h-full shrink-0', category.color)} style={{ width: `${usage.categories[category.key] / usage.contextWindow * 100}%` }} />
						))}
					</div>
					<div className="mt-2.5 space-y-1">
						{CATEGORIES.map(category => (
							<div key={category.key} className="flex items-center gap-2">
								<span className={clsx('size-2 shrink-0 rounded-full', category.color)} />
								<span className="flex-1 text-fg-2">{category.label}</span>
								<span className="tabular-nums">{formatTokens(usage.categories[category.key])}</span>
							</div>
						))}
					</div>
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}
