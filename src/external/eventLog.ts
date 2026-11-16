import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { formatLocalTime } from '../common/text.ts';

/** 日志保留多少天。 */
const KEEP_DAYS = 14;
/** 多久检查一次过期的日志。 */
const CLEAN_INTERVAL_MS = 60 * 60 * 1000;
const FILE_PATTERN = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
/** 从文件末尾往前读时每次读多少字节。 */
const CHUNK_BYTES = 64 * 1024;

/** 来源推来的一个事件，路由收到的就是它。time 是收到的时间，格式和上下文里的时间一样。 */
export interface IExternalEvent {
	readonly source: string;
	readonly content: string;
	readonly meta: Readonly<Record<string, string>>;
	readonly time: string;
}

/** 一条路由处理一个事件的结果。不处理这个来源的路由不记。 */
export interface IRouteLog {
	readonly route: string;
	readonly error: string | null;
	readonly logs: readonly string[];
}

/** 一次投递：投给谁、哪些路由要投、没投成的原因。text 和事件正文一样时不写。 */
export interface IDeliveryLog {
	readonly to: string;
	readonly from?: string;
	readonly text?: string;
	readonly wake?: boolean;
	readonly mentions?: readonly string[] | 'all';
	readonly routes: readonly string[];
	readonly error: string | null;
}

export type EventLogEntry =
	| IExternalEvent & { readonly type: 'event'; readonly routes: readonly IRouteLog[]; readonly deliveries: readonly IDeliveryLog[] }
	/** 按「来源 + event_id」挡下的重复推送。 */
	| { readonly type: 'duplicate'; readonly time: string; readonly source: string; readonly event_id: string }
	/** 推来的通知格式不对。 */
	| { readonly type: 'invalid'; readonly time: string; readonly source: string; readonly error: string }
	| { readonly type: 'connected' | 'disconnected' | 'failed'; readonly time: string; readonly source: string; readonly error: string | null }
	/** 来源连上以后写到 stderr 的一行。 */
	| { readonly type: 'warning'; readonly time: string; readonly source: string; readonly text: string };

/** 一条路由某次处理事件的结果。 */
export interface IRouteRun {
	readonly time: string;
	readonly error: string | null;
}

/** 日志的一行，offset 是它在那天文件里开头的字节位置，翻页用。 */
export type PlacedEntry = EventLogEntry & { readonly offset: number };

/** 某一天的一段日志，新的在前。 */
export interface IEventLogPage {
	/** 有日志的日期，新的在前。 */
	readonly dates: readonly string[];
	readonly date: string | null;
	readonly entries: readonly PlacedEntry[];
	/** 这一天还有更早的。 */
	readonly more: boolean;
}

/**
 * 事件日志：按天一个 JSONL 文件，每个事件、每次连接变化、每条警告一行，保留 14 天。
 * 用到的都是最近的几行，读的时候从文件末尾往前读，够了就停，不读整个文件。
 */
export class EventLog {
	readonly directory: string;
	private readonly onWrite: () => void;
	private readonly timer: NodeJS.Timeout;

	constructor(directory: string, onWrite: () => void = () => {}) {
		this.directory = directory;
		this.onWrite = onWrite;
		this.clean();
		this.timer = setInterval(() => this.clean(), CLEAN_INTERVAL_MS);
		this.timer.unref();
	}

	/** 记一行。写不进去时只在控制台报错，不影响事件的处理。 */
	write(entry: EventLogEntry): void {
		try {
			mkdirSync(this.directory, { recursive: true });
			appendFileSync(join(this.directory, `${entry.time.slice(0, 10)}.jsonl`), `${JSON.stringify(entry)}\n`);
		} catch (error) {
			console.error('写事件日志失败：', error);
			return;
		}
		this.onWrite();
	}

	/** 某一天的日志，新的在前：不给日期时是最近有日志的一天；before 是字节位置，只取它之前的；source 只要这个来源的。 */
	page(options: { readonly date?: string; readonly source?: string; readonly before?: number; readonly limit: number }): IEventLogPage {
		const dates = this.files().map(file => file.slice(0, 10)).reverse();
		const date = options.date ?? dates[0] ?? null;
		if (date === null || !dates.includes(date)) return { dates, date, entries: [], more: false };
		const entries: PlacedEntry[] = [];
		for (const { text, offset } of linesBackward(join(this.directory, `${date}.jsonl`), options.before)) {
			const entry = parse(text);
			if (!entry || (options.source !== undefined && entry.source !== options.source)) continue;
			if (entries.length >= options.limit) return { dates, date, entries, more: true };
			entries.push({ ...entry, offset });
		}
		return { dates, date, entries, more: false };
	}

	/** 最近 limit 个事件里，每条路由最近一次处理事件的结果；names 里的路由都找到了就不再往前找。 */
	recentRouteRuns(names: readonly string[], limit: number): Map<string, IRouteRun> {
		const runs = new Map<string, IRouteRun>();
		let count = 0;
		for (const entry of this.eventsBackward()) {
			for (const route of entry.routes) if (!runs.has(route.route)) runs.set(route.route, { time: entry.time, error: route.error });
			if (++count >= limit || names.every(name => runs.has(name))) break;
		}
		return runs;
	}

	/** 最近收到的事件，新的在前；给了 accept 时只要它接受的。 */
	recentEvents(limit: number, accept: (event: IExternalEvent) => boolean = () => true): IExternalEvent[] {
		const events: IExternalEvent[] = [];
		for (const entry of this.eventsBackward()) {
			const event = { source: entry.source, content: entry.content, meta: entry.meta, time: entry.time };
			if (!accept(event)) continue;
			events.push(event);
			if (events.length >= limit) break;
		}
		return events;
	}

	close(): void {
		clearInterval(this.timer);
	}

	/** 全部日志里的事件，从新到旧。 */
	private *eventsBackward(): Generator<Extract<EventLogEntry, { type: 'event' }>> {
		for (const file of this.files().reverse()) {
			for (const { text } of linesBackward(join(this.directory, file))) {
				const entry = parse(text);
				if (entry?.type === 'event') yield entry;
			}
		}
	}

	/** 日志文件名，按日期从早到晚。 */
	private files(): string[] {
		if (!existsSync(this.directory)) return [];
		return readdirSync(this.directory).filter(name => FILE_PATTERN.test(name)).sort();
	}

	private clean(): void {
		const oldest = formatLocalTime(Date.now() - (KEEP_DAYS - 1) * 24 * 60 * 60 * 1000).slice(0, 10);
		try {
			for (const file of this.files()) if (file.slice(0, 10) < oldest) rmSync(join(this.directory, file), { force: true });
		} catch (error) {
			console.error('清理事件日志失败：', error);
		}
	}
}

/** 从文件末尾（给了 end 时从这个字节位置）往前一行一行读，每行带它开头的字节位置；空行不给。 */
function* linesBackward(path: string, end?: number): Generator<{ readonly text: string; readonly offset: number }> {
	let fd: number;
	try {
		fd = openSync(path, 'r');
	} catch {
		return;
	}
	try {
		let position = Math.min(end ?? Infinity, fstatSync(fd).size);
		// 已经读进来、还没分出行的部分，从 position 开始。按字节找换行，不会把一个字拆开。
		let rest = Buffer.alloc(0);
		while (position > 0) {
			const size = Math.min(CHUNK_BYTES, position);
			position -= size;
			const chunk = Buffer.alloc(size);
			readSync(fd, chunk, 0, size, position);
			let buffer = rest.length > 0 ? Buffer.concat([chunk, rest]) : chunk;
			for (let index = buffer.lastIndexOf(0x0a); index !== -1; index = buffer.lastIndexOf(0x0a)) {
				if (index + 1 < buffer.length) yield { text: buffer.subarray(index + 1).toString('utf8'), offset: position + index + 1 };
				buffer = buffer.subarray(0, index);
			}
			rest = buffer;
		}
		if (rest.length > 0) yield { text: rest.toString('utf8'), offset: 0 };
	} finally {
		closeSync(fd);
	}
}

/**
 * 一行日志；写到一半等原因读不了时是 undefined。
 * 日志是能手改的文件：事件缺了路由的结果、投递时按空的算，不让一行日志把整页和最近的结果都弄得读不出来。
 */
function parse(line: string): EventLogEntry | undefined {
	if (!line.trim()) return undefined;
	let entry: EventLogEntry;
	try {
		entry = JSON.parse(line) as EventLogEntry;
	} catch {
		return undefined;
	}
	if (entry?.type !== 'event') return entry;
	const deliveries = Array.isArray(entry.deliveries) ? entry.deliveries : [];
	return {
		...entry,
		routes: Array.isArray(entry.routes) ? entry.routes : [],
		deliveries: deliveries.map(delivery => ({ ...delivery, routes: Array.isArray(delivery.routes) ? delivery.routes : [] })),
	};
}
