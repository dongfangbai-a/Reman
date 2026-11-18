import clsx from 'clsx';
import { ChevronRight, Paperclip } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { api } from '../api/client.ts';
import { conversationPath, refTarget } from '../api/keys.ts';
import { useGroup } from '../api/queries.ts';
import type { ContextState, IContentCounts, IMember, IRun, TimelineEntry } from '../api/types.ts';
import { Markdown } from '../chat/Markdown.tsx';
import { attachmentLabel, Attachments, attachmentViews, Mentions, type IAttachmentView } from '../chat/MessageItem.tsx';
import { errorMessage } from '../lib/errors.ts';
import { dayTime, elapsedText, formatTokens, fullTime, shortTime } from '../lib/format.ts';
import { durationText, reminderDateTime, timeZoneName } from '../lib/reminder.ts';
import { PlanItems, planProgress } from '../overview/PlanItems.tsx';
import { CopyButton, CopyCorner } from '../ui/CopyButton.tsx';
import { MetaDetails } from '../ui/ExternalMeta.tsx';
import { SelfName } from '../ui/SelfName.tsx';
import { TextButton } from '../ui/TextButton.tsx';
import { FADED } from './faded.ts';
import { LongText, type IFold } from './LongText.tsx';
import { messageText } from './rows.ts';
import { useStickyHeader } from './sticky.tsx';
import { ContextTag, Pre } from './ToolCard.tsx';

type Entry<K extends TimelineEntry['kind']> = Extract<TimelineEntry, { kind: K }>;

/** 被压缩或没放进上下文的内容变淡。copyable 时标题行的复制按钮在移到这一条上时出现。 */
export function Dim({ state, copyable = false, children }: { state: ContextState; copyable?: boolean; children: ReactNode }) {
	return <div className={clsx(state !== 'visible' && FADED, copyable && 'group/copy')}>{children}</div>;
}

/**
 * 一条的标题行：来源或类型、时间、上下文标签；copy 是这一条的正文，末尾有复制按钮。
 * fold 是长正文的折叠：前面有箭头，点标题收起、展开；展开时停在时间线顶部，从那里收起时这一条停在原处。
 * faded 时标题的内容变淡：停在顶部的标题行不能整行变淡，底色要不透明，下面滚过去的内容才透不上来。
 */
export function Heading({ children, time, state, copy, fold, faded = false }: {
	children: ReactNode;
	time: number;
	state: ContextState;
	copy?: string;
	fold?: IFold | undefined;
	faded?: boolean;
}) {
	const sticky = useStickyHeader<HTMLDivElement>(fold?.expanded ?? false, fold?.toggle);
	const label = <span className="min-w-0 truncate">{children}</span>;
	return (
		<div ref={sticky.ref} style={sticky.style} className={clsx('flex items-baseline gap-2 text-xs text-fg-3', fold && 'py-0.5', sticky.className)}>
			<span className={clsx('flex min-w-0 items-baseline gap-2', faded && FADED)}>
				{fold ? (
					<button type="button" aria-expanded={fold.expanded} onClick={sticky.toggle} className="flex min-w-0 items-baseline gap-1 hover:text-fg-2">
						<ChevronRight size={13} className={clsx('shrink-0 self-center transition-transform', fold.expanded && 'rotate-90')} />
						{label}
					</button>
				) : label}
				<span title={fullTime(time)} className="shrink-0">{shortTime(time)}</span>
				<ContextTag state={state} />
			</span>
			{copy && <CopyButton text={copy} className={clsx('-my-1 self-center', faded && FADED)} />}
		</div>
	);
}

/** 收到的消息：第一行写来源，下面是正文和附件。点来源用时间线主人的视角打开那个对话，跳到这条消息：它的视角一定看得到。 */
export function MessageRow({ entry, owner, memberById }: { entry: Entry<'message'>; owner: IMember; memberById: Map<string, IMember> }) {
	const { message } = entry;
	const conversation = message.conversation;
	const group = useGroup(conversation.kind === 'group' ? conversation.groupId : undefined);
	const sender = memberById.get(message.senderMemberId);
	const mentioned = message.mentionAll || message.mentionedMemberIds.includes(owner.memberId);
	const source = conversation.kind === 'direct' ? '私聊' : `群聊「${group.data?.name ?? conversation.groupId}」`;
	const link = conversationPath(owner.memberId, refTarget(conversation, owner.memberId), message.messageId);

	return (
		<Dim state={entry.contextState} copyable>
			<Heading time={entry.createdAt} state={entry.contextState} copy={message.text}>
				<Link to={link} title="在对话中查看该消息" className="hover:text-accent hover:underline">
					{source} · {sender?.name ?? '未知成员'}{mentioned && <> · 点名了 <SelfName name={owner.name} /></>}{message.external && ` · 外部事件 ${message.external.source}`}
				</Link>
			</Heading>
			<div className="mt-0.5">
				<Mentions message={message} memberById={memberById} selfId={owner.memberId} />
				{message.text && <LongText>{sender?.type === 'ai' ? <Markdown text={message.text} /> : <div className="whitespace-pre-wrap break-words">{message.text}</div>}</LongText>}
				{message.attachments.length > 0 && <FoldedAttachments attachments={attachmentViews(message)} />}
				{message.external && <MetaDetails meta={message.external.meta} />}
			</div>
		</Dim>
	);
}

/** 时间线里的附件默认收起，只显示「N 张图片 · M 个文件」，点击展开。 */
function FoldedAttachments({ attachments }: { attachments: readonly IAttachmentView[] }) {
	const [open, setOpen] = useState(false);
	return (
		<div className="mt-1">
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen(value => !value)}
				className="inline-flex items-center gap-1 rounded text-[13px] text-accent hover:text-accent-hover"
			>
				<Paperclip size={13} />
				{attachmentLabel(attachments.map(attachment => attachment.kind))}
				<ChevronRight size={13} className={clsx('transition-transform', open && 'rotate-90')} />
			</button>
			{open && <Attachments attachments={attachments} small />}
		</div>
	);
}

/** 模型直接写的文字。 */
export function OutputRow({ entry }: { entry: Entry<'model_output'> }) {
	const { output } = entry;
	if (output.type === 'message') {
		const text = messageText(output);
		const faded = entry.contextState !== 'visible';
		// 不用 Dim 让整条变淡：长的标题行会停在顶部，见 Heading。标题和正文分别变淡。
		return (
			<div className="group/copy">
				<LongText
					defaultExpanded
					bodyClassName={clsx(faded && FADED)}
					heading={fold => <Heading time={entry.createdAt} state={entry.contextState} copy={text} fold={fold} faded={faded}>直接输出</Heading>}
				>
					<Markdown text={text} />
				</LongText>
			</div>
		);
	}
	return <Line time={entry.createdAt}>模型输出了 {output.type}</Line>;
}

/** 使用者在时间线里直接说的话；附件和消息一样默认收起。 */
export function UserInputRow({ entry, member }: { entry: Entry<'user_input'>; member: IMember }) {
	const { text, attachments } = entry.input;
	const views = attachments.map((attachment, index): IAttachmentView => ({
		name: attachment.name, kind: attachment.kind, size: attachment.size,
		url: `/v1/members/${member.memberId}/timeline/${entry.itemId}/attachments/${index}`,
	}));
	return (
		<Dim state={entry.contextState} copyable>
			<div className="border-l-2 border-accent pl-3">
				<Heading time={entry.createdAt} state={entry.contextState} copy={text}><span className="font-medium text-accent">你对 {member.name} 说</span></Heading>
				<div className="mt-0.5">
					{text && <LongText><div className="whitespace-pre-wrap break-words">{text}</div></LongText>}
					{views.length > 0 && <FoldedAttachments attachments={views} />}
				</div>
			</div>
		</Dim>
	);
}

/** 定时到了：成员建定时时写下的要做的事。 */
export function ReminderRow({ entry }: { entry: Entry<'reminder'> }) {
	const { reminder } = entry;
	const late = durationText(reminder.lateMs);
	return (
		<Dim state={entry.contextState} copyable>
			<div className="border-l-2 border-line-strong pl-3">
				<Heading time={entry.createdAt} state={entry.contextState} copy={reminder.note}>
					<span title={[reminder.reminderId, timeZoneName(reminder.timeZone), reminder.repeat].filter(Boolean).join(' · ')}>
						<span className="font-medium text-fg-2">定时</span> · 原定时间 {reminderDateTime(reminder.time)}{late && <span className="text-warning"> · 延迟 {late}</span>}
					</span>
				</Heading>
				<div className="mt-0.5 whitespace-pre-wrap break-words">{reminder.note}</div>
			</div>
		</Dim>
	);
}

/** 路由投来的外部事件：来源和正文，meta 展开看。 */
export function ExternalEventRow({ entry }: { entry: Entry<'external_event'> }) {
	const { source, meta, text } = entry.external;
	return (
		<Dim state={entry.contextState} copyable>
			<div className="border-l-2 border-line-strong pl-3">
				<Heading time={entry.createdAt} state={entry.contextState} copy={text}>
					<span className="font-medium text-fg-2">外部事件</span> · {source}
				</Heading>
				<div className="mt-0.5"><LongText><div className="whitespace-pre-wrap break-words">{text}</div></LongText></div>
				<MetaDetails meta={meta} />
			</div>
		</Dim>
	);
}

/** 群聊变动、后台任务结果、终端交还：一行灰字。时间线主人的名字突出。 */
export function EventRow({ entry, owner, memberById }: { entry: Entry<'group_event' | 'task_result' | 'terminal_event'>; owner: IMember; memberById: Map<string, IMember> }) {
	const name = <SelfName name={owner.name} />;
	if (entry.kind === 'group_event') {
		const { event } = entry;
		// 没有成员时是使用者在网页上做的：「你把」「你让」；成员的名字前后空开。
		const actor = event.actorMemberId === null
			? '你'
			: <>{event.actorMemberId === owner.memberId ? name : memberById.get(event.actorMemberId)?.name ?? '未知成员'} </>;
		const group = `群聊「${event.groupName}」`;
		const text = {
			added: <>{actor}将 {name} 加入了{group}</>,
			removed: <>{actor}将 {name} 移出了{group}</>,
			dissolved: <>{actor}解散了{group}</>,
			restored: <>{group}已恢复</>,
			watched: <>{actor}为 {name} 关注了{group}</>,
			unwatched: <>{actor}取消了 {name} 对{group}的关注</>,
		}[event.type];
		return <Line time={entry.createdAt} state={entry.contextState}>{text}</Line>;
	}
	if (entry.kind === 'terminal_event') {
		const { terminalId, request, waiting } = entry.event;
		// 用户不用接管，直接让成员继续。
		if (entry.event.event === 'declined') {
			return <Line time={entry.createdAt} state={entry.contextState}>用户没有接管终端 {terminalId}，{name} 继续操作{request !== null && `（请求：${request}）`}</Line>;
		}
		// 成员在等你交还，终端却被关闭了、里面的程序退出了：它等不到交还，运行时这时告诉它。
		if (entry.event.event !== 'released') {
			const what = entry.event.event === 'exited' ? `终端 ${terminalId} 中的程序已退出`
				: `终端 ${terminalId} 已被${entry.event.closedBy === 'user' ? '你' : ` ${memberById.get(entry.event.closedBy ?? '')?.name ?? '未知成员'} `}关闭`;
			return <Line time={entry.createdAt} state={entry.contextState}>{what}，{name} 此前在等待交还{request !== null && `：${request}`}</Line>;
		}
		return <Line time={entry.createdAt} state={entry.contextState}>终端 {terminalId} 已交还给 {name}{request !== null ? `：${request}` : waiting ? '' : '（未唤醒）'}</Line>;
	}
	const status = { completed: '已完成', failed: '出错', cancelled: '已取消', interrupted: '因运行时退出中断' }[entry.task.status];
	const lost = entry.task.stoppedOutput === 'lost' ? '，输出未保存' : '';
	// 没唤醒成员的（终端的等待任务因使用者接管终端而结束）写明，和终端交还一样。
	return (
		<Dim state={entry.contextState}>
			<Collapsible title={<span className="text-fg-3">后台任务 {entry.task.taskId}（{entry.task.toolName}）{status}{lost}{!entry.wakes && '（未唤醒）'}<ContextTag state={entry.contextState} /></span>} disabled={!entry.task.output}>
				<Pre>{entry.task.output}</Pre>
			</Collapsible>
		</Dim>
	);
}

/** 压缩时写下的摘要：在压缩发生的位置显示，时间后面写它代替了什么，展开看原文。 */
export function SummaryRow({ entry }: { entry: Entry<'summary'> }) {
	const counts = countsText(entry.summary.counts);
	return (
		<div className="rounded-lg border border-dashed border-line-strong px-3 py-1.5">
			<Collapsible title={<span className="text-fg-2">已整理上下文<span className="ml-2 text-xs text-fg-3">{shortTime(entry.createdAt)}{counts && ` · 替代：${counts}`}</span><ContextTag state={entry.contextState} /></span>}>
				<CopyCorner text={entry.summary.text} buttonClassName="bg-page"><div className="whitespace-pre-wrap break-words pr-6 text-[13px] text-fg-2">{entry.summary.text}</div></CopyCorner>
			</Collapsible>
		</div>
	);
}

/** 压缩时删掉了内容：排在这次压缩的摘要后面，时间后面写删掉了什么。不能展开，删掉的内容还在原处，标着「已删除」。 */
export function PruningRow({ entry }: { entry: Entry<'pruning'> }) {
	const counts = countsText(entry.pruning.counts);
	return (
		<div className="rounded-lg border border-dashed border-line-strong px-3 py-1.5">
			{/* 和能展开的卡片的标题一样排，展开箭头的位置空着，标题和上面几张卡片对齐。 */}
			<div className="flex items-center gap-1 text-xs text-fg-3">
				<span className="w-[13px] shrink-0" />
				<span className="text-fg-2">整理上下文时删除了内容<span className="ml-2 text-xs text-fg-3">{shortTime(entry.createdAt)}{counts && ` · 删除：${counts}`}</span></span>
			</div>
		</div>
	);
}

/** 压缩后放回了计划：所属的压缩记录在还没加载的更早一页时单独显示，时间前面写完成数，展开看清单。 */
export function PlanNoteRow({ entry }: { entry: Entry<'plan'> }) {
	return (
		<div className="rounded-lg border border-dashed border-line-strong px-3 py-1.5">
			<Collapsible title={<span className="text-fg-2">整理上下文后放回了计划<span className="ml-2 text-xs text-fg-3">{planProgress(entry.plan.items)} · {shortTime(entry.createdAt)}</span><ContextTag state={entry.contextState} /></span>}>
				<PlanItems items={entry.plan.items} wrap />
			</Collapsible>
		</div>
	);
}

/** 压缩处理的内容按种类的条数，按这个顺序，是 0 的不写。 */
const COUNT_LABELS: readonly (readonly [keyof IContentCounts, string])[] = [
	['summaries', '摘要 # 条'], ['messages', '消息 # 条'], ['thinking', '思考 # 次'], ['outputs', '输出 # 次'], ['calls', '工具调用 # 次'], ['events', '事件 # 条'],
];

export function countsText(counts: IContentCounts): string {
	return COUNT_LABELS.filter(([key]) => counts[key] > 0).map(([key, label]) => label.replace('#', String(counts[key]))).join(' · ');
}

/** 没看过的内容太多时拿出了上下文：在拿掉的时间点显示一行灰字，和上下文里的说明一样。 */
export function OmissionRow({ entry }: { entry: Entry<'omission'> }) {
	const { startTime, endTime, count } = entry.omission;
	return <Line time={entry.createdAt} state={entry.contextState}>由于内容过多，{dayTime(startTime)} 至 {dayTime(endTime)} 期间收到的内容中有 {count} 条未放入上下文</Line>;
}

/** 变动说明：一行灰字写变了什么，点击展开看给成员的完整说明。 */
export function ChangeNoticeRow({ entry }: { entry: Entry<'change_notice'> }) {
	const title = (
		<span className="text-left text-fg-3">
			{entry.notice.brief}
			<span title={fullTime(entry.createdAt)} className="ml-2">{shortTime(entry.createdAt)}</span>
			<ContextTag state={entry.contextState} />
		</span>
	);
	return (
		<Dim state={entry.contextState}>
			<Collapsible title={title}>
				<div className="whitespace-pre-wrap break-words text-xs text-fg-2">{entry.notice.text}</div>
			</Collapsible>
		</Dim>
	);
}

/** 压缩时改了记忆：排在那次压缩的摘要前面（和上下文里记忆在开头一致），展开看每一处修改。 */
export function MemoryChangeRow({ entry }: { entry: Entry<'memory_change'> }) {
	const { operations, length } = entry.change;
	return (
		<div className="rounded-lg border border-dashed border-line-strong px-3 py-1.5">
			<Collapsible title={<span className="text-fg-2">整理上下文时更新了记忆<span className="ml-2 text-xs text-fg-3">{operations.length} 处 · 当前 {length} 字 · {shortTime(entry.createdAt)}</span></span>}>
				<MemoryOperations entry={entry} />
			</Collapsible>
		</div>
	);
}

/** 压缩对记忆的每一处添加、修改、删除。 */
export function MemoryOperations({ entry }: { entry: Entry<'memory_change'> }) {
	return (
		<div className="space-y-2 text-[13px] text-fg-2">
			{entry.change.operations.map((operation, index) => {
				const [label, text] = operation.op === 'add' ? ['添加', operation.text] : operation.newText ? ['修改', operation.newText] : ['删除', operation.oldText];
				return (
					<div key={index}>
						<div className="text-xs text-fg-3">{label}</div>
						{operation.op === 'replace' && operation.newText && <div className="whitespace-pre-wrap break-words text-fg-3 line-through">{operation.oldText}</div>}
						<div className={clsx('whitespace-pre-wrap break-words', label === '删除' && 'text-fg-3 line-through')}>{text}</div>
					</div>
				);
			})}
		</div>
	);
}

/**
 * 运行结束的分隔线：请求次数、token 和缓存命中率；出错时变红。最近一次出错、或者停在了工具结果上的运行可以重试。
 * 统计只占一行，见 RunLine。
 */
export function RunRow({ run, canRetry }: { run: IRun; canRetry: boolean }) {
	const [error, setError] = useState<string>();
	// 用时不算只在等审批的时间；等过审批的，悬停时写出来。
	const waited = run.waitedMs >= 1000 ? `\n另等待审批 ${elapsedText(run.waitedMs)}` : '';
	const stats = runStats(run, run.endedAt === null ? undefined : run.endedAt - run.startedAt - run.waitedMs);
	const failed = run.status === 'failed';
	const retry = async () => {
		setError(undefined);
		try {
			await api('POST', `/v1/members/${run.memberId}/retry`);
		} catch (caught) {
			setError(errorMessage(caught));
		}
	};
	const label = failed ? '运行出错' : run.status === 'stopped' ? `运行已停止（${run.error ?? '已暂停'}）` : '运行结束';
	const text = `${label} · ${stats}`;
	return (
		<div title={`${text}\n${fullTime(run.endedAt ?? run.startedAt)}${waited}`} className={clsx('py-1 text-[11px]', failed ? 'text-danger' : 'text-fg-3')}>
			<RunLine text={text} failed={failed} />
			{(failed ? !!run.error : canRetry) && (
				<div className="group/copy mt-1 flex flex-wrap items-center justify-center gap-2 text-xs">
					{failed && <span className="whitespace-pre-wrap break-words">{run.error}</span>}
					{failed && run.error && <CopyButton text={run.error} className="-mx-1" />}
					{canRetry && <TextButton onClick={() => void retry()}>重试</TextButton>}
					{error && <span>重试失败：{error}</span>}
				</div>
			)}
		</div>
	);
}

/**
 * 进行中的运行，放在时间线最后：样式、位置、高度和运行结束的分隔线一样，结束时原地换成「运行结束 · …」那一行，内容不动。
 * 文字上有一道扫过的高亮，过程都收起时也能扫一眼看出还在工作。收起的审批细栏正好盖住这一行（见 TimelineView 的底部留白），
 * 靠的是它和结束那一行一样只占一行（RunLine），高度一直是 25px。
 * 用时和结束那一行一样不算等审批的时间：waiting 时停住。打开时已经在等的，从 waitStart（最早的那个待审批）算起；
 * 打开之前等过的不知道，会算进去，结束时以那一行为准。
 */
export function LiveRunRow({ run, waiting, waitStart }: { run: IRun; waiting: boolean; waitStart: number | undefined }) {
	const [now, setNow] = useState(Date.now);
	useEffect(() => {
		const timer = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, []);
	// 之前每段等审批加起来多久；since 是现在这段从什么时候开始等。
	const [wait, setWait] = useState(() => ({ waiting, since: waiting ? waitStart ?? Date.now() : 0, waited: 0 }));
	if (wait.waiting !== waiting) {
		const at = Date.now();
		setWait(waiting ? { waiting, since: at, waited: wait.waited } : { waiting, since: 0, waited: wait.waited + at - wait.since });
		// now 每秒才更新一次，可能还停在不到 1 秒前：等完时不跟着更新，算出来的用时会比停住的那个数小，往回跳。
		setNow(at);
	}
	const elapsed = Math.max(0, (wait.waiting ? wait.since : now) - run.startedAt - wait.waited);
	const text = `运行中 · ${runStats(run, elapsed)}`;
	return (
		<div title={`${text}\n开始于 ${fullTime(run.startedAt)}`} className="py-1 text-[11px] text-fg-3">
			<RunLine text={text} shimmer />
		</div>
	);
}

/** 运行的统计那一行，两边是横线。不换行：放得下时两边留横线，放不下时横线没了，只显示文字，超出的截断，悬停看全部。 */
function RunLine({ text, failed = false, shimmer = false }: { text: string; failed?: boolean; shimmer?: boolean }) {
	return (
		<div className="flex items-center gap-2">
			<div className={clsx('h-px min-w-0 flex-1', failed ? 'bg-danger/40' : 'bg-line')} />
			<span className={clsx('min-w-0 truncate', shimmer && 'shimmer-text')}>{text}</span>
			<div className={clsx('h-px min-w-0 flex-1', failed ? 'bg-danger/40' : 'bg-line')} />
		</div>
	);
}

/** 运行的统计：用时（elapsed，不算只在等审批的时间；undefined 时不写）、请求次数、token 和缓存命中率。 */
function runStats(run: IRun, elapsed: number | undefined): string {
	const cache = run.cachedTokens !== null && run.inputTokens > 0 ? ` · 缓存 ${(run.cachedTokens / run.inputTokens * 100).toFixed(1)}%` : '';
	const time = elapsed === undefined ? '' : `用时 ${elapsedText(elapsed)} · `;
	return `${time}${run.requestCount} 次请求 · 输入 ${formatTokens(run.inputTokens)}${cache} · 输出 ${formatTokens(run.outputTokens)}`;
}

function Line({ children, time, state = 'visible' }: { children: ReactNode; time: number; state?: ContextState }) {
	return (
		<div className={clsx('flex items-baseline gap-2 text-xs text-fg-3', state !== 'visible' && FADED)}>
			<span className="min-w-0">{children}</span>
			<span title={fullTime(time)} className="shrink-0">{shortTime(time)}</span>
			<ContextTag state={state} />
		</div>
	);
}

function Collapsible({ title, children, disabled = false }: { title: ReactNode; children: ReactNode; disabled?: boolean }) {
	const [open, setOpen] = useState(false);
	return (
		<div className="text-[13px]">
			<button type="button" disabled={disabled} aria-expanded={disabled ? undefined : open} onClick={() => setOpen(value => !value)} className="flex items-center gap-1 text-xs text-fg-3 hover:text-fg-2 disabled:hover:text-fg-3">
				{!disabled && <ChevronRight size={13} className={clsx('transition-transform', open && 'rotate-90')} />}
				{title}
			</button>
			{open && !disabled && <div className="mt-1 pl-4">{children}</div>}
		</div>
	);
}
