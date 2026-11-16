import clsx from 'clsx';
import { ChevronRight, LoaderCircle } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { IOptimization, IOptimizationRequestRecord } from '../api/types.ts';
import { errorMessage } from '../lib/errors.ts';
import { elapsedText, formatTokens, fullTime, shortTime } from '../lib/format.ts';
import { PlanItems, planProgress } from '../overview/PlanItems.tsx';
import { CopyButton, CopyCorner } from '../ui/CopyButton.tsx';
import { TextButton } from '../ui/TextButton.tsx';
import { StreamThinking, ThinkingStep } from './ProcessBlock.tsx';
import type { CompactionCard, Row } from './rows.ts';
import { StickyLevel, useStickyHeader } from './sticky.tsx';
import { countsText, MemoryOperations } from './TimelineRows.tsx';
import { Pre, StepDetails, StepLine } from './ToolCard.tsx';

type OptimizationRowData = Extract<Row, { kind: 'optimization' }>;

/** 出错的压缩记录上的重试：problem 是现在不能手动压缩的原因，run 手动压缩一次。 */
export interface IRecordRetry {
	readonly problem: string | null;
	readonly run: () => Promise<unknown>;
}

const TRIGGER: Readonly<Record<IOptimization['trigger'], string>> = {
	before_request: '运行中发送请求前，输入已达上下文的七成',
	after_run: '运行结束时，输入已达上下文的七成',
	manual: '手动压缩',
};

/**
 * 压缩记录：一次压缩（一轮）的经过和结果，单独一项。标题写结果、时间、整理前后的估算和用时；
 * 展开看时机和用量、每次请求的思考和输出、不合规的地方、重试，最后是这次压缩生效的卡片。
 * 出错的收起时也只有标题一行，原因在展开后的最后、悬停标题也能看到。retry 是最新一条出错时的重试：
 * 都是文字链接：收起时紧跟在标题后面，展开时跟在最后的原因后面。
 */
export function OptimizationRow({ row, open, onToggle, openedThinking, retry }: {
	row: OptimizationRowData;
	open: boolean;
	onToggle: () => void;
	openedThinking: Set<number>;
	retry?: IRecordRetry;
}) {
	const { status, error, startedAt, endedAt, estimate, requests, trigger } = row.entry.optimization;
	const label = status === 'completed' ? '已整理上下文' : status === 'failed' ? '整理上下文出错' : `整理上下文已停止（${error ?? '已暂停'}）`;
	const details = [
		shortTime(endedAt),
		estimate.after !== null && `约 ${formatTokens(estimate.before)} → ${formatTokens(estimate.after)}`,
		`用时 ${elapsedText(endedAt - startedAt)}`,
	].filter(Boolean).join(' · ');
	const title = (
		<span title={status === 'failed' && error ? `${fullTime(endedAt)}\n${error}` : fullTime(endedAt)} className="min-w-0 truncate">
			<span className={status === 'failed' ? 'text-danger' : status === 'completed' ? 'text-fg-2' : 'text-fg-3'}>{label}</span>
			<span className="ml-2">{details}</span>
		</span>
	);
	return (
		<Frame open={open} onToggle={onToggle} title={title} trailing={retry && <Retry retry={retry} />}>
			<div className="py-0.5 text-xs text-fg-3">{[TRIGGER[trigger], usageText(requests)].join(' · ')}</div>
			{requests.length === 1
				? <RequestSteps request={requests[0]!} problems={problemsKind(row.entry.optimization, 0)} openedThinking={openedThinking} />
				: requests.map((request, index) => (
					<div key={request.requestId}>
						<div className="py-0.5 text-xs text-fg-3">第 {index + 1} 次请求</div>
						<div className="pl-4"><RequestSteps request={request} problems={problemsKind(row.entry.optimization, index)} openedThinking={openedThinking} /></div>
					</div>
				))}
			{status === 'failed' && error && (
				<div className="group/copy flex items-baseline gap-1 py-0.5 text-xs text-danger">
					<span className="min-w-0 whitespace-pre-wrap break-words">{error}</span>
					<CopyButton text={error} />
					{retry && <Retry retry={retry} />}
				</div>
			)}
			{row.cards.map(card => <CardStep key={card.itemId} card={card} />)}
		</Frame>
	);
}

/** 重试的文字链接：现在不能手动压缩时变灰，悬停写原因；点了报错时旁边写出来。 */
function Retry({ retry }: { retry: IRecordRetry }) {
	const [error, setError] = useState<string>();
	const click = () => {
		setError(undefined);
		retry.run().catch(caught => setError(errorMessage(caught)));
	};
	return (
		<>
			{/* 收起时链接在标题行里：点它不展开，变灰时也一样。 */}
			<span className="contents" onClick={event => event.stopPropagation()}>
				<TextButton problem={retry.problem ?? undefined} onClick={click} className="text-xs">重试</TextButton>
			</span>
			{error && <span title={error} className="min-w-0 truncate text-xs text-danger">重试失败：{error}</span>}
		</>
	);
}

/** 进行中的压缩：转圈，第二次请求时写出来；展开看正在生成的思考。 */
export function LiveOptimizationRow({ request, memberId, streamRequestId, open, onToggle, openedThinking }: {
	request: 1 | 2 | null;
	memberId: string;
	/** 正在生成思考的压缩请求；还没收到思考时是 undefined。 */
	streamRequestId: number | undefined;
	open: boolean;
	onToggle: () => void;
	openedThinking: Set<number>;
}) {
	const title = (
		<span className="flex min-w-0 items-center gap-1 text-accent">
			<LoaderCircle size={12} className="shrink-0 animate-spin" />
			<span className="truncate">正在整理上下文{request === 2 && ' · 第 2 次请求'}</span>
		</span>
	);
	return (
		<Frame open={open} onToggle={onToggle} title={title}>
			{streamRequestId !== undefined && <StreamThinking key={streamRequestId} memberId={memberId} requestId={streamRequestId} opened={openedThinking} />}
		</Frame>
	);
}

/**
 * 记录的外框和标题行：展开时标题停在时间线顶部，里面展开的一步停在它下面。trailing 是收起时紧跟在标题后面的东西；
 * 整行点了都展开收起，trailing 里的按钮自己拦住点击。
 */
function Frame({ open, onToggle, title, trailing, children }: { open: boolean; onToggle: () => void; title: ReactNode; trailing?: ReactNode; children: ReactNode }) {
	const sticky = useStickyHeader<HTMLDivElement>(open, onToggle);
	return (
		<div className="rounded-lg border border-dashed border-line-strong px-3 py-1.5">
			<div ref={sticky.ref} style={sticky.style} onClick={sticky.toggle} className={clsx('group/frame flex cursor-pointer items-center gap-2', sticky.className)}>
				<button
					type="button"
					aria-expanded={open}
					className="flex min-w-0 items-center gap-1 py-0.5 text-left text-xs text-fg-3 group-hover/frame:text-fg-2"
				>
					<ChevronRight size={13} className={clsx('shrink-0 transition-transform', open && 'rotate-90')} />
					{title}
				</button>
				{!open && trailing}
			</div>
			{open && <div className="pl-4"><StickyLevel>{children}</StickyLevel></div>}
		</div>
	);
}

/** 不合规的地方怎么写：有下一次请求的，整份没执行；最后一次的，完成时是跳过的，出错时是没有能用的。 */
type ProblemsKind = 'rejected' | 'skipped' | 'failed';

function problemsKind(optimization: IOptimization, index: number): ProblemsKind {
	if (index < optimization.requests.length - 1) return 'rejected';
	return optimization.status === 'completed' ? 'skipped' : 'failed';
}

/** 一次请求的经过：思考、输出、不合规的地方，自动重试过的写一行原因。没有可显示的思考时不写思考。 */
function RequestSteps({ request, problems, openedThinking }: { request: IOptimizationRequestRecord; problems: ProblemsKind; openedThinking: Set<number> }) {
	const count = request.problems.length;
	const problemLabel = {
		rejected: <span className="text-danger">{count} 处不合规，整份方案均未执行</span>,
		skipped: <span className="text-warning">跳过 {count} 处不合规的操作</span>,
		failed: <span className="text-danger">{count} 处不合规，未执行</span>,
	}[problems];
	return (
		<>
			{request.reasoning && <ThinkingStep text={request.reasoning} contextState="visible" requestId={request.requestId} opened={openedThinking} />}
			{request.output !== null && <OutputStep output={request.output} />}
			{count > 0 && (
				<Expandable label={problemLabel}>
					<ul className="space-y-0.5 text-fg-2">{request.problems.map((problem, index) => <li key={index} className="whitespace-pre-wrap break-words">{problem}</li>)}</ul>
				</Expandable>
			)}
			{request.retries.length > 0 && <div className="py-0.5 pl-[18px] text-xs text-fg-3">已重试 {request.retries.length} 次：{request.retries.join('；')}</div>}
		</>
	);
}

/** 输出：认得出方案时按操作的种类数，展开看格式化的原文；解析不了时展开看原文。 */
function OutputStep({ output }: { output: string }) {
	if (!output) return <Expandable label="输出为空" />;
	const ops = proposalOps(output);
	return (
		<Expandable label={ops ? `输出方案：${opsText(ops)}` : '输出（无法解析）'}>
			<Pre>{ops ? prettyJson(JSON.parse(output)) : output}</Pre>
		</Expandable>
	);
}

/** 这次压缩生效的卡片：更新了记忆、摘要、删掉了内容、放回了计划。 */
function CardStep({ card }: { card: CompactionCard }) {
	const gray = (text: string) => text && <span className="text-fg-3"> · {text}</span>;
	switch (card.kind) {
		case 'memory_change':
			return (
				<Expandable label={<>已更新记忆{gray(`${card.change.operations.length} 处 · 当前 ${card.change.length} 字`)}</>}>
					<MemoryOperations entry={card} />
				</Expandable>
			);
		case 'summary': {
			const counts = countsText(card.summary.counts);
			return (
				<Expandable label={<>摘要{gray(counts && `替代：${counts}`)}</>} contextState={card.contextState}>
					<CopyCorner text={card.summary.text} buttonClassName="bg-page"><div className="whitespace-pre-wrap break-words pr-6 text-fg-2">{card.summary.text}</div></CopyCorner>
				</Expandable>
			);
		}
		case 'pruning': {
			const counts = countsText(card.pruning.counts);
			return <Expandable label={<>已删除内容{gray(counts && `删除：${counts}`)}</>} />;
		}
		case 'plan':
			return (
				<Expandable label={<>已放回计划{gray(planProgress(card.plan.items))}</>} contextState={card.contextState}>
					<PlanItems items={card.plan.items} wrap />
				</Expandable>
			);
	}
}

/** 记录里的一步：一行，有内容时点开看；没有内容时不能展开。 */
function Expandable({ label, contextState, children }: { label: ReactNode; contextState?: CompactionCard['contextState']; children?: ReactNode }) {
	const [open, setOpen] = useState(false);
	return (
		<div>
			<StepLine open={open} onToggle={children ? () => setOpen(value => !value) : undefined} contextState={contextState}>{label}</StepLine>
			{open && children && <StepDetails>{children}</StepDetails>}
		</div>
	);
}

/** 请求的用量，写法和运行结束的分隔线一样；都没报告时只写次数。 */
function usageText(requests: readonly IOptimizationRequestRecord[]): string {
	const reported = requests.filter(request => request.inputTokens !== null);
	const parts = [`${requests.length} 次请求`];
	if (reported.length === 0) return parts.join(' · ');
	const input = reported.reduce((sum, request) => sum + request.inputTokens!, 0);
	const cachedReports = reported.filter(request => request.cachedTokens !== null);
	const cached = cachedReports.reduce((sum, request) => sum + request.cachedTokens!, 0);
	const output = reported.reduce((sum, request) => sum + (request.outputTokens ?? 0), 0);
	parts.push(`输入 ${formatTokens(input)}`);
	if (cachedReports.length > 0 && input > 0) parts.push(`缓存 ${(cached / input * 100).toFixed(1)}%`);
	parts.push(`输出 ${formatTokens(output)}`);
	return parts.join(' · ');
}

/** 输出是要求的方案格式（{ "ops": [...] }）时返回这些操作，否则是 undefined。 */
function proposalOps(output: string): readonly { op?: unknown }[] | undefined {
	try {
		const ops = (JSON.parse(output) as { ops?: unknown } | null)?.ops;
		return Array.isArray(ops) ? ops as { op?: unknown }[] : undefined;
	} catch {
		return undefined;
	}
}

/** 方案里的操作按种类数：摘要、删除、记忆，其他的写在最后；是 0 的不写。 */
function opsText(ops: readonly { op?: unknown }[]): string {
	const count = (match: (op: unknown) => boolean) => ops.filter(item => match(item?.op)).length;
	const summaries = count(op => op === 'summarize');
	const prunes = count(op => op === 'prune');
	const memory = count(op => op === 'memory_add' || op === 'memory_replace');
	const other = ops.length - summaries - prunes - memory;
	const parts = [summaries && `摘要 ${summaries} 条`, prunes && `删除 ${prunes} 处`, memory && `记忆 ${memory} 处`, other && `其他 ${other} 项`].filter(Boolean);
	return parts.length > 0 ? parts.join(' · ') : '无操作';
}

/** 格式化的 JSON：缩进两格，只有数字、文字的数组（比如编号）写在一行。 */
function prettyJson(value: unknown, indent = ''): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value);
	const inner = `${indent}  `;
	if (Array.isArray(value)) {
		if (value.length === 0) return '[]';
		if (value.every(item => item === null || typeof item !== 'object')) return `[${value.map(item => JSON.stringify(item)).join(', ')}]`;
		return `[\n${value.map(item => inner + prettyJson(item, inner)).join(',\n')}\n${indent}]`;
	}
	const entries = Object.entries(value);
	if (entries.length === 0) return '{}';
	return `{\n${entries.map(([key, item]) => `${inner}${JSON.stringify(key)}: ${prettyJson(item, inner)}`).join(',\n')}\n${indent}}`;
}
