import type { EventHub } from '../common/events.ts';

/** 同一个调用最快多久发一次有新输出的增量。 */
const NOTIFY_INTERVAL_MS = 1000;

/** 一个执行中的调用：有新输出时调用 changed，结束时调用 close。 */
export interface ILiveOutput {
	changed(): void;
	close(): void;
}

interface IEntry {
	readonly memberId: string;
	readonly read: () => string;
	lastNotified: number;
	timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * 执行中的 shell 调用到目前为止的输出：转后台的多半是要跑很久、输出很多的命令，结束前也要看得到它在干什么。
 * 不另存一份：read 读工具自己收集的那份（和最后的结果同样截断），有人看时才读。结束就去掉，结果照旧存进数据库。
 * 有新输出时发 call.output 增量，每个调用每秒最多一次；增量不占编号，不会挤掉断线补发用的缓冲。
 */
export class LiveOutputs {
	private readonly events: EventHub;
	private readonly entries = new Map<string, IEntry>();

	constructor(events: EventHub) {
		this.events = events;
	}

	open(memberId: string, runId: number, callId: string, read: () => string): ILiveOutput {
		const key = keyOf(runId, callId);
		const entry: IEntry = { memberId, read, lastNotified: 0, timer: undefined };
		this.entries.set(key, entry);
		const notify = () => {
			entry.timer = undefined;
			entry.lastNotified = Date.now();
			this.events.delta({ type: 'call.output', memberId, runId, callId });
		};
		return {
			changed: () => {
				if (entry.timer || this.entries.get(key) !== entry) return;
				const wait = entry.lastNotified + NOTIFY_INTERVAL_MS - Date.now();
				if (wait <= 0) notify();
				else entry.timer = setTimeout(notify, wait);
			},
			close: () => {
				clearTimeout(entry.timer);
				if (this.entries.get(key) === entry) this.entries.delete(key);
			},
		};
	}

	/** 到目前为止的输出；调用已经结束或没有时是 undefined。 */
	read(runId: number, callId: string): { readonly memberId: string; readonly output: string } | undefined {
		const entry = this.entries.get(keyOf(runId, callId));
		return entry && { memberId: entry.memberId, output: entry.read() };
	}
}

function keyOf(runId: number, callId: string): string {
	return `${runId}:${callId}`;
}
