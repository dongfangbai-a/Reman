import clsx from 'clsx';
import { ChevronRight, Hourglass, LoaderCircle } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { conversationPath } from '../api/keys.ts';
import { useStreams, useStreamText } from '../api/member.ts';
import type { ContextState, IApproval, ITask } from '../api/types.ts';
import { StepText, type IStep } from '../chat/activity.tsx';
import { Markdown } from '../chat/Markdown.tsx';
import { firstLine } from '../lib/format.ts';
import { FADED } from './faded.ts';
import { LongText } from './LongText.tsx';
import { parseArguments, reasoningText, type SentRow, type Step } from './rows.ts';
import { StickyLevel, useStickyHeader } from './sticky.tsx';
import { Dim, Heading } from './TimelineRows.tsx';
import { CallStep, ContextTag, ConversationName, isRecord, MessageExtras, STATUS, StepDetails, StepLine, unwrapCall, type CallStatus } from './ToolCard.tsx';

/** 各段过程共用的：待审批、后台任务、正在运行的那次运行。 */
export interface IBlockContext {
	readonly memberId: string;
	readonly approvals: readonly IApproval[];
	readonly taskByCall: ReadonlyMap<string, ITask>;
	readonly runningRunId: number | undefined;
	/** 生成中点开的思考，按请求记下：生成完换成正式的那一步时照样展开。 */
	readonly openedThinking: Set<number>;
}

type CallLike = Extract<Step, { kind: 'call' }> | SentRow;

/**
 * 一段过程：只有一步时直接显示这一步；两步以上合成一行灰字，点开每一步一行、缩进，收起时下面只放要处理的步骤。
 * 运行中的最后一段总用合成的一行，后面写成员正在做什么。
 */
export function ProcessBlock({ steps, context, open, onToggle, live, streamRequestId }: {
	steps: readonly Step[];
	context: IBlockContext;
	open: boolean;
	onToggle: () => void;
	/** 运行中的最后一段：成员正在做什么。 */
	live: IStep | undefined;
	/** 正在生成的思考是哪次请求的。 */
	streamRequestId: number | undefined;
}) {
	// 只订阅有没有思考，内容由 StreamThinking 订阅：每来一段只重画那一步。
	const thinking = useStreams(store => streamRequestId !== undefined && store.streams[context.memberId]?.requestId === streamRequestId && store.streams[context.memberId]!.reasoning !== '');
	if (!live && steps.length === 1) return <StepView step={steps[0]!} context={context} />;
	const shown = open ? steps : steps.filter(step => needsAttention(step, context));
	return (
		<div>
			<ProcessLine steps={steps} open={open} onToggle={onToggle} live={live} />
			{(shown.length > 0 || (open && thinking)) && (
				<div className="mt-0.5 pl-4">
					{/* 过程行展开时停在顶部，里面展开的一步停在它下面；收起时下面露出的步骤上面没有停着的行。 */}
					<StickyLevel active={open}>
						{shown.map(step => <StepView key={step.key} step={step} context={context} />)}
						{open && thinking && <StreamThinking key={`stream:${streamRequestId}`} memberId={context.memberId} requestId={streamRequestId!} opened={context.openedThinking} />}
					</StickyLevel>
				</div>
			)}
		</div>
	);
}

/** 过程行：按种类数，有出错的写出错数，运行中写成员正在做什么。 */
function ProcessLine({ steps, open, onToggle, live }: { steps: readonly Step[]; open: boolean; onToggle: () => void; live: IStep | undefined }) {
	const summary = processSummary(steps);
	const errors = steps.filter(step => step.kind === 'call' && step.result?.result.isError && !step.result.result.stopped).length;
	const state = blockState(steps);
	const sticky = useStickyHeader<HTMLButtonElement>(open, onToggle);
	return (
		<button
			ref={sticky.ref}
			type="button"
			aria-expanded={open}
			onClick={sticky.toggle}
			style={sticky.style}
			className={clsx('flex w-full py-0.5 text-left text-xs text-fg-3 hover:text-fg-2', sticky.className)}
		>
			{/* 变淡的是文字，不是整行：停在顶部时底色不透明，下面滚过去的内容透不上来。 */}
			<span className={clsx('flex min-w-0 flex-1 items-center gap-1', state !== 'visible' && FADED)}>
				<ChevronRight size={13} className={clsx('shrink-0 transition-transform', open && 'rotate-90')} />
				{summary && <span className="min-w-0 truncate">{summary}</span>}
				{errors > 0 && <span className="shrink-0 text-danger">{summary && '· '}{errors} 个出错</span>}
				{live && (
					<span className={clsx('flex min-w-0 items-center gap-1', live.waiting ? 'text-attention' : 'text-accent')}>
						{(summary || errors > 0) && <span className="text-fg-3">·</span>}
						{live.waiting ? <Hourglass size={12} className="shrink-0" /> : <LoaderCircle size={12} className="shrink-0 animate-spin" />}
						<span className="truncate"><StepText step={live} /></span>
					</span>
				)}
				<ContextTag state={state} />
			</span>
		</button>
	);
}

function StepView({ step, context }: { step: Step; context: IBlockContext }) {
	switch (step.kind) {
		case 'thinking':
			return <ThinkingStep text={reasoningText(step.entry.output)} contextState={step.state} requestId={step.entry.requestId} opened={context.openedThinking} />;
		case 'other':
			return <FixedStep state={step.state}>模型输出了 {String(step.entry.output.type)}</FixedStep>;
		case 'empty':
			return <FixedStep state={step.state}>空回复</FixedStep>;
		case 'call': {
			const info = callInfo(step, context);
			return (
				<CallStep
					memberId={context.memberId}
					name={info.name}
					args={info.args}
					result={info.result}
					status={info.status}
					task={info.task}
					place={{ runId: info.runId, callId: info.callId }}
					contextState={info.contextState}
				/>
			);
		}
	}
}

/**
 * 思考：「思考：」加摘要的开头，展开看全文；只有加密内容时不能展开。生成中的也默认收起，不转圈（过程行已经在转）；
 * 生成中点开的记在 opened 里，生成完换成正式的那一步时照样展开。
 */
/** 正在生成的思考：自己订阅内容，每来一段只重画这一步。 */
export function StreamThinking({ memberId, requestId, opened }: { memberId: string; requestId: number; opened: Set<number> }) {
	const text = useStreamText(memberId, requestId, 'reasoning');
	return <ThinkingStep text={text} contextState="visible" requestId={requestId} opened={opened} />;
}

export function ThinkingStep({ text, contextState, requestId, opened }: { text: string; contextState: ContextState; requestId: number; opened: Set<number> }) {
	const [open, setOpen] = useState(() => opened.has(requestId));
	const toggle = () => {
		if (open) opened.delete(requestId);
		else opened.add(requestId);
		setOpen(!open);
	};
	if (!text) return <FixedStep state={contextState}>思考（内容不可见）</FixedStep>;
	return (
		<div className={clsx(contextState !== 'visible' && FADED)}>
			<StepLine open={open} onToggle={toggle} contextState={contextState} copy={text}>
				思考<span className="text-fg-3">：{firstLine(text)}</span>
			</StepLine>
			{open && <StepDetails><div className="whitespace-pre-wrap break-words text-fg-2">{text}</div></StepDetails>}
		</div>
	);
}

/** 发出的消息：像收到的消息一样显示；没发成时标题后面写状态，出错时下面写原因。发出去的，点标题用这个 AI 的视角打开那个对话。 */
export function SentMessage({ step, context }: { step: SentRow; context: IBlockContext }) {
	const info = callInfo(step, context);
	const args = isRecord(info.args) ? info.args : {};
	const target = String(args['target'] ?? '');
	const text = String(args['text'] ?? '');
	const meta = info.status === 'success' ? undefined : STATUS[info.status];
	const label = info.status === 'running' ? '发送中' : info.status === 'skipped' ? '未发送' : meta?.label;
	return (
		<Dim state={info.contextState} copyable>
			<Heading time={step.call.createdAt} state={info.contextState} copy={text || undefined}>
				{info.status === 'success' && target
					? (
						<Link
							to={conversationPath(context.memberId, target.startsWith('G_') ? { kind: 'group', groupId: target } : { kind: 'direct', memberId: target })}
							title="在对话中查看"
							className="hover:text-accent hover:underline"
						>
							{target.startsWith('G_') ? '发送到 ' : '发送给 '}<ConversationName id={target} />
						</Link>
					)
					: <>{target.startsWith('G_') ? '发送到 ' : '发送给 '}<ConversationName id={target} /></>}
				{meta && <span className={clsx('ml-1.5', meta.className)}>{label}</span>}
			</Heading>
			<div className="mt-0.5 space-y-1">
				{text && <LongText><Markdown text={text} /></LongText>}
				<MessageExtras args={args} />
				{info.result?.isError && <div className="whitespace-pre-wrap break-words text-xs text-danger">{info.result.output}</div>}
			</div>
		</Dim>
	);
}

/** 一次调用要显示的：名字、参数、结果、状态、待审批、后台任务。 */
function callInfo(step: CallLike, context: IBlockContext) {
	const runId = step.call?.runId ?? step.result!.runId;
	const callId = step.call ? String(step.call.output['call_id']) : step.result!.result.callId;
	const name = step.call ? String(step.call.output['name']) : step.result!.result.name;
	const approvals = context.approvals.filter(approval => approval.runId === runId && approval.callId === callId);
	const task = context.taskByCall.get(`${runId}:${callId}`);
	// 运行停止时记下的结果：没执行的只说明停在哪一步，状态里已经写了，不显示；执行到一半的可能带着工具已有的输出，照常显示，不标出错。
	const recorded = step.result?.result;
	const result = recorded?.stopped === 'before' ? undefined : recorded?.stopped ? { ...recorded, isError: false } : recorded;
	const status: CallStatus = recorded?.stopped === 'before' ? 'skipped'
		: recorded?.stopped === 'during' ? 'stopped'
		: result ? task ? 'background' : result.isError ? 'error' : 'success'
		: approvals.length > 0 ? 'waiting' : step.call && step.call.runId === context.runningRunId ? 'running' : 'unknown';
	const args = step.call ? parseArguments(step.call.output['arguments']) : undefined;
	return { runId, callId, name, args, result, status, approvals, task, contextState: (step.call ?? step.result)!.contextState };
}

/**
 * 收起时也要露出来的步骤：后台任务还在运行的。等审批的不露出来：过程行写着「在等你审批」，审批卡片浮在时间线底部，
 * 不放进内容里，免得批完一个、下一个还没来时内容一缩一伸，整片上下跳。
 */
function needsAttention(step: Step, context: IBlockContext): boolean {
	return step.kind === 'call' && callInfo(step, context).task?.status === 'running';
}

/** 一种步骤：同种的合在一起数。 */
interface IKind {
	readonly key: string;
	readonly amount: number;
	readonly label: (count: number) => string;
}

/** 过程行的文字：按种类数，按第一次出现的先后排。 */
function processSummary(steps: readonly Step[]): string {
	const kinds = new Map<string, { count: number; label: (count: number) => string }>();
	for (const step of steps) {
		const kind = kindOf(step);
		if (!kind) continue;
		const current = kinds.get(kind.key);
		if (current) current.count += kind.amount;
		else kinds.set(kind.key, { count: kind.amount, label: kind.label });
	}
	return [...kinds.values()].map(({ count, label }) => label(count)).join(' · ');
}

/** 「思考」「思考 3 次」这样的写法。 */
function times(verb: string): (count: number) => string {
	return count => count > 1 ? `${verb} ${count} 次` : verb;
}

function kindOf(step: Step): IKind | undefined {
	if (step.kind === 'thinking') return { key: 'thinking', amount: 1, label: times('思考') };
	if (step.kind === 'other') return { key: 'other', amount: 1, label: times('其他输出') };
	if (step.kind === 'empty') return { key: 'empty', amount: 1, label: times('空回复') };
	if (step.kind !== 'call') return undefined;
	const rawName = step.call ? String(step.call.output['name']) : step.result!.result.name;
	const { name, args, describe } = unwrapCall(rawName, step.call ? parseArguments(step.call.output['arguments']) : undefined);
	const record = isRecord(args) ? args : {};
	if (describe) return { key: 'describe', amount: 1, label: count => count > 1 ? `查看 ${count} 个工具说明` : '查看工具说明' };
	switch (name) {
		case 'shell':
			return { key: name, amount: 1, label: count => `执行 ${count} 条命令` };
		case 'terminal':
			return { key: name, amount: 1, label: times('使用终端') };
		case 'browser':
			return { key: name, amount: 1, label: times('使用浏览器') };
		case 'write_file':
			// 覆盖已有文件和 edit_file 一起算作修改文件。
			return record['overwrite'] === true
				? { key: 'edit_file', amount: 1, label: times('修改文件') }
				: { key: name, amount: 1, label: count => `新建 ${count} 个文件` };
		case 'edit_file':
			return { key: name, amount: 1, label: times('修改文件') };
		case 'run_tool_script':
			return { key: name, amount: 1, label: times('用脚本调用工具') };
		case 'view_image':
			return { key: name, amount: Math.max(1, Array.isArray(record['paths']) ? record['paths'].length : 1), label: count => `查看 ${count} 张图片` };
		case 'read_pdf':
			return { key: name, amount: 1, label: times('读取 PDF') };
		case 'read_skill':
			return { key: name, amount: 1, label: count => count > 1 ? `读取 ${count} 个技能` : '读取技能' };
		case 'search_history':
			return { key: name, amount: 1, label: times('查找历史记录') };
		case 'manage_group':
			return { key: name, amount: 1, label: times('管理群聊') };
		case 'manage_background_tasks':
			return { key: name, amount: 1, label: times('管理后台任务') };
		case 'manage_reminders': {
			const verb = ({ add: '新建', update: '修改', cancel: '取消' } as Record<string, string | undefined>)[String(record['action'])];
			if (!verb) return { key: `${name}:list`, amount: 1, label: times('查看定时') };
			return { key: `${name}:${verb}`, amount: 1, label: count => count > 1 ? `${verb} ${count} 个定时` : `${verb}定时` };
		}
		case 'manage_memory':
			return { key: name, amount: 1, label: times('更新记忆') };
		case 'update_plan':
			return { key: name, amount: 1, label: times('更新计划') };
		case 'send_message':
			// 调用在还没加载的更早部分时，发消息的结果算在过程里。
			return { key: name, amount: 1, label: count => `发送 ${count} 条消息` };
		default:
			return { key: `tool:${name}`, amount: 1, label: times(`调用 ${name}`) };
	}
}

/** 这段过程的每一步都不在上下文里时变淡，标签按这个先后取：已压缩、已删除、没放进上下文、没带回上下文。 */
function blockState(steps: readonly Step[]): ContextState {
	const states = steps.map(stateOf);
	if (states.length === 0 || states.includes('visible')) return 'visible';
	return BLOCK_STATES.find(state => states.includes(state)) ?? 'visible';
}

const BLOCK_STATES: readonly ContextState[] = ['summarized', 'pruned', 'omitted', 'unreturned'];

function stateOf(step: Step | SentRow): ContextState {
	return step.kind === 'call' || step.kind === 'sent' ? (step.call ?? step.result)!.contextState : step.state;
}

/** 不能展开的一步：只有一行，不在上下文里时变淡。 */
function FixedStep({ state, children }: { state: ContextState; children: ReactNode }) {
	return <div className={clsx(state !== 'visible' && FADED)}><StepLine open={false} onToggle={undefined} contextState={state}>{children}</StepLine></div>;
}
