import type { EventHub } from '../common/events.ts';
import type { Runs } from '../runs/runs.ts';
import type { Tasks } from '../tools/tasks.ts';
import type { Members } from './members.ts';

/**
 * 判断一个成员「还有没有活没干完」。
 *
 * 权威的来源只有运行时自己：它在成员被唤醒、请求模型、执行工具、等审批、跑后台任务、
 * 收到新消息时都知道。这里把这些合成一个快照，给「等成员真的停下来」的人用（比如基准测试）。
 *
 * 什么算在工作：
 * - 有运行在进行（含请求模型、执行工具、等待审批——工具调用没返回就是没做完）；
 * - 有会唤醒它的内容还没处理（运行中收到的新消息、群聊里被提到等）；
 * - 有后台任务在跑。
 *
 * 什么不算：定时提醒（到点才唤醒，等它没有意义）、网页端的查看和设置改动。
 *
 * settled 是 busy 为 false 之后又静默了 quietMs：中间那点空档里成员可能被唤醒
 * （后台任务刚结束要补一条内容、新消息刚进来），只看 busy 会误判成做完了。
 */
/** 成员现在处于什么状态。等的人除了 settled 还要看这个：停下了但上次运行是失败的，不能当成做完了。 */
export type WorkStatus = 'idle' | 'running' | 'paused' | 'failed' | 'interrupted';

export interface IWorkSnapshot {
	readonly memberId: string;
	readonly status: WorkStatus;
	/** 没有未完成的工作，且已经静默够久。 */
	readonly settled: boolean;
	readonly busy: boolean;
	/** 有运行在进行（含等待审批）。 */
	readonly run: boolean;
	/** 有会唤醒它的内容还没处理。 */
	readonly pendingWake: boolean;
	readonly runningTasks: number;
	/** 工作状态每变一次加一，用来判断「有没有变化」。 */
	readonly version: number;
	/** 距最后一次变化过了多久。 */
	readonly quietMs: number;
	readonly checkedAt: number;
}

export interface IWaitOptions {
	/** 要连续静默多久才算停下来，默认 2000 毫秒。 */
	readonly quietMs?: number;
	/** 最长等多久，到了就返回 settled: false，默认 60 秒。 */
	readonly timeoutMs?: number;
}

/** 默认的静默窗口：要盖住「一轮结束→补内容→再起一轮」「后台任务结束→唤醒」这类空档。 */
export const DEFAULT_QUIET_MS = 2_000;
/** 默认的等待上限。 */
export const DEFAULT_WAIT_TIMEOUT_MS = 60_000;
/** 内部轮询间隔：只有长轮询的目的地会用到，和对外语义无关。 */
const TICK_MS = 200;

interface IWaiter {
	readonly memberId: string;
	readonly quietMs: number;
	readonly deadline: number;
	readonly resolve: (snapshot: IWorkSnapshot) => void;
	readonly reject: (error: unknown) => void;
}

export class Work {
	private readonly states = new Map<string, { version: number; lastActivityAt: number }>();
	private readonly waiters = new Set<IWaiter>();
	private readonly members: Members;
	private readonly runs: Runs;
	private readonly tasks: Tasks;
	private readonly now: () => number;
	private timer: ReturnType<typeof setInterval> | undefined;

	constructor(members: Members, runs: Runs, tasks: Tasks, events: EventHub, now: () => number = Date.now) {
		this.members = members;
		this.runs = runs;
		this.tasks = tasks;
		this.now = now;
		// 只认和「干活」有关的事件。改设置、成员文件夹同步、定时提醒这些也会发事件，
		// 但它们不影响这个成员有没有活，跟着重置静默窗口只会让等的人白等。
		events.subscribe(({ event }) => {
			if (event.type === 'message.created') {
				for (const memberId of event.memberIds) this.touch(memberId);
				return;
			}
			if (event.type === 'run.changed' || event.type === 'task.changed' || event.type === 'approval.changed'
				|| event.type === 'timeline.appended' || event.type === 'timeline.updated') {
				this.touch(event.memberId);
			}
		});
	}

	/** 现在的快照。成员不存在时报 404。 */
	snapshot(memberId: string, quietMs: number = DEFAULT_QUIET_MS): IWorkSnapshot {
		const member = this.members.require(memberId);
		const run = this.runs.isRunning(memberId);
		const pendingWake = member.type === 'ai' && this.runs.hasPendingWake(memberId);
		const runningTasks = this.tasks.list(memberId, { runningOnly: true }).length;
		const busy = run || pendingWake || runningTasks > 0;
		const status: WorkStatus = member.paused ? 'paused' : run ? 'running' : this.runs.stopReason(memberId)?.status ?? 'idle';
		const state = this.states.get(memberId);
		const checkedAt = this.now();
		// 运行时启动以后没动过：从成员建好那一刻算起，只用来报数。
		const quiet = checkedAt - (state?.lastActivityAt ?? member.createdAt);
		// 没见过它动，就没有「刚动完」这回事：不用等静默窗口。
		const quietEnough = state === undefined || quiet >= quietMs;
		return {
			memberId,
			status,
			settled: !busy && quietEnough,
			busy,
			run,
			pendingWake,
			runningTasks,
			version: state?.version ?? 0,
			quietMs: Math.max(quiet, 0),
			checkedAt,
		};
	}

	/**
	 * 等到成员真的停下来（没有工作，且静默了 quietMs），或者等到超时。
	 * 超时返回的是那一刻的快照，settled 会是 false——调用方据此区分「答上来了但还在忙」和「没答上来」。
	 */
	async wait(memberId: string, options: IWaitOptions = {}): Promise<IWorkSnapshot> {
		const quietMs = options.quietMs ?? DEFAULT_QUIET_MS;
		const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
		this.members.require(memberId);
		return new Promise<IWorkSnapshot>((resolve, reject) => {
			const waiter: IWaiter = { memberId, quietMs, deadline: this.now() + timeoutMs, resolve, reject };
			this.waiters.add(waiter);
			this.startTicker();
			this.evaluate();
		});
	}

	/** 有没有人在等（测试用）。 */
	get waiting(): number {
		return this.waiters.size;
	}

	/** 停止内部的定时器（运行时退出时调用，测试里也用）。 */
	close(): void {
		if (this.timer !== undefined) clearInterval(this.timer);
		this.timer = undefined;
		for (const waiter of this.waiters) waiter.reject(new Error('运行时已关闭'));
		this.waiters.clear();
	}

	private touch(memberId: string): void {
		const state = this.states.get(memberId) ?? { version: 0, lastActivityAt: 0 };
		state.version += 1;
		state.lastActivityAt = this.now();
		this.states.set(memberId, state);
	}

	private startTicker(): void {
		if (this.timer !== undefined) return;
		this.timer = setInterval(() => this.evaluate(), TICK_MS);
		// 别让一个只在等结果的定时器拖住进程退出。
		this.timer.unref?.();
	}

	private evaluate(): void {
		for (const waiter of this.waiters) {
			let snapshot: IWorkSnapshot;
			try {
				snapshot = this.snapshot(waiter.memberId, waiter.quietMs);
			} catch (error) {
				this.waiters.delete(waiter);
				waiter.reject(error);
				continue;
			}
			if (snapshot.settled || this.now() >= waiter.deadline) {
				this.waiters.delete(waiter);
				waiter.resolve(snapshot);
			}
		}
		if (this.waiters.size === 0 && this.timer !== undefined) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}
}
