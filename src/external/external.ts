import { mkdirSync, watch, type FSWatcher } from 'node:fs';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { errorMessage, invalid } from '../common/errors.ts';
import { isRecord } from '../common/json.ts';
import { clipEnd, clipMiddle, formatLocalTime } from '../common/text.ts';
import type { Groups } from '../groups/groups.ts';
import type { IChannelListener, IMcpServerInfo, McpStatus } from '../mcp/servers.ts';
import type { Members } from '../members/members.ts';
import type { Messages } from '../messages/messages.ts';
import type { Describer } from '../runs/describe.ts';
import type { Timeline } from '../timeline/timeline.ts';
import { EventLog, type IDeliveryLog, type IExternalEvent, type IRouteLog, type IRouteRun } from './eventLog.ts';
import { EventRoutes, type RouteDelivery } from './routes.ts';

/** 每个来源每小时最多投递多少次。要唤醒成员的挡住刷屏和来源之间的来回循环；不唤醒的另算，挡住来源失控。 */
const MAX_WAKING_DELIVERIES_PER_HOUR = 300;
const MAX_QUIET_DELIVERIES_PER_HOUR = 3000;
const HOUR_MS = 60 * 60 * 1000;
/** 每个来源记住最近多少个 event_id，挡住平台的重复推送。 */
const REMEMBERED_EVENT_IDS = 1000;
const META_KEY = /^[A-Za-z0-9_]+$/;
/** 正文太长时保留开头和结尾，加上省略的说明也不超过消息的长度上限。 */
const CONTENT_HEAD_CHARS = 4_000;
const CONTENT_TAIL_CHARS = 1_000;
/** 试跑结果里的正文只留开头，认得出是哪个事件就行。 */
const TRIAL_CONTENT_CHARS = 300;
const TRIAL_TEXT_CHARS = 200;
const CHANGE_DELAY_MS = 300;
/** 运行时启动后，路由最近一次的结果从日志里最近这么多个事件里找。 */
const RECENT_RUN_EVENTS = 1000;
/** 同一个来源同样的警告多久内只记一次。 */
const WARNING_REPEAT_MS = 10 * 60 * 1000;
/** 每个来源每小时最多记多少条警告，超出时记一行说明。 */
const MAX_WARNINGS_PER_HOUR = 30;
/** 来源列表只显示多久以内的警告。 */
const RECENT_WARNING_MS = 24 * HOUR_MS;

/** 一次投递，text 已经换成要投的文字。 */
type Delivery =
	| { readonly kind: 'member'; readonly to: string; readonly text: string; readonly wake: boolean }
	| { readonly kind: 'group'; readonly to: string; readonly from: string; readonly text: string; readonly mentions: readonly string[] | 'all' };

/** 外部事件在时间线里和消息里记下的来源和 meta。 */
export interface IExternalOrigin {
	readonly source: string;
	readonly meta: Readonly<Record<string, string>>;
}

/** 网页端看到的一个来源。missing：路由里写了，没有这个 MCP 服务器；not_channel：连上了，但不推事件。 */
export interface IExternalSource {
	readonly name: string;
	readonly status: McpStatus | 'missing' | 'not_channel';
	readonly error: string | null;
	/** 最近的警告：只算这次连上以后、24 小时以内的。 */
	readonly warning: { readonly time: string; readonly text: string } | null;
}

/** 一个来源的警告：最近记过的内容（去重用）、最近一小时记的时间、最近一条。 */
interface IWarnings {
	readonly recent: Map<string, number>;
	times: number[];
	latest: { readonly time: number; readonly text: string } | null;
}

export interface IExternalRoute {
	readonly name: string;
	readonly code: string;
	readonly sources: readonly string[];
	/** 路由读不出来的原因（语法错误、sources 写得不对）。 */
	readonly problem: string | null;
	/** 最近一次处理事件的结果；日志里没有时是 null。 */
	readonly lastRun: IRouteRun | null;
}

export interface IExternalOverview {
	readonly routesDirectory: string;
	readonly sources: readonly IExternalSource[];
	readonly routes: readonly IExternalRoute[];
}

/** 试跑一条路由时一个事件的结果。 */
export interface ITrialResult {
	readonly time: string;
	readonly source: string;
	readonly content: string;
	/** 会做的投递，如「投给 沈安(M_UVT7)，唤醒」；投不成的写明原因。 */
	readonly deliveries: readonly string[];
	readonly error: string | null;
	readonly logs: readonly string[];
}

/**
 * 外部事件：来源（声明了 claude/channel 的 MCP 服务器）推来的事件交给所有处理这个来源的路由，按路由的结果投给 AI 成员，
 * 或者由真人成员发到群聊。每个事件、来源的连接变化和警告都记进事件日志。事件一个一个处理，不会交错。
 */
export class ExternalEvents implements IChannelListener {
	readonly routes: EventRoutes;
	readonly log: EventLog;
	private readonly members: Members;
	private readonly groups: Groups;
	private readonly messages: Messages;
	private readonly timeline: Timeline;
	private readonly describer: Describer;
	private readonly onChange: () => void;
	private queue: Promise<void> = Promise.resolve();
	/** 每个来源最近的 event_id，按收到的先后。 */
	private readonly eventIds = new Map<string, Set<string>>();
	/** 每个来源最近一小时投递的时间，要唤醒成员的和不唤醒的分开记。 */
	private readonly deliveredAt = new Map<string, { waking: number[]; quiet: number[] }>();
	private readonly warnings = new Map<string, IWarnings>();
	/** 每条路由最近一次处理事件的结果：处理事件时更新；运行时启动后第一次用到时，从日志里最近的事件补上之前的。 */
	private readonly lastRuns = new Map<string, IRouteRun>();
	private loggedRunsRead = false;
	private watcher: FSWatcher | undefined;
	private changeTimer: NodeJS.Timeout | undefined;

	/** onChange：事件日志写了新的一行，或者路由文件变了。 */
	constructor(
		routesDirectory: string, logsDirectory: string, members: Members, groups: Groups, messages: Messages, timeline: Timeline, describer: Describer,
		onChange: () => void = () => {},
	) {
		this.routes = new EventRoutes(routesDirectory);
		this.log = new EventLog(logsDirectory, () => this.changed());
		this.onChange = onChange;
		this.members = members;
		this.groups = groups;
		this.messages = messages;
		this.timeline = timeline;
		this.describer = describer;
	}

	event(source: string, params: unknown): void {
		this.queue = this.queue.then(() => this.receive(source, params)).catch((error: unknown) => console.error(`处理外部来源「${source}」的事件失败：`, error));
	}

	status(source: string, status: 'connected' | 'disconnected' | 'failed', error: string | null): void {
		// 重新连上后，来源列表不再显示以前的警告。
		const warnings = this.warnings.get(source);
		if (status === 'connected' && warnings) warnings.latest = null;
		this.log.write({ type: status, time: formatLocalTime(Date.now()), source, error });
	}

	/** 记一条来源的警告：同样的内容 10 分钟内只记一次，每小时最多记 30 条。 */
	warning(source: string, text: string): void {
		const now = Date.now();
		let warnings = this.warnings.get(source);
		if (!warnings) this.warnings.set(source, warnings = { recent: new Map(), times: [], latest: null });
		for (const [recent, time] of warnings.recent) if (now - time >= WARNING_REPEAT_MS) warnings.recent.delete(recent);
		if (warnings.recent.has(text)) return;
		warnings.times = warnings.times.filter(time => now - time < HOUR_MS);
		if (warnings.times.length > MAX_WARNINGS_PER_HOUR) return;
		warnings.times.push(now);
		warnings.recent.set(text, now);
		const shown = warnings.times.length > MAX_WARNINGS_PER_HOUR ? `一小时内的警告已超过 ${MAX_WARNINGS_PER_HOUR} 条，此后的警告暂不记录` : text;
		warnings.latest = { time: now, text: shown };
		this.log.write({ type: 'warning', time: formatLocalTime(now), source, text: shown });
	}

	/** 用事件日志里最近的事件试跑一条路由，不真的投递。只用这条路由处理的来源的事件，新的在前。 */
	async trial(name: string, code: string, source: string | undefined, limit: number): Promise<ITrialResult[]> {
		const sources = await this.routes.sources(name, code);
		if (typeof sources === 'string') throw invalid(`路由有误：${sources}`);
		const events = this.log.recentEvents(limit, event => sources.includes(event.source) && (source === undefined || event.source === source));
		const results: ITrialResult[] = [];
		for (const event of events) {
			await nextTurn();
			const result = await this.routes.run(name, code, event);
			const deliveries = merge([{ route: name, deliveries: result?.deliveries ?? [] }], event.content);
			results.push({
				time: event.time, source: event.source, content: clipEnd(event.content, TRIAL_CONTENT_CHARS),
				deliveries: deliveries.map(({ delivery }) => this.describe(delivery, event.content)),
				error: result?.error ?? null, logs: result?.logs ?? [],
			});
		}
		return results;
	}

	/**
	 * 来源和路由，给网页端看。来源是声明了 claude/channel 的 MCP 服务器，加上路由里写到的名字：
	 * 写错了名字、写的服务器不推事件，都在这里看得出来。
	 */
	async overview(servers: readonly IMcpServerInfo[]): Promise<IExternalOverview> {
		const routeNames = this.routes.names();
		if (!this.loggedRunsRead) {
			this.loggedRunsRead = true;
			// 启动后已经处理过事件的路由，以内存里的为准。
			for (const [name, run] of this.log.recentRouteRuns(routeNames, RECENT_RUN_EVENTS)) if (!this.lastRuns.has(name)) this.lastRuns.set(name, run);
		}
		const routes: IExternalRoute[] = [];
		for (const name of routeNames) {
			let code: string;
			try {
				code = this.routes.read(name);
			} catch {
				continue;
			}
			const sources = await this.routes.sources(name, code);
			const problem = typeof sources === 'string' ? sources : null;
			routes.push({ name, code, sources: typeof sources === 'string' ? [] : sources, problem, lastRun: this.lastRuns.get(name) ?? null });
		}
		const names = new Set([...servers.filter(server => server.channel || server.builtin).map(server => server.name), ...routes.flatMap(route => route.sources)]);
		const now = Date.now();
		const sources = [...names].sort().map((name): IExternalSource => {
			const server = servers.find(item => item.name === name);
			if (!server) return { name, status: 'missing', error: null, warning: null };
			const latest = this.warnings.get(name)?.latest;
			const warning = latest && now - latest.time < RECENT_WARNING_MS ? { time: formatLocalTime(latest.time), text: latest.text } : null;
			return { name, status: server.status === 'connected' && !server.channel ? 'not_channel' : server.status, error: server.error, warning };
		});
		return { routesDirectory: this.routes.directory, sources, routes };
	}

	/** 监听路由目录，路由文件变了时通知。目录还没有时先建好。 */
	watch(): void {
		if (this.watcher) return;
		mkdirSync(this.routes.directory, { recursive: true });
		this.watcher = watch(this.routes.directory, () => this.changed());
		this.watcher.on('error', error => console.error('监听事件路由目录失败：', error));
	}

	/** 等已收到的事件处理完。 */
	async idle(): Promise<void> {
		await this.queue;
	}

	/** 等已收到的事件处理完。来源要先断开，之后不再有新事件。 */
	async close(): Promise<void> {
		this.watcher?.close();
		this.watcher = undefined;
		await this.queue;
		clearTimeout(this.changeTimer);
		this.log.close();
	}

	/** 一阵变化（如连着来了很多事件）只通知一次。 */
	private changed(): void {
		if (this.changeTimer) return;
		this.changeTimer = setTimeout(() => {
			this.changeTimer = undefined;
			this.onChange();
		}, CHANGE_DELAY_MS);
	}

	private async receive(source: string, params: unknown): Promise<void> {
		const now = Date.now();
		const time = formatLocalTime(now);
		const parsed = parseParams(params);
		if (typeof parsed === 'string') {
			this.log.write({ type: 'invalid', time, source, error: parsed });
			return;
		}
		const event: IExternalEvent = { source, content: parsed.content, meta: parsed.meta, time };
		const eventId = event.meta['event_id'];
		if (eventId !== undefined && !this.remember(source, eventId)) {
			this.log.write({ type: 'duplicate', time, source, event_id: eventId });
			return;
		}
		const routes: IRouteLog[] = [];
		const results: { route: string; deliveries: readonly RouteDelivery[] }[] = [];
		for (const name of this.routes.names()) {
			// 每条路由执行前让出主线程：排着的事件是一串接着的 Promise，一下来很多个时不让出，运行时其间什么都做不了（一条路由最多能执行 500 毫秒）。
			await nextTurn();
			let result;
			try {
				result = await this.routes.run(name, this.routes.read(name), event);
			} catch (error) {
				result = { deliveries: [], error: errorMessage(error), logs: [] };
			}
			if (!result) continue;
			routes.push({ route: name, error: result.error, logs: result.logs });
			this.lastRuns.set(name, { time, error: result.error });
			results.push({ route: name, deliveries: result.deliveries });
		}
		const deliveries: IDeliveryLog[] = merge(results, event.content).map(({ delivery, routes: names }) => ({
			...deliveryLog(delivery, event.content), routes: names, error: this.deliver(event, delivery, now),
		}));
		this.log.write({ type: 'event', ...event, routes, deliveries });
	}

	/** 投递，返回没投成的原因。 */
	private deliver(event: IExternalEvent, delivery: Delivery, now: number): string | null {
		const problem = this.check(delivery);
		if (problem !== null) return problem;
		let delivered = this.deliveredAt.get(event.source);
		if (!delivered) this.deliveredAt.set(event.source, delivered = { waking: [], quiet: [] });
		const waking = this.wakes(delivery);
		const times = (waking ? delivered.waking : delivered.quiet).filter(time => now - time < HOUR_MS);
		if (waking) delivered.waking = times;
		else delivered.quiet = times;
		const max = waking ? MAX_WAKING_DELIVERIES_PER_HOUR : MAX_QUIET_DELIVERIES_PER_HOUR;
		if (times.length >= max) {
			const what = waking ? '唤醒成员的' : '不唤醒成员的';
			this.warning(event.source, `一小时内${what}投递已达 ${max} 次上限，此后的投递暂停`);
			return `来源「${event.source}」一小时内${what}投递已达 ${max} 次上限，本次不投递`;
		}
		const origin: IExternalOrigin = { source: event.source, meta: event.meta };
		try {
			if (delivery.kind === 'member') {
				this.timeline.appendExternalEvent(delivery.to, { ...origin, text: delivery.text }, delivery.wake);
			} else {
				this.messages.send(delivery.from, { kind: 'group', groupId: delivery.to }, delivery.text, delivery.mentions, [], origin);
			}
		} catch (error) {
			return errorMessage(error);
		}
		times.push(now);
		return null;
	}

	/**
	 * 这次投递要不要唤醒成员：投给成员看 wake；投到群聊看有没有被点名或关注这个群的 AI 成员。
	 * 成员正在运行也算：来回循环时成员一直在运行，只数从空闲开始的运行就挡不住。
	 */
	private wakes(delivery: Delivery): boolean {
		if (delivery.kind === 'member') return delivery.wake;
		const { mentions } = delivery;
		return (this.groups.get(delivery.to)?.members ?? []).some(membership => membership.memberId !== delivery.from
			&& (mentions === 'all' || mentions.includes(membership.memberId) || membership.watching)
			&& this.members.get(membership.memberId)?.type === 'ai');
	}

	/** 投递做不成的原因：成员不存在或已删除、代发的不是真人或不在群里。 */
	private check(delivery: Delivery): string | null {
		if (delivery.kind === 'member') {
			const member = this.members.get(delivery.to);
			if (!member || member.purged) return `成员 ${delivery.to} 不存在`;
			if (member.deleted) return `${this.describer.member(delivery.to)} 已删除`;
			if (member.type !== 'ai') return `${this.describer.member(delivery.to)} 是真人成员，只能投递给 AI 成员`;
			return null;
		}
		const group = this.groups.get(delivery.to);
		if (!group || group.dissolved) return `群聊 ${delivery.to} 不存在或已解散`;
		const from = this.members.get(delivery.from);
		if (!from || from.deleted) return `代发的成员 ${delivery.from} 不存在`;
		if (from.type !== 'human') return `代发的 ${this.describer.member(delivery.from)} 不是真人成员`;
		const others = group.members.filter(membership => membership.memberId !== delivery.from).map(membership => membership.memberId);
		if (others.length === group.members.length) return `代发的 ${this.describer.member(delivery.from)} 不在群聊「${group.name}」中`;
		const stranger = delivery.mentions === 'all' ? undefined : delivery.mentions.find(memberId => !others.includes(memberId));
		if (stranger !== undefined) return `点名的 ${stranger} 不是群聊「${group.name}」中的其他成员`;
		return null;
	}

	/** 试跑结果里的一次投递。 */
	private describe(delivery: Delivery, content: string): string {
		const text = delivery.text === content ? '' : `，文字：${clipEnd(delivery.text, TRIAL_TEXT_CHARS)}`;
		const problem = this.check(delivery);
		let head: string;
		if (delivery.kind === 'member') {
			head = `投递给 ${this.describer.member(delivery.to)}，${delivery.wake ? '唤醒' : '不唤醒'}`;
		} else {
			const group = this.groups.get(delivery.to);
			const mentions = delivery.mentions === 'all' ? '，点名所有人'
				: delivery.mentions.length > 0 ? `，点名 ${delivery.mentions.map(memberId => this.describer.member(memberId)).join('、')}` : '';
			head = `由 ${this.describer.member(delivery.from)} 转发到${group ? `群聊「${group.name}」(${group.groupId})` : `群聊 ${delivery.to}`}${mentions}`;
		}
		return `${head}${text}${problem === null ? '' : `；无法投递：${problem}`}`;
	}

	/** 记下 event_id；收到过时返回 false。 */
	private remember(source: string, eventId: string): boolean {
		let seen = this.eventIds.get(source);
		if (!seen) this.eventIds.set(source, seen = new Set());
		if (seen.has(eventId)) return false;
		seen.add(eventId);
		if (seen.size > REMEMBERED_EVENT_IDS) seen.delete(seen.values().next().value!);
		return true;
	}
}

/**
 * 推来的参数：正文 content 和 meta。meta 的键只用英文字母、数字和下划线，值是文字，不合要求的丢掉（和 Claude Code 一样）；
 * 值里的换行换成空格，每个 meta 在上下文里占一行。格式不对时返回原因。
 */
function parseParams(params: unknown): { content: string; meta: Record<string, string> } | string {
	if (!isRecord(params)) return '参数格式须为 { content, meta }';
	const { content, meta } = params;
	if (typeof content !== 'string') return 'content 须为字符串';
	const entries = isRecord(meta) ? Object.entries(meta) : [];
	return {
		content: clipMiddle(content, CONTENT_HEAD_CHARS, CONTENT_TAIL_CHARS),
		meta: Object.fromEntries(entries
			.filter((entry): entry is [string, string] => META_KEY.test(entry[0]) && typeof entry[1] === 'string')
			.map(([key, value]) => [key, value.replace(/\s*[\r\n]+\s*/g, ' ')])),
	};
}

/** 各条路由的投递合在一起：完全相同的（同一个目标、同样的文字）只投一次，投给成员的有一条要唤醒就唤醒，投到群聊的点名合在一起。 */
function merge(results: readonly { route: string; deliveries: readonly RouteDelivery[] }[], content: string): { delivery: Delivery; routes: string[] }[] {
	const merged = new Map<string, { delivery: Delivery; routes: string[] }>();
	for (const { route, deliveries } of results) {
		for (const item of deliveries) {
			const delivery: Delivery = { ...item, text: item.text ?? content };
			const key = JSON.stringify(delivery.kind === 'member' ? [delivery.to, delivery.text] : [delivery.to, delivery.from, delivery.text]);
			const existing = merged.get(key);
			if (!existing) {
				merged.set(key, { delivery, routes: [route] });
				continue;
			}
			if (!existing.routes.includes(route)) existing.routes.push(route);
			const previous = existing.delivery;
			if (previous.kind === 'member' && delivery.kind === 'member') {
				existing.delivery = { ...previous, wake: previous.wake || delivery.wake };
			} else if (previous.kind === 'group' && delivery.kind === 'group') {
				const mentions = previous.mentions === 'all' || delivery.mentions === 'all' ? 'all' : [...new Set([...previous.mentions, ...delivery.mentions])];
				existing.delivery = { ...previous, mentions };
			}
		}
	}
	return [...merged.values()];
}

function deliveryLog(delivery: Delivery, content: string): Omit<IDeliveryLog, 'routes' | 'error'> {
	const text = delivery.text === content ? {} : { text: delivery.text };
	return delivery.kind === 'member'
		? { to: delivery.to, ...text, wake: delivery.wake }
		: { to: delivery.to, from: delivery.from, ...text, mentions: delivery.mentions };
}
