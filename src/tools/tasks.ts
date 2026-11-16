import type { EventHub } from '../common/events.ts';
import { errorMessage, invalid, notFound } from '../common/errors.ts';
import { newId, wrongKind } from '../common/ids.ts';
import type { Database } from '../database/database.ts';
import type { ITaskResult, Timeline } from '../timeline/timeline.ts';
import type { IToolCallResult, TaskDelivery } from './tools.ts';

export type TaskStatus = 'running' | ITaskResult['status'];

export interface ITask {
	readonly taskId: string;
	readonly memberId: string;
	/** 转为后台的那次工具调用。 */
	readonly runId: number;
	readonly callId: string;
	readonly toolName: string;
	readonly arguments: unknown;
	readonly status: TaskStatus;
	/** 结果，就是成员拿到的那份；取消、中断的是到那时为止的输出。运行中的、被强行结束没存下来的是 null。 */
	readonly output: string | null;
	/** 调用开始执行的时间（不是转为后台的时间），耗时从这里算。 */
	readonly startedAt: number;
	readonly endedAt: number | null;
}

interface ITaskRow {
	readonly task_id: string;
	readonly member_id: string;
	readonly run_id: number;
	readonly call_id: string;
	readonly tool_name: string;
	readonly arguments_json: string;
	readonly status: TaskStatus;
	readonly output: string | null;
	readonly started_at: number;
	readonly ended_at: number | null;
}

/** 转后台时另外给的。 */
export interface IAdoptOptions {
	/**
	 * 转后台那次调用的结果记进时间线以后兑现。任务在这之前就结束的，等到这时再交结果：
	 * 不然任务的结果会排在那次调用的结果前面。
	 */
	readonly recorded: Promise<void>;
	/** 任务结束时结果怎么交给成员；不给时进时间线并唤醒它。被取消的不问。 */
	readonly delivery?: () => TaskDelivery;
}

interface IActiveTask {
	readonly controller: AbortController;
	readonly delivery: (() => TaskDelivery) | undefined;
	done: Promise<void>;
	cancelledBy: 'member' | 'user' | 'deletion' | undefined;
	/** 成员取消后在等它结束：取消前的输出交给那次取消调用，不再进时间线。 */
	awaited: ((output: string) => void) | undefined;
}

/** 成员取消任务时最多等它结束多久。 */
const CANCEL_WAIT_MS = 10_000;

/**
 * 后台任务：执行太久的工具调用转到这里继续执行，这次运行可以照常往下走。
 * 结束后结果作为一条新内容进入成员的时间线并唤醒它。
 * 没做完就结束的（取消、运行时退出）也带上到那时为止的输出：调用做了的事已经发生了，输出里可能有关键的事实，
 * 不交出来就是在成员和用户都不知道的情况下少了一段上下文。成员自己取消、等到了结束的，输出在它那次取消的结果里，不再另发。
 */
export class Tasks {
	private readonly db: Database;
	private readonly events: EventHub;
	private readonly timeline: Timeline;
	private readonly active = new Map<string, IActiveTask>();
	private readonly cancelWaitMs: number;
	private closing = false;

	constructor(db: Database, events: EventHub, timeline: Timeline, cancelWaitMs = CANCEL_WAIT_MS) {
		this.db = db;
		this.events = events;
		this.timeline = timeline;
		this.cancelWaitMs = cancelWaitMs;
	}

	/**
	 * 运行时启动时，上次没做完的任务都已中断，告诉成员。
	 * 正常退出时存下了到那时的输出（见 finish），一起交给它；被强行结束、断电的没存下来，写明没保存下来。
	 */
	recover(): void {
		this.db.transaction(() => {
			for (const row of this.db.all<ITaskRow>(`SELECT * FROM tasks WHERE status = 'running'`)) {
				this.db.run(`UPDATE tasks SET status = 'interrupted', ended_at = COALESCE(ended_at, ?) WHERE task_id = ?`, Date.now(), row.task_id);
				this.timeline.appendTaskResult(row.member_id, {
					taskId: row.task_id, toolName: row.tool_name, status: 'interrupted', output: row.output ?? '', stoppedOutput: stoppedOutput(row.output),
				}, true);
				this.events.emit({ type: 'task.changed', memberId: row.member_id, taskId: row.task_id });
			}
		});
	}

	/** 把已经在执行的调用转为后台任务，返回后台任务 ID。startedAt 是调用开始执行的时间。 */
	adopt(
		memberId: string, runId: number, callId: string, toolName: string, args: unknown, startedAt: number, controller: AbortController,
		running: Promise<IToolCallResult>, options: IAdoptOptions,
	): string {
		const taskId = newId('B', id => this.db.get('SELECT 1 FROM tasks WHERE task_id = ?', id) !== undefined);
		this.db.transaction(() => {
			this.db.run(`
				INSERT INTO tasks (task_id, member_id, run_id, call_id, tool_name, arguments_json, status, started_at)
				VALUES (?, ?, ?, ?, ?, ?, 'running', ?)
			`, taskId, memberId, runId, callId, toolName, JSON.stringify(args), startedAt);
			this.events.emit({ type: 'task.changed', memberId, taskId });
		});
		const task: IActiveTask = { controller, delivery: options.delivery, done: Promise.resolve(), cancelledBy: undefined, awaited: undefined };
		this.active.set(taskId, task);
		// 结果先接住（出错的不会成为没人处理的拒绝），等那次调用的结果记下了再交。
		const settled = running.then(result => ({ result }), (error: unknown) => ({ error }));
		task.done = Promise.all([settled, options.recorded]).then(([outcome]) => {
			if ('result' in outcome) {
				this.finish(taskId, task, outcome.result.isError ? 'failed' : 'completed', outcome.result.output);
				return;
			}
			const stopped = task.cancelledBy !== undefined || this.closing;
			if (!stopped) console.error(outcome.error);
			// 取消、退出时直接停下的工具没有中途输出。取消不是出错，不写成「执行出错」。
			this.finish(taskId, task, 'failed', stopped ? '' : `执行出错：${errorMessage(outcome.error)}`);
		});
		return taskId;
	}

	/** 用户在网页端取消任务。结束后结果照常进时间线、唤醒成员，带上取消前的输出。 */
	cancel(taskId: string): void {
		this.stop(this.find(taskId), 'user');
	}

	/**
	 * 成员取消自己的任务：等它结束（结束整个进程树，通常不到 1 秒），返回取消前的输出，写在那次取消调用的结果里，不再另发。
	 * 等了 cancelWaitMs 还没结束、或者那次调用被中止了，返回 undefined；结束后结果照常进时间线、唤醒成员。
	 */
	cancelOwn(taskId: string, memberId: string, signal: AbortSignal): Promise<string | undefined> {
		const task = this.find(taskId, memberId);
		return new Promise(resolve => {
			const settle = (output: string | undefined) => {
				task.awaited = undefined;
				clearTimeout(timer);
				signal.removeEventListener('abort', giveUp);
				resolve(output);
			};
			const giveUp = () => settle(undefined);
			const timer = setTimeout(giveUp, this.cancelWaitMs);
			signal.addEventListener('abort', giveUp, { once: true });
			if (!signal.aborted) task.awaited = settle;
			this.stop(task, 'member');
			if (signal.aborted) giveUp();
		});
	}

	/** 成员被删除：取消它在执行的任务，等它们结束。 */
	async cancelMember(memberId: string): Promise<void> {
		const done: Promise<void>[] = [];
		for (const row of this.db.all<{ task_id: string }>(`SELECT task_id FROM tasks WHERE member_id = ? AND status = 'running'`, memberId)) {
			const task = this.active.get(row.task_id);
			if (!task) continue;
			this.stop(task, 'deletion');
			done.push(task.done);
		}
		await Promise.all(done);
	}

	list(memberId: string, options: { readonly runningOnly?: boolean } = {}): ITask[] {
		return this.db.all<ITaskRow>(`
			SELECT * FROM tasks WHERE member_id = ? AND (? = 0 OR status = 'running') ORDER BY started_at DESC, task_id LIMIT 100
		`, memberId, options.runningOnly ? 1 : 0).map(toTask);
	}

	/** 等所有后台任务结束。 */
	async idle(): Promise<void> {
		while (this.active.size > 0) await Promise.all([...this.active.values()].map(task => task.done));
	}

	/** 运行时退出：中止所有任务，存下到那时的输出；下次启动时标为中断，再告诉成员（见 recover）。 */
	async shutdown(): Promise<void> {
		this.closing = true;
		for (const task of this.active.values()) task.controller.abort(new Error('运行时退出'));
		await this.idle();
	}

	/** 找到在执行的任务。给了成员时只找它自己的。 */
	private find(taskId: string, memberId?: string): IActiveTask {
		const row = this.db.get<{ member_id: string; status: TaskStatus }>('SELECT member_id, status FROM tasks WHERE task_id = ?', taskId);
		if (!row || (memberId !== undefined && row.member_id !== memberId)) throw notFound(wrongKind(taskId, 'B') ?? `后台任务不存在：${taskId}`);
		const task = this.active.get(taskId);
		if (row.status !== 'running' || !task) throw invalid(`后台任务 ${taskId} 已结束`);
		if (task.cancelledBy) throw invalid(`后台任务 ${taskId} 已取消，正在结束`);
		return task;
	}

	/** 中止任务。原因写进 shell 结果的最后一行：「[已取消，命令已终止]」。 */
	private stop(task: IActiveTask, by: 'member' | 'user' | 'deletion'): void {
		task.cancelledBy = by;
		task.controller.abort(new Error('已取消'));
	}

	private finish(taskId: string, task: IActiveTask, status: 'completed' | 'failed', output: string): void {
		this.active.delete(taskId);
		if (this.closing) {
			// 状态留着「运行中」，下次启动时改成中断、告诉成员。
			this.db.run('UPDATE tasks SET output = ?, ended_at = ? WHERE task_id = ?', output, Date.now(), taskId);
			return;
		}
		const finalStatus = task.cancelledBy ? 'cancelled' : status;
		const awaited = task.awaited;
		// 被取消的照取消的规则交给成员，不问工具。
		const delivery = task.cancelledBy ? 'wake' : task.delivery?.() ?? 'wake';
		this.db.transaction(() => {
			const row = this.db.get<ITaskRow>('SELECT * FROM tasks WHERE task_id = ?', taskId)!;
			this.db.run('UPDATE tasks SET status = ?, output = ?, ended_at = ? WHERE task_id = ?', finalStatus, output, Date.now(), taskId);
			// 顺手把还在跑的别的后台任务列出来：成员常常在等一件事的同时给自己起了定时任务，等到结果就以为收工了。
			// 一条都不剩时不写这一段，不占地方。
			const remainingTasks = this.db.all<{ task_id: string; tool_name: string }>(
				"SELECT task_id, tool_name FROM tasks WHERE member_id = ? AND status = 'running' AND task_id <> ? ORDER BY started_at",
				row.member_id, taskId,
			).map(other => ({ taskId: other.task_id, toolName: other.tool_name }));
			if (!awaited && delivery !== 'none') {
				this.timeline.appendTaskResult(row.member_id, {
					taskId, toolName: row.tool_name, status: finalStatus, output, remainingTasks,
					...task.cancelledBy && { stoppedOutput: stoppedOutput(output) },
					...task.cancelledBy === 'member' && { cancelledByMember: true },
					...task.cancelledBy === 'deletion' && { cancelledOnDelete: true },
				}, delivery === 'wake');
			}
			this.events.emit({ type: 'task.changed', memberId: row.member_id, taskId });
		});
		awaited?.(output);
	}
}

/** 没做完就结束的任务拿到的输出：有（kept）、没有中途输出（none）、运行时被强行结束没存下来（null，lost）。 */
function stoppedOutput(output: string | null): NonNullable<ITaskResult['stoppedOutput']> {
	return output === null ? 'lost' : output ? 'kept' : 'none';
}

function toTask(row: ITaskRow): ITask {
	return {
		taskId: row.task_id, memberId: row.member_id, runId: row.run_id, callId: row.call_id, toolName: row.tool_name, arguments: JSON.parse(row.arguments_json),
		status: row.status, output: row.output, startedAt: row.started_at, endedAt: row.ended_at,
	};
}
