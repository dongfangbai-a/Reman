import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as Popover from '@radix-ui/react-popover';
import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArchiveRestore, ArrowDown, ChevronsDownUp, ChevronsUpDown, Ellipsis, FoldVertical, ListTodo, LoaderCircle, Pause, Play, Settings } from 'lucide-react';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type TouchEvent, type WheelEvent } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { api } from '../api/client.ts';
import { queryKeys } from '../api/keys.ts';
import { setTimelineFollowing, useContextUsage, useMemberStates, usePendingApprovals, useRuns, useStreams, useStreamText, useTasks, useTimeline } from '../api/member.ts';
import { useMembers } from '../api/queries.ts';
import type { IMember, IMemberState } from '../api/types.ts';
import { OPTIMIZING, useStep, type IStep } from '../chat/activity.tsx';
import { DropHint, useFileDrop, type IComposerHandle } from '../chat/Composer.tsx';
import { DirectoryPill } from '../chat/DirectoryPill.tsx';
import { Markdown } from '../chat/Markdown.tsx';
import { ModelPill } from '../chat/ModelPill.tsx';
import { HEADER_RIGHT } from '../layout/PanelToggles.tsx';
import { openMemberDialog } from '../layout/uiState.ts';
import { errorMessage } from '../lib/errors.ts';
import { forgetScroll, recallScroll, rememberScroll, restoreScroll, type IScrollPosition } from '../lib/scrollMemory.ts';
import { usePreferences } from '../stores.ts';
import { groupTasks } from '../tasks/sort.ts';
import { TaskRow } from '../tasks/TaskList.tsx';
import { Avatar } from '../ui/Avatar.tsx';
import { BackButton } from '../ui/BackLink.tsx';
import { Button, IconButton } from '../ui/Button.tsx';
import { MenuContent, MenuItem } from '../ui/Menu.tsx';
import { STATUS_LABELS, StatusDot } from '../ui/StatusDot.tsx';
import { TextButton } from '../ui/TextButton.tsx';
import { openTasks } from '../workbench/tabs.ts';
import { ApprovalDock } from './ApprovalDock.tsx';
import { ContextRing } from './ContextRing.tsx';
import { LiveOptimizationRow, OptimizationRow, type IRecordRetry } from './OptimizationRow.tsx';
import { ProcessBlock, SentMessage, type IBlockContext } from './ProcessBlock.tsx';
import { buildRows, reuseRows, type Row } from './rows.ts';
import { TimelineInput } from './TimelineInput.tsx';
import { ChangeNoticeRow, EventRow, ExternalEventRow, LiveRunRow, MemoryChangeRow, MessageRow, OmissionRow, OutputRow, PlanNoteRow, PruningRow, ReminderRow, RunRow, SummaryRow, UserInputRow } from './TimelineRows.tsx';

/** 往下滚到离底部这么近时接着跟着新内容滚到底。 */
const BOTTOM_SLACK = 40;
/** 离顶部这么近时加载更早的。 */
const TOP_SLACK = 120;
/** 运行刚开始、还没有输出时那一段过程的标识。 */
const LIVE_KEY = 'live';
/** 进行中的压缩记录的标识。 */
const LIVE_OPTIMIZATION_KEY = 'optimization:live';
const THINKING: IStep = { verb: '正在思考' };

/** 一个 AI 成员的时间线：成员页的中间（center）和视角页右边的时间线一栏（column）用同一个组件。 */
export function TimelineView({ memberId, mode }: { memberId: string; mode: 'center' | 'column' }) {
	const members = useMembers();
	const memberById = useMemo(() => new Map((members.data ?? []).map(member => [member.memberId, member])), [members.data]);
	const member = memberById.get(memberId);
	const states = useMemberStates();
	const state = states.data?.get(memberId);
	const composer = useRef<IComposerHandle>(null);
	// 文件拖到面板任意位置都加进底部的输入框。
	const drop = useFileDrop(files => composer.current?.addFiles(files), member?.type === 'ai' && !member.deleted);

	if (!member) return <div className="p-6 text-center text-[13px] text-fg-3">{members.isPending ? '正在加载…' : '未找到该成员'}</div>;
	if (member.type !== 'ai') return <div className="p-6 text-center text-[13px] text-fg-3">{member.name} 是真人成员，没有时间线</div>;
	if (member.purged) return <div className="p-6 text-center text-[13px] text-fg-3">{member.name} 已彻底删除，没有时间线</div>;
	return (
		<div className="relative flex h-full min-h-0 flex-col bg-page" {...drop.handlers}>
			<Header member={member} state={state} mode={mode} />
			<Body member={member} state={state} memberById={memberById} />
			{!member.deleted && <TimelineInput key={memberId} member={member} composer={composer} />}
			{drop.dragging && <DropHint />}
		</div>
	);
}

/**
 * 顶部：左边是状态，右边是操作。在成员页中间时名字后面还有模型和目录标签。
 * 设置齿轮两处都有：视角页里对话顶部的齿轮打开的是私聊对方的设置，AI 视角和真人私聊时，这里是打开这个 AI 设置的唯一地方。
 */
function Header({ member, state, mode }: { member: IMember; state: IMemberState | undefined; mode: 'center' | 'column' }) {
	const queryClient = useQueryClient();
	const [error, setError] = useState<string>();
	const status = state?.status ?? 'idle';
	const usage = useContextUsage(member.memberId, !member.deleted);
	const optimizeProblem = usage.data?.optimizeProblem ?? null;
	const openSettings = () => openMemberDialog({ kind: 'settings', memberId: member.memberId });
	const act = async (path: string) => {
		setError(undefined);
		try {
			await api('POST', `/v1/members/${member.memberId}/${path}`);
			if (path === 'restore') await queryClient.invalidateQueries({ queryKey: queryKeys.members });
		} catch (caught) {
			setError(errorMessage(caught));
		}
	};
	return (
		<header className="shrink-0 border-b border-line">
			<div className={clsx('@container flex h-12 items-center gap-2 pl-4', HEADER_RIGHT)}>
				{mode === 'center' && <BackButton to="/" />}
				<div className="relative shrink-0">
					<Avatar member={member} size={24} />
					{!member.deleted && <StatusDot status={status} className="absolute -bottom-0.5 -right-0.5 size-2 ring-2 ring-page" />}
				</div>
				<span className="min-w-0 truncate font-semibold">{member.name}</span>
				{/* 窄时（两侧栏占了地方、手机）先让出地方给名字：不写状态，头像上的圆点和下面的出错原因已经表示了。 */}
				<span className="flex shrink-0 items-center gap-1 text-xs @max-[30rem]:hidden">
					<span className={status === 'failed' && !member.deleted ? 'text-danger' : 'text-fg-3'}>{member.deleted ? '已删除' : STATUS_LABELS[status]}</span>
					{/* 切到还没取过用量的成员时先占住圆环的位置，不然取到后模型、目录标签会往右跳一下。 */}
					{!member.deleted && (usage.data || usage.isPending) && (
						<>
							<span className="text-fg-3">·</span>
							{usage.data ? <ContextRing usage={usage.data} /> : <span className="size-6 shrink-0" />}
						</>
					)}
				</span>
				{mode === 'center' && !member.deleted && <span className="flex min-w-0 @max-[36rem]:hidden"><ModelPill member={member} onOpenSettings={openSettings} /></span>}
				{mode === 'center' && !member.deleted && <DirectoryPill member={member} onOpenSettings={openSettings} />}
				<div className="flex-1" />
				{member.deleted && <Button className="shrink-0" onClick={() => void act('restore')}><ArchiveRestore size={15} />恢复</Button>}
				<div className="flex shrink-0 items-center gap-0.5">
					{!member.deleted && (member.paused
						? <IconButton label="恢复" onClick={() => void act('resume')}><Play size={16} /></IconButton>
						: <IconButton label="暂停" onClick={() => void act('pause')}><Pause size={16} /></IconButton>)}
					{!member.deleted && (
						<IconButton
							label="压缩上下文"
							title={optimizeProblem ?? '压缩上下文'}
							aria-disabled={!!optimizeProblem}
							className={clsx('@max-[30rem]:hidden', optimizeProblem && 'cursor-default opacity-40 hover:bg-transparent hover:text-fg-2')}
							onClick={() => optimizeProblem || void act('optimize')}
						>
							<FoldVertical size={16} />
						</IconButton>
					)}
					<TasksButton memberId={member.memberId} />
					<ExpandButton className="@max-[30rem]:hidden" />
					<IconButton label="成员设置" className="@max-[30rem]:hidden" onClick={openSettings}><Settings size={16} /></IconButton>
					<NarrowMenu
						optimize={member.deleted ? undefined : { problem: optimizeProblem, run: () => void act('optimize') }}
						onOpenSettings={openSettings}
					/>
				</div>
			</div>
			{(status === 'failed' || status === 'interrupted') && state?.error && (
				<div className={clsx('flex items-start gap-2 border-t px-4 py-2 text-[13px]', status === 'failed' ? 'border-danger/30 bg-danger-soft text-danger' : 'border-line bg-hover text-fg-2')}>
					<span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{STATUS_LABELS[status]}：{state.error}</span>
					<Button className="shrink-0" onClick={() => void act('retry')}>重试</Button>
				</div>
			)}
			{error && <div className="border-t border-line px-4 py-1.5 text-xs text-danger">操作失败：{error}</div>}
		</header>
	);
}

/** 一次展开或收起全部过程，记在浏览器里。 */
function ExpandButton({ className }: { className?: string }) {
	const expand = usePreferences(preferences => preferences.timelineExpandProcess);
	const set = usePreferences(preferences => preferences.set);
	return (
		<IconButton label={expand ? '收起全部过程' : '展开全部过程'} className={className} onClick={() => set({ timelineExpandProcess: !expand })}>
			{expand ? <ChevronsDownUp size={16} /> : <ChevronsUpDown size={16} />}
		</IconButton>
	);
}

/** 顶部一行窄时，压缩上下文、展开或收起全部过程、成员设置收进「⋯」菜单。 */
function NarrowMenu({ optimize, onOpenSettings }: { optimize: { problem: string | null; run: () => void } | undefined; onOpenSettings: () => void }) {
	const expand = usePreferences(preferences => preferences.timelineExpandProcess);
	const set = usePreferences(preferences => preferences.set);
	return (
		<DropdownMenu.Root modal={false}>
			<span className="hidden @max-[30rem]:flex">
				<DropdownMenu.Trigger asChild>
					<IconButton label="更多操作"><Ellipsis size={16} /></IconButton>
				</DropdownMenu.Trigger>
			</span>
			<MenuContent align="end">
				{optimize && (
					<MenuItem disabled={!!optimize.problem} title={optimize.problem ?? undefined} className="data-[disabled]:opacity-40" onSelect={optimize.run}>
						<FoldVertical size={15} />压缩上下文
					</MenuItem>
				)}
				<MenuItem onSelect={() => set({ timelineExpandProcess: !expand })}>
					{expand ? <ChevronsDownUp size={15} /> : <ChevronsUpDown size={15} />}{expand ? '收起全部过程' : '展开全部过程'}
				</MenuItem>
				<MenuItem onSelect={onOpenSettings}><Settings size={15} />成员设置</MenuItem>
			</MenuContent>
		</DropdownMenu.Root>
	);
}

/** 卡片里列几个已结束的：卡片是扫一眼用的，历史放进去只会挡住时间线。 */
const CARD_FINISHED_SHOWN = 2;

/** 后台任务：图标上的角标是运行中的个数；点开是一张小卡片，扫一眼用，要看输出放到工作台里。 */
function TasksButton({ memberId }: { memberId: string }) {
	const tasks = useTasks(memberId);
	const { running, finished } = groupTasks(tasks.data ?? []);
	const shown = [...running, ...finished.slice(0, CARD_FINISHED_SHOWN)];
	const hidden = finished.length - Math.min(finished.length, CARD_FINISHED_SHOWN);
	const [open, setOpen] = useState(false);
	const show = (taskId?: string) => {
		setOpen(false);
		openTasks(memberId, taskId);
	};
	return (
		<Popover.Root open={open} onOpenChange={setOpen}>
			<Popover.Trigger asChild>
				<IconButton label="后台任务" className="relative">
					<ListTodo size={16} />
					{running.length > 0 && <span className="absolute right-0.5 top-0.5 min-w-3.5 rounded-full bg-accent px-0.5 text-[10px] leading-3.5 text-on-accent">{running.length}</span>}
				</IconButton>
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content align="end" sideOffset={6} className="z-50 w-80 rounded-lg border border-line bg-raised p-1 shadow-lg">
					<div className="flex items-center px-2 pb-1 pt-1.5 text-xs text-fg-3">
						<span className="flex-1">后台任务</span>
						<TextButton onClick={() => show()}>在工作台显示</TextButton>
					</div>
					<div className="max-h-80 overflow-y-auto">
						{tasks.data?.length === 0 && <div className="px-2 py-3 text-center text-[13px] text-fg-3">暂无后台任务</div>}
						{/* 卡片里的行不展开：地方小，输出看不清；点一行在工作台打开并展开这一个。悬停看完整命令。 */}
						{shown.map(task => <TaskRow key={task.taskId} task={task} fullCommand onOpen={() => show(task.taskId)} />)}
						{hidden > 0 && <button type="button" onClick={() => show()} className="w-full px-2 py-1.5 text-left text-xs text-fg-3 hover:text-fg-2">另外 {hidden} 个已结束的任务</button>}
					</div>
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}

function Body({ member, state, memberById }: { member: IMember; state: IMemberState | undefined; memberById: Map<string, IMember> }) {
	const memberId = member.memberId;
	const queryClient = useQueryClient();
	const timeline = useTimeline(memberId);
	/** 往上翻着看历史时后面新来的太多，没有接着取：末尾不接运行中的内容，往下滚到末尾时接着取。 */
	const hasNewer = timeline.data?.hasNewer ?? false;
	const runs = useRuns(memberId);
	const tasks = useTasks(memberId);
	const approvals = usePendingApprovals();
	// 只订阅流式输出的样子，内容由显示它的组件订阅：每来一段增量不重画整条时间线。
	const stream = useStreams(useShallow(store => {
		const current = store.streams[memberId];
		return current && { requestId: current.requestId, optimizingSince: current.optimizingSince, hasText: current.text !== '', hasReasoning: current.reasoning !== '' };
	}));
	const entries = timeline.data?.items ?? [];

	// 内容没变的行沿用上一次的对象，行组件跳过重画：新增一条、成员状态变时只画变了的几行，往上翻页只画新的一页。
	const previousRows = useRef<Row[]>([]);
	const rows = useMemo(() => reuseRows(previousRows.current, buildRows(entries, runs.data ?? [], timeline.data ? !timeline.data.hasOlder : false, hasNewer)), [entries, runs.data, timeline.data, hasNewer]);
	useLayoutEffect(() => {
		previousRows.current = rows;
	}, [rows]);
	const pending = useMemo(() => (approvals.data ?? []).filter(approval => approval.memberId === memberId), [approvals.data, memberId]);
	/** 底部浮着的审批卡片多高：「回到底部」放在它上面。 */
	const [dockHeight, setDockHeight] = useState(0);
	const taskByCall = useMemo(() => new Map((tasks.data ?? []).map(task => [`${task.runId}:${task.callId}`, task])), [tasks.data]);
	const runningRunId = runs.data?.find(run => run.status === 'running')?.runId;
	/** 进行中的回复运行：时间线最后一行写「运行中」和统计，结束时原地换成运行结束的分隔线。 */
	const liveRun = member.deleted || hasNewer ? undefined : runs.data?.find(run => run.status === 'running' && run.kind === 'response');
	const latestFailed = state?.status === 'failed' || state?.status === 'interrupted' ? runs.data?.find(run => run.kind === 'response' && run.status !== 'running')?.runId : undefined;
	// 压缩请求的思考在压缩记录里，不算在过程里。
	const visibleStream = stream && !hasNewer && stream.optimizingSince === null && !entries.some(entry => 'requestId' in entry && entry.requestId === stream.requestId) ? stream : undefined;
	const optimizing = state?.activity?.phase === 'optimizing' && !hasNewer ? state.activity : undefined;
	const optimizationStream = optimizing && stream?.optimizingSince === optimizing.since ? stream : undefined;
	// 最新一条压缩记录出错时就地重试：等于手动压缩一次，现在不能手动压缩时变灰（和顶部的按钮一样）。
	const usage = useContextUsage(memberId, !member.deleted);
	const latestRecord = rows.findLast(row => row.kind === 'optimization')?.key;
	const retryRecord = useMemo(() => ({
		problem: usage.data?.optimizeProblem ?? null,
		run: () => api('POST', `/v1/members/${memberId}/optimize`),
	}), [usage.data?.optimizeProblem, memberId]);
	const [openedThinking] = useState(() => new Set<number>());
	const blockContext = useMemo<IBlockContext>(() => ({ memberId, approvals: pending, taskByCall, runningRunId, openedThinking }), [memberId, pending, taskByCall, runningRunId, openedThinking]);

	// 运行中，最后一段过程后面写成员正在做什么；最后一行不是过程时（运行刚开始）另起一段。整理上下文时不写在这里，末尾是进行中的压缩记录；
	// 压缩完换成下一步之前，写的内容还停在「正在整理上下文」，这时接下来就是请求模型。
	const step = useStep(memberId, state);
	const live = optimizing || hasNewer ? undefined : step?.verb === OPTIMIZING.verb ? THINKING : step ?? (visibleStream ? THINKING : undefined);
	const lastRow = rows.at(-1);
	const liveKey = live ? lastRow?.kind === 'process' ? lastRow.key : LIVE_KEY : undefined;
	// 每段过程默认跟着「展开全部过程」，单独点过的记下来；改「展开全部过程」时都重新跟着它。
	const expandAll = usePreferences(preferences => preferences.timelineExpandProcess);
	const [opened, setOpened] = useState<ReadonlyMap<string, boolean>>(() => new Map());
	useEffect(() => setOpened(new Map()), [expandAll]);
	const isOpen = (key: string) => opened.get(key) ?? (key === liveKey ? opened.get(LIVE_KEY) : undefined) ?? expandAll;
	// 点开、收起的回调不跟着渲染变，行组件才能跳过重画；按点的那一刻的展开状态取反。
	const isOpenNow = useRef(isOpen);
	useLayoutEffect(() => {
		isOpenNow.current = isOpen;
	});
	const toggle = useCallback((key: string) => setOpened(current => new Map(current).set(key, !isOpenNow.current(key))), []);
	// 运行刚开始时点开的那段有了输出、变成正式的一段：展开状态记到它名下。
	useEffect(() => {
		if (!liveKey || liveKey === LIVE_KEY || !opened.has(LIVE_KEY)) return;
		setOpened(current => {
			const next = new Map(current);
			if (!next.has(liveKey)) next.set(liveKey, current.get(LIVE_KEY)!);
			next.delete(LIVE_KEY);
			return next;
		});
	}, [liveKey, opened]);
	// 压缩记录默认收起，不跟着「展开全部过程」。进行中点开了的，换成正式的记录（最新的一条变了）时照样展开。
	const [openRecords, setOpenRecords] = useState<ReadonlySet<string>>(() => new Set());
	const toggleRecord = useCallback((key: string) => setOpenRecords(current => {
		const next = new Set(current);
		if (!next.delete(key)) next.add(key);
		return next;
	}), []);
	const recordBase = useRef(latestRecord);
	useEffect(() => {
		if (latestRecord === recordBase.current) return;
		recordBase.current = latestRecord;
		if (!latestRecord) return;
		setOpenRecords(current => {
			if (!current.has(LIVE_OPTIMIZATION_KEY)) return current;
			const next = new Set(current);
			next.delete(LIVE_OPTIMIZATION_KEY);
			return next.add(latestRecord);
		});
	}, [latestRecord]);

	const scroller = useRef<HTMLDivElement>(null);
	const content = useRef<HTMLDivElement>(null);
	// 切走时不在底部的，回来时停在原来看到的位置；面板和整页共用。
	const memoryKey = `timeline|${memberId}`;
	const [saved] = useState(() => recallScroll(memoryKey));
	/** 还没恢复到的位置。 */
	const restoring = useRef<IScrollPosition | undefined>(saved);
	/** 是否跟着新内容滚到底。 */
	const following = useRef(saved === undefined);
	/** 上一次滚动事件时的位置，用来看往哪滚。 */
	const lastTop = useRef(0);
	const touchY = useRef<number | undefined>(undefined);
	/**
	 * 加载更早的内容前的滚动位置和高度，加载后据此把视野放回去。
	 * 加载后的头两帧布局还会变（行先按条渲染、再并成过程块，高度上下跳），所以等布局稳定了再算。
	 */
	const anchor = useRef<{ top: number; height: number } | undefined>(undefined);
	/** 正在把视野放回加载前的位置：这期间的高度和位置都不作数，不判断在不在底部、不跟着滚到底。 */
	const settling = useRef(false);
	const [showJump, setShowJump] = useState(false);
	const [loadingOlder, setLoadingOlder] = useState(false);
	const [loadingNewer, setLoadingNewer] = useState(false);
	const loadingNewerNow = useRef(false);
	const hasNewerNow = useRef(hasNewer);
	hasNewerNow.current = hasNewer;

	// 已经在最底下时不再写位置：屏幕缩放不是整数时，页面算的最底下和浏览器平滑滚动算的差不到一个像素，
	// 在底部接着滚轮时每来一段输出都写一次，两边来回拉，内容上下抖。
	const scrollToBottom = () => {
		const element = scroller.current;
		if (element && !atBottom(element)) element.scrollTop = element.scrollHeight;
		// 自己动了 scrollTop 也要记下来：不然用户往上滚的第一次会被当成没动过（lastTop 还是打开时的值），
		// following 不会变，加载完更早的内容又被拉回底部。
		if (element) lastTop.current = element.scrollTop;
	};
	/** 不跟着时显示「回到底部」，接着跟时忘掉记下的位置。跟不跟也记给时间线的数据：跟着时去掉太早的，不跟着时限制接上多少新来的。 */
	const setFollowing = (value: boolean) => {
		following.current = value;
		setShowJump(!value);
		if (value) forgetScroll(memoryKey);
		setTimelineFollowing(queryClient, memberId, value);
	};
	/** 到了已加载的最底下：后面还有没取的就接着取，不然接着跟。 */
	const reachedBottom = () => {
		if (hasNewerNow.current) void loadNewer();
		else setFollowing(true);
	};
	useLayoutEffect(() => {
		const element = scroller.current;
		if (!element) return;
		if (restoring.current) {
			// 运行的行也要在，等两份数据都到了再定位；位置那一段已经不在缓存里时回到底部。
			if (!timeline.data || !runs.data) return;
			if (restoreScroll(element, restoring.current)) {
				setShowJump(true);
				lastTop.current = element.scrollTop;
			} else {
				setFollowing(true);
				scrollToBottom();
			}
			restoring.current = undefined;
			return;
		}
		if (anchor.current !== undefined) {
			// 刚加载完更早的内容：等两帧让布局稳定（行会先按条渲染、再并成过程块），再按高度差把视野放回去。
			settling.current = true;
			const { top, height } = anchor.current;
			requestAnimationFrame(() => requestAnimationFrame(() => {
				anchor.current = undefined;
				element.scrollTop = top + (element.scrollHeight - height);
				lastTop.current = element.scrollTop;
				settling.current = false;
			}));
		} else if (following.current) {
			scrollToBottom();
		}
	}, [rows, visibleStream, optimizationStream, optimizing]);
	// 内容或面板的高度变了：跟着时滚到底。不跟着时只有真的到了最底下才接着跟（如折叠后内容放得下了，不会有滚动事件），内容变高不算回到底部。
	useEffect(() => {
		const element = scroller.current;
		if (!content.current || !element) return;
		const observer = new ResizeObserver(() => {
			if (restoring.current) return;
			if (settling.current) return;
			if (following.current) scrollToBottom();
			else if (atBottom(element)) reachedBottom();
			else setShowJump(true);
		});
		observer.observe(content.current);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);
	useEffect(() => {
		const element = scroller.current;
		if (element && !restoring.current && timeline.data?.hasOlder && element.scrollHeight <= element.clientHeight) void loadOlder();
	});

	useMarkViewed(memberId, entries.at(-1)?.itemId, !showJump && !hasNewer);

	const loadOlder = async () => {
		if (loadingOlder || !timeline.data?.hasOlder || !scroller.current) return;
		setLoadingOlder(true);
		anchor.current = { top: scroller.current.scrollTop, height: scroller.current.scrollHeight };
		try {
			await timeline.loadOlder();
		} catch {
			anchor.current = undefined;
		} finally {
			setLoadingOlder(false);
		}
	};
	const loadNewer = async () => {
		if (loadingNewerNow.current || !hasNewerNow.current) return;
		loadingNewerNow.current = true;
		setLoadingNewer(true);
		try {
			await timeline.loadNewer();
		} finally {
			loadingNewerNow.current = false;
			setLoadingNewer(false);
		}
	};
	// 点开某一项是要看它的内容：不再跟着滚到底，标题留在原处、内容往下展开，新内容来了也不把它挤上去。
	// 展开后超出时显示「回到底部」；滚到底或点「回到底部」后接着跟。
	const onClickCapture = (event: MouseEvent) => {
		if (event.target instanceof Element && event.target.closest('[aria-expanded="false"]')) {
			following.current = false;
			setTimelineFollowing(queryClient, memberId, false);
		}
	};
	// 按往哪滚判断跟不跟：往上滚一点就不跟，往下滚回底部附近接着跟。只看离底部多远的话，平滑滚动刚挪几像素，下一段输出就把它拉回底部了。
	const onScroll = () => {
		const element = scroller.current!;
		if (restoring.current) return;
		if (settling.current) {
			lastTop.current = element.scrollTop;
			return;
		}
		const top = element.scrollTop;
		const bottom = atBottom(element);
		// 折叠时浏览器把位置往上收，这时还在最底下，不算往上滚。
		if (top < lastTop.current && !bottom) setFollowing(false);
		else if ((top > lastTop.current && distanceToBottom(element) < BOTTOM_SLACK) || bottom) reachedBottom();
		lastTop.current = top;
		if (!following.current) rememberScroll(memoryKey, element);
		if (top < TOP_SLACK) void loadOlder();
	};
	// 滚轮、触控板往上时浏览器还没开始滚就不跟了，免得滚动动画被下一段输出打断。
	const onWheel = (event: WheelEvent) => {
		const element = scroller.current!;
		if (event.ctrlKey || restoring.current || element.scrollHeight <= element.clientHeight) return;
		if (event.deltaY < 0) {
			anchor.current = undefined;
			settling.current = false;
			setFollowing(false);
		}
		else if (event.deltaY > 0 && distanceToBottom(element) < BOTTOM_SLACK) reachedBottom();
	};
	// 手指往下拖是往上看。
	const onTouchMove = (event: TouchEvent) => {
		const y = event.touches[0]?.clientY;
		const element = scroller.current!;
		if (y !== undefined && touchY.current !== undefined && y > touchY.current && element.scrollHeight > element.clientHeight) {
			anchor.current = undefined;
			settling.current = false;
			setFollowing(false);
		}
		touchY.current = y;
	};

	return (
		<div className="relative min-h-0 flex-1">
			<div
				ref={scroller}
				data-timeline-scroller
				onScroll={onScroll}
				onWheel={onWheel}
				onTouchStart={event => { touchY.current = event.touches[0]?.clientY; }}
				onTouchMove={onTouchMove}
				// 自成一层：展开的标题停在顶部时的 z-index 只在里面比，不会盖住下面的「回到底部」。
				className="isolate h-full overflow-y-auto [overflow-anchor:none]"
			>
				<div
					ref={content}
					onClickCapture={onClickCapture}
					// 底部留白 7px：运行中最后一行是「运行中」那一行（25px 高），收起的审批细栏（32px）正好盖住它和留白，不碰前面的内容，也不用另外留空。
					className="center-column flex min-h-full flex-col justify-end px-4 pb-[7px] pt-2"
				>
					{timeline.isPending && <div className="py-8 text-center text-[13px] text-fg-3">正在加载…</div>}
					{timeline.isError && (
						<div className="py-8 text-center text-[13px] text-danger">
							加载失败：{timeline.error.message} <button type="button" className="underline" onClick={() => void timeline.refetch()}>重试</button>
						</div>
					)}
					{timeline.data?.hasOlder && (
						<div className="mb-3 flex justify-center text-fg-3">{loadingOlder ? <LoaderCircle size={16} className="animate-spin" /> : <span className="text-xs">向上滚动加载更早的内容</span>}</div>
					)}
					{timeline.data && entries.length === 0 && !visibleStream && <div className="py-8 text-center text-[13px] text-fg-3">暂无内容</div>}
					{rows.map((row, index) => (
						<TimelineRow
							key={row.key}
							row={row}
							className={rowGap(row, rows[index - 1])}
							open={row.kind === 'process' ? isOpen(row.key) : row.kind === 'optimization' && openRecords.has(row.key)}
							onToggle={row.kind === 'optimization' ? toggleRecord : toggle}
							live={row.key === liveKey ? live : undefined}
							streamRequestId={row.key === liveKey ? visibleStream?.requestId : undefined}
							context={blockContext}
							member={member}
							memberById={memberById}
							canRetry={row.kind === 'run' && row.run.runId === latestFailed}
							retry={!member.deleted && row.kind === 'optimization' && row.key === latestRecord && row.entry.optimization.status === 'failed' ? retryRecord : undefined}
						/>
					))}
					{liveKey === LIVE_KEY && (
						<div key={LIVE_KEY} className={gapAbove('process', lastRow?.kind)}>
							<ProcessBlock steps={[]} context={blockContext} open={isOpen(LIVE_KEY)} onToggle={() => toggle(LIVE_KEY)} live={live} streamRequestId={visibleStream?.requestId} />
						</div>
					)}
					{optimizing && (
						<div key={LIVE_OPTIMIZATION_KEY} className={lastRow?.kind === 'optimization' ? 'mt-1.5' : gapAbove('optimization', lastRow?.kind)}>
							<LiveOptimizationRow
								request={optimizing.optimizationRequest}
								memberId={memberId}
								streamRequestId={optimizationStream?.hasReasoning ? optimizationStream.requestId : undefined}
								open={openRecords.has(LIVE_OPTIMIZATION_KEY)}
								onToggle={() => toggleRecord(LIVE_OPTIMIZATION_KEY)}
								openedThinking={openedThinking}
							/>
						</div>
					)}
					{visibleStream?.hasText && <div className={gapAbove('output', 'process')}><StreamText memberId={memberId} requestId={visibleStream.requestId} /></div>}
					{hasNewer && (
						<div className="mt-3 flex justify-center text-fg-3">{loadingNewer ? <LoaderCircle size={16} className="animate-spin" /> : <span className="text-xs">向下滚动加载更新的内容</span>}</div>
					)}
					{liveRun && (
						// 和结束后那一行的间距一样算，换过去时位置不变。
						<div key={`live-run:${liveRun.runId}`} className={gapAbove('run', visibleStream?.hasText ? 'output' : optimizing ? 'optimization' : liveKey === LIVE_KEY ? 'process' : lastRow?.kind)}>
							<LiveRunRow
								run={liveRun}
								waiting={state?.status === 'waiting_approval'}
								waitStart={pending.length > 0 ? Math.min(...pending.map(approval => approval.createdAt)) : undefined}
							/>
						</div>
					)}
				</div>
			</div>
			{!member.deleted && <ApprovalDock memberName={member.name} approvals={pending} onHeight={setDockHeight} />}
			{(showJump || hasNewer) && (
				<button
					type="button"
					onClick={async () => {
						// 后面还有没取的：和第一次打开一样只取最新一页。
						if (hasNewerNow.current) await timeline.backToLatest();
						setFollowing(true);
						scrollToBottom();
					}}
					style={{ bottom: dockHeight + 12 }}
					className="absolute right-4 z-10 flex items-center gap-1 rounded-full border border-line bg-raised px-3 py-1.5 text-xs shadow-md hover:bg-hover-layer"
				>
					<ArrowDown size={14} />回到底部
				</button>
			)}
		</div>
	);
}

/**
 * 时间线的一行。行的对象和其他属性都没变时跳过重画（排行时内容没变的行沿用上一次的对象），
 * 所以属性里只放这一行要的：展开状态是布尔，回调不跟着渲染变，运行中的那段才有 live、streamRequestId。
 */
const TimelineRow = memo(function TimelineRow({ row, className, open, onToggle, live, streamRequestId, context, member, memberById, canRetry, retry }: {
	row: Row;
	className: string | undefined;
	open: boolean;
	onToggle: (key: string) => void;
	live: IStep | undefined;
	streamRequestId: number | undefined;
	context: IBlockContext;
	member: IMember;
	memberById: Map<string, IMember>;
	canRetry: boolean;
	retry: IRecordRetry | undefined;
}) {
	const content = (() => {
		switch (row.kind) {
			case 'run':
				return <RunRow run={row.run} canRetry={canRetry} />;
			case 'process':
				return <ProcessBlock steps={row.steps} context={context} open={open} onToggle={() => onToggle(row.key)} live={live} streamRequestId={streamRequestId} />;
			case 'sent':
				return <SentMessage step={row} context={context} />;
			case 'output':
				return <OutputRow entry={row.entry} />;
			case 'optimization':
				return <OptimizationRow row={row} open={open} onToggle={() => onToggle(row.key)} openedThinking={context.openedThinking} retry={retry} />;
			case 'entry':
				return <EntryRow entry={row.entry} member={member} memberById={memberById} />;
		}
	})();
	return <div data-scroll-id={row.key} className={className}>{content}</div>;
});

/** 正在生成的文字：自己订阅内容，每来一段只重画这一块。 */
function StreamText({ memberId, requestId }: { memberId: string; requestId: number }) {
	return <Markdown text={useStreamText(memberId, requestId, 'text')} />;
}

/** 打开着、到了底部、页面在前台时，算使用者看到了最新的那条：成员页那一行的小圆点据此消失。 */
function useMarkViewed(memberId: string, lastItemId: number | undefined, atBottom: boolean): void {
	const marked = useRef(0);
	const [visible, setVisible] = useState(() => document.visibilityState === 'visible');
	useEffect(() => {
		const onChange = () => setVisible(document.visibilityState === 'visible');
		document.addEventListener('visibilitychange', onChange);
		return () => document.removeEventListener('visibilitychange', onChange);
	}, []);
	useEffect(() => {
		if (!visible || !atBottom || lastItemId === undefined || lastItemId <= marked.current) return;
		// 稍等一下：一直有新内容时不用每条都记。
		const timer = window.setTimeout(() => {
			marked.current = lastItemId;
			api('PUT', `/v1/members/${memberId}/viewed`, { itemId: lastItemId }).catch(() => {
				marked.current = 0;
			});
		}, 500);
		return () => window.clearTimeout(timer);
	}, [memberId, lastItemId, atBottom, visible]);
}

function distanceToBottom(element: HTMLElement): number {
	return element.scrollHeight - element.scrollTop - element.clientHeight;
}

/** 是否在最底下：比内容和滚动区底边的实际位置。scrollHeight、clientHeight 是取整的，屏幕缩放不是整数时人在底部也可能差出 1px 多。 */
function atBottom(element: HTMLElement): boolean {
	const content = element.firstElementChild;
	return !content || content.getBoundingClientRect().bottom - element.getBoundingClientRect().bottom <= 1;
}

/** 和上一项的间距：过程紧挨着上面一项，和下面一项稍远（都算上过程行自己上下 2px 的留白），其他各项之间 12px。 */
function gapAbove(kind: Row['kind'], previous: Row['kind'] | undefined): string | undefined {
	if (!previous) return undefined;
	if (kind === 'process') return 'mt-0.5';
	if (previous === 'process') return 'mt-1.5';
	return 'mt-3';
}

/**
 * 连着的几条压缩记录（连续压了几轮）、单独显示的几张压缩卡片（「整理上下文时更新了记忆」「整理了上下文」「整理上下文时删掉了内容」「整理上下文后放回了计划」，
 * 所属的压缩记录在还没加载的更早一页时）挨得近一些，6px；其他按 gapAbove。
 */
function rowGap(row: Row, previous: Row | undefined): string | undefined {
	if (previous && row.kind === 'optimization' && previous.kind === 'optimization') return 'mt-1.5';
	return previous && isCompactionCard(row) && isCompactionCard(previous) ? 'mt-1.5' : gapAbove(row.kind, previous?.kind);
}

function isCompactionCard(row: Row): boolean {
	return row.kind === 'entry' && (row.entry.kind === 'summary' || row.entry.kind === 'memory_change' || row.entry.kind === 'pruning' || row.entry.kind === 'plan');
}

function EntryRow({ entry, member, memberById }: { entry: Extract<Row, { kind: 'entry' }>['entry']; member: IMember; memberById: Map<string, IMember> }) {
	switch (entry.kind) {
		case 'message': return <MessageRow entry={entry} owner={member} memberById={memberById} />;
		case 'user_input': return <UserInputRow entry={entry} member={member} />;
		case 'reminder': return <ReminderRow entry={entry} />;
		case 'summary': return <SummaryRow entry={entry} />;
		case 'omission': return <OmissionRow entry={entry} />;
		case 'memory_change': return <MemoryChangeRow entry={entry} />;
		case 'pruning': return <PruningRow entry={entry} />;
		case 'plan': return <PlanNoteRow entry={entry} />;
		case 'change_notice': return <ChangeNoticeRow entry={entry} />;
		case 'external_event': return <ExternalEventRow entry={entry} />;
		default: return <EventRow entry={entry} owner={member} memberById={memberById} />;
	}
}
