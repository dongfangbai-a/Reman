import clsx from 'clsx';
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Hourglass } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { IApproval } from '../api/types.ts';
import { IconButton } from '../ui/Button.tsx';
import { ApprovalCard, Remaining } from './ApprovalCard.tsx';
import { approvalSubject, useToolLabel } from './approvalText.ts';

/** 出现和全部处理完时淡入淡出多久。 */
const FADE_MS = 150;

/**
 * 时间线底部、输入框上方浮着的审批卡片：这个成员的待审批，一次一张，按先后排。
 * 不放进时间线的内容里：时间线贴着底部显示，内容里的卡片一出一进，屏幕上每一行都跟着上下移；
 * 浮着就不占内容的高度，批完一个、下一个隔多久来都不会跳。onHeight 报告浮层现在多高，「回到底部」按钮放在它上面。
 */
export function ApprovalDock({ memberName, approvals, onHeight }: { memberName: string; approvals: readonly IApproval[]; onHeight: (height: number) => void }) {
	const sorted = useMemo(() => [...approvals].sort((left, right) => left.approvalId - right.approvalId), [approvals]);
	const [currentId, setCurrentId] = useState<number>();
	const [collapsed, setCollapsed] = useState(false);
	// 看着的那张批完或超时了，换成剩下最早的一张。
	const index = Math.max(0, sorted.findIndex(approval => approval.approvalId === currentId));
	const current = sorted[index];

	// 全部处理完时，最后那张淡出后再拿掉；淡出时又来了审批，接着显示新的。全部处理完后再来新的审批时又是展开的。
	// 最后那张在渲染时就接着显示，不等 effect：不然批完的那一刻会先空一帧。
	const last = useRef<IApproval | undefined>(undefined);
	if (current) last.current = current;
	const [, setFaded] = useState(0);
	const empty = !current;
	useEffect(() => {
		if (!empty) return;
		setCollapsed(false);
		if (!last.current) return;
		const timer = window.setTimeout(() => {
			last.current = undefined;
			setFaded(count => count + 1);
		}, FADE_MS);
		return () => window.clearTimeout(timer);
	}, [empty]);
	const shown = current ?? last.current;

	// 刚出现时从透明淡入。
	const [entered, setEntered] = useState(false);
	const present = shown !== undefined;
	useEffect(() => {
		if (!present) {
			setEntered(false);
			return;
		}
		const frame = requestAnimationFrame(() => setEntered(true));
		return () => cancelAnimationFrame(frame);
	}, [present]);

	const element = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		const target = element.current;
		if (!target) return;
		const report = () => onHeight(target.offsetHeight);
		report();
		const observer = new ResizeObserver(report);
		observer.observe(target);
		return () => observer.disconnect();
	}, [onHeight]);

	const select = (offset: number) => setCurrentId(sorted[(index + offset + sorted.length) % sorted.length]?.approvalId);
	const pager = sorted.length > 1 && (
		<span className="flex shrink-0 items-center text-xs tabular-nums text-fg-3">
			<IconButton label="上一个" className="size-6" onClick={() => select(-1)}><ChevronLeft size={14} /></IconButton>
			{index + 1}/{sorted.length}
			<IconButton label="下一个" className="size-6" onClick={() => select(1)}><ChevronRight size={14} /></IconButton>
		</span>
	);

	return (
		<div ref={element} className="pointer-events-none absolute inset-x-0 bottom-0 z-10">
			{shown && (
				<div
					style={{ transition: `opacity ${FADE_MS}ms`, opacity: entered && current ? 1 : 0 }}
					// 贴着时间线的底边：留缝的话后面的内容会从缝里露出半行。
					className={clsx('center-column px-4', current && 'pointer-events-auto')}
				>
					{collapsed
						? <CollapsedBar memberName={memberName} approval={shown} count={sorted.length} onExpand={() => setCollapsed(false)} />
						: (
							<ApprovalCard
								// 换成下一张时重新开始：按钮不能还停在上一张的「处理中」。
								key={shown.approvalId}
								approval={shown}
								className="shadow-lg"
								actions={(
									<>
										{pager}
										<IconButton label="收起" className="-mr-1.5 size-6 shrink-0" onClick={() => setCollapsed(true)}><ChevronDown size={14} /></IconButton>
									</>
								)}
							/>
						)}
				</div>
			)}
		</div>
	);
}

/**
 * 收成一条：谁在等你审批、批的是什么，几张时写一共几个，右边是还剩多久自动拒绝；点击展开。
 * 高 32px：到了底部时正好盖住时间线最后那行「运行中」（25px）和它下面 7px 的留白，不碰前面的内容。
 */
function CollapsedBar({ memberName, approval, count, onExpand }: { memberName: string; approval: IApproval; count: number; onExpand: () => void }) {
	const label = useToolLabel()(approval.toolName);
	const subject = approvalSubject(approval.toolName, approval.arguments);
	// 悬停色叠在不透明的底色上（bg-hover-layer）：直接换成悬停色，后面时间线的字会透上来。
	return (
		<button
			type="button"
			onClick={onExpand}
			className="flex h-8 w-full items-center gap-2 rounded-lg border border-line bg-raised px-3 text-left text-[13px] shadow-lg hover:bg-hover-layer"
		>
			<Hourglass size={13} className="shrink-0 text-attention" />
			<span className="shrink-0 text-attention">{memberName} 等待你审批</span>
			<span className="min-w-0 truncate text-fg-2">· {label}{subject && ` ${subject}`}</span>
			{count > 1 && <span className="shrink-0 text-fg-3">共 {count} 个</span>}
			<Remaining expiresAt={approval.expiresAt} compact />
			<ChevronUp size={14} className="shrink-0 text-fg-3" />
		</button>
	);
}
