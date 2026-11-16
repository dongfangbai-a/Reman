import clsx from 'clsx';
import { Ban, Check, LoaderCircle, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { api } from '../api/client.ts';
import { useCallOutput, useTasks } from '../api/member.ts';
import type { ITask } from '../api/types.ts';
import { errorMessage } from '../lib/errors.ts';
import { compactDuration, fullTime } from '../lib/format.ts';
import { isSelectingText } from '../lib/selection.ts';
import { useNow } from '../lib/useNow.ts';
import { CallSummary, cancelTitle } from '../timeline/ToolCard.tsx';
import { CenteredMessage } from '../ui/CenteredMessage.tsx';
import { CopyButton } from '../ui/CopyButton.tsx';
import { FollowOutput } from '../ui/FollowOutput.tsx';
import { TextButton } from '../ui/TextButton.tsx';
import { useTaskFocus } from '../workbench/tabs.ts';
import { groupTasks } from './sort.ts';

/** 「已结束」默认列这么多个，其余的点了「显示全部」再列。 */
const FINISHED_SHOWN = 5;

/** 行首的状态图标。已结束的用次要颜色，和运行中的分得开。 */
function StatusIcon({ task }: { task: ITask }) {
	switch (task.status) {
		case 'running':
			return <LoaderCircle size={12} className="shrink-0 animate-spin text-accent" aria-label="运行中" />;
		case 'failed':
			return <TriangleAlert size={12} className="shrink-0 text-danger" aria-label="出错" />;
		case 'completed':
			return <Check size={12} className="shrink-0 text-fg-3" aria-label="已完成" />;
		default:
			return <Ban size={12} className="shrink-0 text-fg-3" aria-label={task.status === 'cancelled' ? '已取消' : '已中断'} />;
	}
}

/**
 * 一个后台任务，一行：行首状态图标，接着是做什么，行尾是耗时，运行中的最右边是「取消」。
 * 做什么单行显示、放不下时截断，完整的在展开区里看；工作台里点开就能看，不再悬停提示。
 * 时间线顶部的卡片里的行不展开，fullCommand 打开，悬停看完整命令。已结束的整行用次要颜色。
 * 展开时头部这一行底色深一档（外面还有一条强调色竖线）：连着展开几个时，靠它分得清哪个头是哪个。
 */
export function TaskRow({ task, open, fullCommand, onOpen }: { task: ITask; open?: boolean; fullCommand?: boolean; onOpen: () => void }) {
	const [error, setError] = useState<string>();
	const [busy, setBusy] = useState(false);
	const running = task.status === 'running';
	const cancel = async () => {
		setBusy(true);
		setError(undefined);
		try {
			await api('POST', `/v1/tasks/${task.taskId}/cancel`);
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	};
	// 整行都能点，时间、按钮旁边的空白处也算。内容是按钮，键盘也能操作，点击冒泡到这里。
	// 拖着选文字（如复制任务编号）松开时不算。
	const onRowClick = (event: MouseEvent<HTMLDivElement>) => {
		if (isSelectingText(event)) return;
		onOpen();
	};
	return (
		<>
			<div onClick={onRowClick} className={clsx('flex h-[30px] cursor-pointer items-center gap-2 px-2 text-[13px]', running ? 'text-fg' : 'text-fg-2', open ? 'bg-selected' : 'hover:bg-hover')}>
				<button type="button" aria-expanded={open} title={fullCommand ? commandText(task) : undefined} className="flex min-w-0 flex-1 items-center gap-2 text-left">
					<StatusIcon task={task} />
					<span className="min-w-0 flex-1 truncate"><CallSummary memberId={task.memberId} name={task.toolName} args={task.arguments} /></span>
				</button>
				{task.status === 'failed' && <span className="shrink-0 rounded bg-danger/10 px-1 text-[11px] leading-4 text-danger">出错</span>}
				<span className="shrink-0"><Elapsed task={task} /></span>
				{/* 放在最右边，离文字远：误点了就把还要跑的任务停了。点它（包括正在取消、点了没反应时）不展开这一行。 */}
				{running && <span className="shrink-0 pl-2" onClick={event => event.stopPropagation()}><TextButton problem={busy && '正在取消'} title={cancelTitle(task)} onClick={() => void cancel()}>取消</TextButton></span>}
			</div>
			{/* 取消失败的原因单独一行，不常显，行高才一致；文字和上面那一行对齐（图标 12 + 间距 8）。 */}
			{error && <div className="px-2 pb-1 pl-[28px] text-xs text-danger">取消失败：{error}</div>}
		</>
	);
}

/** 耗时：运行中的是到现在多久，每秒更新；已结束的是一共用了多久。悬停看开始的完整时间。 */
function Elapsed({ task }: { task: ITask }) {
	const running = task.status === 'running';
	const now = useNow(running);
	const end = running ? now : task.endedAt ?? task.startedAt;
	return <span className="tabular-nums" title={`开始于 ${fullTime(task.startedAt)}`}>{compactDuration(end - task.startedAt)}</span>;
}

/** 悬停看完整命令。其他的工具那行本来就是几句摘要（如「读取终端 T_xxx」），完整的参数在展开区里看。 */
function commandText(task: ITask): string | undefined {
	const args = task.arguments as Record<string, unknown> | null;
	return task.toolName === 'shell' && typeof args?.['command'] === 'string' ? args['command'] : undefined;
}

/** 工作台里成员的后台任务：分「运行中」「已结束」两组，一个任务一行，点开看输出，可以同时展开几个。 */
export function TasksView({ memberId }: { memberId: string }) {
	const tasks = useTasks(memberId);
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
	const [showAll, setShowAll] = useState(false);
	const focus = useTaskFocus();
	const list = useRef<HTMLDivElement>(null);
	/** 已经处理过的「展开这一个」请求：每次取到新数据都滚一次，会把人从别处拽回来。 */
	const handled = useRef<string | undefined>(undefined);

	// 从时间线的卡片点了某个任务：展开它，滚过去。它可能在「已结束」默认收起的那几个后面，先全部列出来。
	// 数据还没到时先不做：任务列表还没出来，等了也找不到它。
	useEffect(() => {
		if (!focus.taskId || !tasks.data) return;
		const key = `${focus.taskId}:${focus.nonce}`;
		if (handled.current === key) return;
		handled.current = key;
		const finished = tasks.data.filter(task => task.status !== 'running');
		if (finished.slice(FINISHED_SHOWN).some(task => task.taskId === focus.taskId)) setShowAll(true);
		setExpanded(previous => new Set(previous).add(focus.taskId!));
		requestAnimationFrame(() => list.current?.querySelector(`[data-task="${focus.taskId}"]`)?.scrollIntoView({ block: 'nearest' }));
	}, [focus, tasks.data]);

	if (tasks.isError) return <div className="px-4 py-3 text-[13px] text-danger">加载后台任务失败：{tasks.error.message}</div>;
	if (!tasks.data) return null;
	if (tasks.data.length === 0) return <div className="min-h-0 flex-1"><CenteredMessage title="暂无后台任务" detail="执行时间较长的工具调用会转为后台任务，并显示在此处" /></div>;
	const toggle = (taskId: string) => setExpanded(previous => {
		const next = new Set(previous);
		if (!next.delete(taskId)) next.add(taskId);
		return next;
	});
	const { running, finished } = groupTasks(tasks.data);
	const shown = showAll ? finished : finished.slice(0, FINISHED_SHOWN);
	const rows = (items: readonly ITask[]) => items.map(task => {
		const open = expanded.has(task.taskId);
		return (
			<div key={task.taskId} data-task={task.taskId} className={clsx('border-l-2', open ? 'border-accent bg-hover' : 'border-transparent')}>
				<TaskRow task={task} open={open} onOpen={() => toggle(task.taskId)} />
				{open && <TaskDetail task={task} />}
			</div>
		);
	});
	return (
		<div ref={list} className="min-h-0 flex-1 overflow-y-auto pb-2">
			{running.length > 0 && (
				<>
					<GroupHeader label="运行中" count={running.length} />
					{rows(running)}
				</>
			)}
			{finished.length > 0 && (
				<>
					<GroupHeader label="已结束" count={finished.length}>
						{finished.length > FINISHED_SHOWN && <TextButton onClick={() => setShowAll(value => !value)}>{showAll ? '收起' : '显示全部'}</TextButton>}
					</GroupHeader>
					{rows(shown)}
				</>
			)}
		</div>
	);
}

/**
 * 一组的标题：名字和个数，右边放这一组的操作。哪组没有任务就不显示那一组。
 * 左边空出 2px 边框的位置，文字和下面每一行的内容对齐（行里有那一条强调色竖线）。
 */
function GroupHeader({ label, count, children }: { label: string; count: number; children?: ReactNode }) {
	return (
		<div className="flex h-7 items-center gap-2 border-l-2 border-transparent px-2 text-xs text-fg-3">
			<span>{label} {count}</span>
			{children && <span className="ml-auto">{children}</span>}
		</div>
	);
}

/**
 * 展开的那一条：第一行是完整的内容（和时间线里那一步的第一行一样，多行照原样）和任务编号，下面是输出。
 * 和上面那一行左右对齐、不缩进：输出常常很宽，两边留空既难看又浪费地方。
 */
function TaskDetail({ task }: { task: ITask }) {
	return (
		<div className="pb-2 pt-2">
			<div className="group/copy flex items-start gap-2 px-2 pt-1 text-xs text-fg-2">
				<span className="min-w-0 flex-1 whitespace-pre-wrap break-words"><CallSummary memberId={task.memberId} name={task.toolName} args={task.arguments} /></span>
				<span className="shrink-0 font-mono text-fg-3">{task.taskId}</span>
				<CopyButton text={task.taskId} />
			</div>
			<div className="px-2 pt-1"><TaskOutput task={task} /></div>
		</div>
	);
}

/** 一个任务的输出：运行中的 shell 看到目前为止的，跟着更新；已结束的看最终结果。 */
function TaskOutput({ task }: { task: ITask }) {
	const running = task.status === 'running';
	const live = useCallOutput(task.runId, task.callId, running && task.toolName === 'shell');
	// 取消、中断的是到那时为止的输出；运行时被强行结束的没存下来。
	if (!running) return <FollowOutput text={task.output || (task.status === 'interrupted' && task.output === null ? '（输出未保存）' : '（无输出）')} live={false} />;
	// 终端的等待任务不重复显示终端的画面：画面在终端标签里看，第一行的终端编号可以点。
	if (task.toolName === 'terminal') return <div className="px-2 py-1 text-xs text-fg-3">正在等待终端的输出，结束后显示结果</div>;
	if (task.toolName !== 'shell') return <div className="px-2 py-1 text-xs text-fg-3">执行中，结束后显示结果</div>;
	if (live.isError) return <div className="px-2 py-1 text-xs text-danger">读取输出失败：{live.error.message}</div>;
	if (live.data === undefined) return null;
	return <FollowOutput text={live.data || '（暂无输出）'} live />;
}
