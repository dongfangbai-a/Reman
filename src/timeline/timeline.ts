import { invalid } from '../common/errors.ts';
import type { EventHub } from '../common/events.ts';
import type { Database } from '../database/database.ts';
import { MAX_ATTACHMENTS, type Attachments, type IAttachment } from '../messages/attachments.ts';
import { MAX_TEXT_LENGTH } from '../messages/messages.ts';
import type { IPlanItem } from '../plans/plans.ts';
import type { IReminderFired } from '../reminders/reminders.ts';
import type { MemoryOperation } from '../members/memory.ts';
import { clockAt, nextTimeNote, timeRangeText, type IClock, type ITimeNote } from './clock.ts';
import type { IContentCounts } from './counts.ts';

/** 和成员自己有关的群聊变动，作为一条内容进入它的时间线（不唤醒它）。 */
export interface IGroupEvent {
	/**
	 * restored：删除时解散的群聊随创建者恢复了。
	 * watched、unwatched：用户在网页端替成员关注、取消关注了这个群聊（成员自己用工具改的不记，工具结果里已经写了）。
	 */
	readonly type: 'added' | 'removed' | 'dissolved' | 'restored' | 'watched' | 'unwatched';
	readonly groupId: string;
	readonly groupName: string;
	/** 谁做的；用户在网页端做的是 null。 */
	readonly actorMemberId: string | null;
}

/** 模型返回的一个输出项（思考、文字、工具调用），按模型服务给的原样保存，下次请求时原样带回。 */
export interface IModelOutputItem {
	readonly type: string;
	readonly [key: string]: unknown;
}

/** 文字输出（type 是 message）的 content 里各段文字连起来。 */
export function messageText(content: unknown): string {
	return Array.isArray(content) ? content.map((part: { text?: unknown } | null) => typeof part?.text === 'string' ? part.text : '').join('') : '';
}

export interface IToolResult {
	readonly callId: string;
	readonly name: string;
	readonly output: string;
	readonly isError: boolean;
	/** 图片的资源 ID。 */
	readonly images?: readonly string[];
	/** 运行停止时这次调用没做完：before 是还没开始执行，during 是执行到一半。 */
	readonly stopped?: 'before' | 'during';
}

/** 后台任务结束：完成、出错、被取消（用户、成员自己，或者成员被删除时），或者运行时退出时中断。 */
export interface ITaskResult {
	readonly taskId: string;
	readonly toolName: string;
	readonly status: 'completed' | 'failed' | 'cancelled' | 'interrupted';
	/** 完成、出错时是结果；取消、中断时是到那时为止的输出。 */
	readonly output: string;
	/** 取消、中断时拿到的输出：有（在 output 里）、没有中途输出、运行时被强行结束没存下来。取消、中断时总有，完成、出错时没有。 */
	readonly stoppedOutput?: 'kept' | 'none' | 'lost';
	/** 成员自己取消、等了一会还没结束的：结束后结果另发。 */
	readonly cancelledByMember?: true;
	/**
	 * 这条结果交出来的时候，这个成员名下还在跑的其他后台任务（不含自己）。
	 * 全部列出、不截断：后台任务本来就不该多，真多起来多半是出问题（比如给自己起的定时任务忘了取消），列全了才看得见。
	 */
	readonly remainingTasks?: readonly { readonly taskId: string; readonly toolName: string }[];
	/** 成员被删除时取消的，不是用户取消的。 */
	readonly cancelledOnDelete?: true;
}

/**
 * 终端的变动，都和「成员在等用户交还」有关：released 是用户接管后把终端交还给 AI；declined 是用户不用接管，直接让成员继续；
 * closed、exited 是成员还在等的时候终端被关闭了、里面的程序退出了，等不到交还了。
 */
export interface ITerminalEvent {
	readonly terminalId: string;
	readonly event: 'released' | 'declined' | 'closed' | 'exited';
	/** closed 时：谁关的，user 是用户，否则是成员 ID。 */
	readonly closedBy?: string;
	/** exited 时：退出码。 */
	readonly exitCode?: number;
	/** 这个成员请用户接管时写的要做的事；没请过时是 null。 */
	readonly request: string | null;
	/** 成员在等这个终端：请过用户接管，或者用户操作期间调用过。在等的唤醒；没人在等时记给建终端的成员，不唤醒。closed、exited 只发给在等的。 */
	readonly waiting: boolean;
}

/** 路由投给成员的外部事件：来源、meta 和要投的文字（路由没改写时是事件的正文）。 */
export interface IExternalEventItem {
	readonly source: string;
	readonly meta: Readonly<Record<string, string>>;
	readonly text: string;
}

/** 用户在时间线里直接输入的话。不属于任何对话，进上下文时只有正文和附件，没有来源说明。 */
export interface IUserInput {
	readonly text: string;
	readonly attachments: readonly IAttachment[];
}

/**
 * 压缩写下的摘要。排在它所覆盖的最早那条内容的位置（anchorItemId 是那条内容的第一个 itemId）。
 * startTime、endTime 是它代替的内容的时间范围，代替的是摘要时按那些摘要的范围算；rangeText 是上下文里写的范围，
 * 压缩时按当时的时区写下，之后不改（见 timeRangeText）。counts 是它代替了哪些内容，给用户看。
 * keywords 是模型从被代替的内容里摘出、运行时核对过确实查得到的关键词，供以后查原文。
 */
export interface ISummary {
	readonly text: string;
	readonly keywords: readonly string[];
	readonly anchorItemId: number;
	readonly startTime: number;
	readonly endTime: number;
	readonly rangeText: string;
	readonly counts: IContentCounts;
}

/**
 * 没看过的内容太多时，拿出上下文的一批内容的说明。排在第一条被拿掉的内容的位置（anchorItemId），
 * startTime、endTime 是被拿掉的内容的时间范围，rangeText 是上下文里写的范围，拿出上下文时写下，之后不改；count 是条数。
 */
export interface IOmission {
	readonly anchorItemId: number;
	readonly startTime: number;
	readonly endTime: number;
	readonly rangeText: string;
	readonly count: number;
}

/** 压缩时对记忆的修改，给用户看，不进上下文。length 是改完的字数。 */
interface IMemoryChange {
	readonly operations: readonly MemoryOperation[];
	readonly length: number;
}

/** 压缩时的删除记录：这次删掉了哪些内容，给用户看，不进上下文。被删的内容不记是哪条删除记录删的。 */
interface IPruning {
	readonly counts: IContentCounts;
}

/** 压缩记录里的一次请求：思考的文字（摘要，没有时用原文）、输出的原文（没收到时是 null）、不合规的地方、自动重试过的错误、用量。 */
export interface IOptimizationRequestRecord {
	readonly requestId: number;
	readonly reasoning: string;
	readonly output: string | null;
	readonly problems: readonly string[];
	readonly retries: readonly string[];
	readonly inputTokens: number | null;
	readonly cachedTokens: number | null;
	readonly outputTokens: number | null;
}

/**
 * 压缩记录：一次压缩（一轮）的经过，给用户看，不进上下文。时机是运行中请求前、运行结束时、手动；
 * estimate 是整理前后按全部内容的估算，出错、停止时没有 after。
 */
export interface IOptimization {
	readonly trigger: 'before_request' | 'after_run' | 'manual';
	readonly status: 'completed' | 'failed' | 'stopped';
	readonly error: string | null;
	readonly startedAt: number;
	readonly endedAt: number;
	readonly estimate: { readonly before: number; readonly after: number | null };
	readonly requests: readonly IOptimizationRequestRecord[];
}

/**
 * 变动说明：成员能用的工具、技能、运行环境和通讯录变了，或者用户清空了它的计划、取消了它的定时。text 进上下文，brief 是给用户看的一句概括。
 * 运行时给成员的系统提示（如有后台任务在等终端、不必反复读取）也是这一种，brief 见 systemNotice。
 */
export interface IChangeNotice {
	readonly text: string;
	readonly brief: string;
}

/**
 * 系统提示：给用户看的那一句不另写，就是给成员的那段文字的第一句。它是说给成员的，用户想知道系统说了什么，点开看原文。
 */
export function systemNotice(text: string): IChangeNotice {
	const end = text.indexOf('。');
	return { text, brief: end < 0 ? text : text.slice(0, end + 1) };
}

/** 压缩后放回上下文的计划：放回时的事项，原样写成调用参数的 JSON（运行时设计第 5 部分「计划」）。 */
export interface IPlanNote {
	readonly items: readonly IPlanItem[];
}

/**
 * visible 进上下文；summarized 被摘要代替；pruned 被删掉；omitted 是没看过的内容太多时拿出了上下文；
 * unreturned 是没有实际产出的一轮，写进来时就定下，不带回上下文，之后不变。
 * 原内容都保留，查历史和时间线视图仍能看到。
 */
export type ContextState = 'visible' | 'summarized' | 'pruned' | 'omitted' | 'unreturned';

/**
 * 在上下文里的位置（运行时设计第 5 部分「上下文里的先后」）：requestId 是排在哪次回复请求那里，reply 是不是这次请求的输出和工具结果。
 * 收到的内容排在第一次看到它的请求前面（reply 是 false），还没被看到时 requestId 是 null，排在最后；
 * 摘要和没放进上下文的内容的说明用它们代替的最早那条内容的位置。
 */
export interface IContextPlace {
	readonly requestId: number | null;
	readonly reply: boolean;
}

/**
 * 这一轮有没有实际产出：工具调用，或者有文字的消息。模型没什么要说时会只给思考和一条空文字，
 * 这样的一轮记在时间线里，但整个不带回：空消息有的服务不接受带回，加密的思考又不能脱离它后面的输出项单独带回。
 */
export function hasVisibleOutput(outputs: readonly IModelOutputItem[]): boolean {
	return outputs.some(output => output.type === 'function_call' || (output.type === 'message' && messageText(output['content']).trim() !== ''));
}

interface IItemBase {
	readonly itemId: number;
	readonly wakes: boolean;
	readonly contextState: ContextState;
	readonly summaryItemId: number | null;
	readonly createdAt: number;
	/** 收到的内容带的时间：收到时判断要不要带，写下就不改（运行时设计第 5 部分「时间」）。别的内容不带。 */
	readonly time?: ITimeNote;
}

export type TimelineItem =
	| IItemBase & { readonly kind: 'message'; readonly messageId: number }
	| IItemBase & { readonly kind: 'group_event'; readonly event: IGroupEvent }
	| IItemBase & { readonly kind: 'model_output'; readonly requestId: number; readonly runId: number; readonly output: IModelOutputItem }
	| IItemBase & { readonly kind: 'tool_result'; readonly requestId: number; readonly runId: number; readonly result: IToolResult }
	| IItemBase & { readonly kind: 'task_result'; readonly task: ITaskResult }
	| IItemBase & { readonly kind: 'terminal_event'; readonly event: ITerminalEvent }
	| IItemBase & { readonly kind: 'external_event'; readonly external: IExternalEventItem }
	| IItemBase & { readonly kind: 'user_input'; readonly input: IUserInput }
	| IItemBase & { readonly kind: 'reminder'; readonly reminder: IReminderFired }
	| IItemBase & { readonly kind: 'summary'; readonly summary: ISummary }
	| IItemBase & { readonly kind: 'omission'; readonly omission: IOmission }
	| IItemBase & { readonly kind: 'memory_change'; readonly change: IMemoryChange }
	| IItemBase & { readonly kind: 'pruning'; readonly pruning: IPruning }
	| IItemBase & { readonly kind: 'optimization'; readonly optimization: IOptimization }
	| IItemBase & { readonly kind: 'change_notice'; readonly notice: IChangeNotice }
	| IItemBase & { readonly kind: 'plan'; readonly plan: IPlanNote };

type ItemKind = TimelineItem['kind'];

/** 收到的内容：写进时间线时判断要不要带时间（运行时设计第 5 部分「时间」）。变动说明不算。 */
const ARRIVALS: ReadonlySet<ItemKind> = new Set(['message', 'group_event', 'task_result', 'reminder', 'terminal_event', 'external_event', 'user_input']);

/** 收到的内容：在上下文里排在第一次看到它的请求前面。比 ARRIVALS 多了变动说明和计划说明。 */
const INCOMING_SQL = [...ARRIVALS, 'change_notice', 'plan'].map(kind => `'${kind}'`).join(', ');

interface ITimelineRow {
	readonly item_id: number;
	readonly kind: ItemKind;
	readonly message_id: number | null;
	readonly request_id: number | null;
	readonly payload_json: string | null;
	readonly wakes: number;
	readonly context_state: ContextState;
	readonly summary_item_id: number | null;
	readonly seen_request_id: number | null;
	readonly created_at: number;
	readonly time_text: string | null;
	readonly time_at: number | null;
	readonly time_zone: string | null;
	readonly time_full: number | null;
	/** 模型输出和工具结果所属的运行（从 model_requests 查出）。 */
	readonly run_id: number | null;
}

type IPlaceRow = Pick<ITimelineRow, 'request_id' | 'seen_request_id'>;

/** 条目在上下文里的位置：输出和工具结果是它所属的请求，收到的内容是第一次看到它的请求。 */
function placeOf(row: IPlaceRow): IContextPlace {
	return row.request_id !== null ? { requestId: row.request_id, reply: true } : { requestId: row.seen_request_id, reply: false };
}

/** 要写进时间线的一条。 */
interface IEntry {
	readonly kind: ItemKind;
	readonly messageId?: number;
	readonly requestId?: number;
	readonly payload?: object;
	readonly wakes?: boolean;
	readonly contextState?: ContextState;
}

/** 查时间线条目，带上所属运行。 */
const SELECT_ITEM = 'SELECT item.*, request.run_id FROM timeline_items item LEFT JOIN model_requests request ON request.request_id = item.request_id';

/** 每个 AI 成员一条时间线，按先后排列它经历的一切。真人不运行模型，没有时间线。 */
export class Timeline {
	private readonly db: Database;
	private readonly events: EventHub;
	private readonly attachments: Attachments;
	private readonly now: () => number;

	constructor(db: Database, events: EventHub, attachments: Attachments, now: () => number = Date.now) {
		this.db = db;
		this.events = events;
		this.attachments = attachments;
		this.now = now;
	}

	/** 把收到的消息记进成员时间线；真人直接跳过。 */
	appendMessage(memberId: string, messageId: number, wakes: boolean): void {
		if (!this.isAi(memberId)) return;
		this.append(memberId, [{ kind: 'message', messageId, wakes }]);
	}

	appendGroupEvent(memberId: string, event: IGroupEvent): void {
		if (!this.isAi(memberId)) return;
		this.append(memberId, [{ kind: 'group_event', payload: event }]);
	}

	/** 一次请求的全部输出，返回各自的条目 ID，顺序和 outputs 一样。没有实际产出的一轮记成 unreturned，不带回上下文。 */
	appendModelOutputs(memberId: string, requestId: number, outputs: readonly IModelOutputItem[]): number[] {
		const contextState = hasVisibleOutput(outputs) ? 'visible' : 'unreturned';
		return outputs.length > 0 ? this.append(memberId, outputs.map(output => ({ kind: 'model_output', requestId, payload: output, contextState }))) : [];
	}

	appendToolResult(memberId: string, requestId: number, result: IToolResult): void {
		this.append(memberId, [{ kind: 'tool_result', requestId, payload: result }]);
	}

	appendTaskResult(memberId: string, task: ITaskResult, wakes: boolean): void {
		this.append(memberId, [{ kind: 'task_result', payload: task, wakes }]);
	}

	/** 定时到了：唤醒成员。 */
	appendReminder(memberId: string, fired: IReminderFired): void {
		this.append(memberId, [{ kind: 'reminder', payload: fired, wakes: true }]);
	}

	appendTerminalEvent(memberId: string, event: ITerminalEvent): void {
		this.append(memberId, [{ kind: 'terminal_event', payload: event, wakes: event.waiting }]);
	}

	/** 外部事件。成员由调用方检查。 */
	appendExternalEvent(memberId: string, event: IExternalEventItem, wakes: boolean): void {
		this.append(memberId, [{ kind: 'external_event', payload: event, wakes }]);
	}

	/** 用户直接输入，会唤醒成员。附件先上传拿到 ID。成员由调用方检查。 */
	appendUserInput(memberId: string, input: { readonly text: string; readonly attachmentIds?: readonly string[] }): TimelineItem {
		const attachmentIds = input.attachmentIds ?? [];
		if (typeof input.text !== 'string') throw invalid('内容必须是文字');
		if (!input.text.trim() && attachmentIds.length === 0) throw invalid('内容不能为空');
		if (input.text.length > MAX_TEXT_LENGTH) throw invalid(`内容过长，最多 ${MAX_TEXT_LENGTH} 个字符`);
		if (attachmentIds.length > MAX_ATTACHMENTS) throw invalid(`一次最多 ${MAX_ATTACHMENTS} 个附件`);
		for (const attachmentId of attachmentIds) this.attachments.require(attachmentId);
		const payload = attachmentIds.length > 0 ? { text: input.text, attachments: attachmentIds } : { text: input.text };
		const itemId = this.append(memberId, [{ kind: 'user_input', payload, wakes: true }])[0]!;
		return this.get(memberId, itemId)!;
	}

	/** 成员时间线里的一条内容；没有时是 undefined。 */
	get(memberId: string, itemId: number): TimelineItem | undefined {
		const row = this.db.get<ITimelineRow>(`${SELECT_ITEM} WHERE item.item_id = ? AND item.member_id = ?`, itemId, memberId);
		return row && this.toItem(row);
	}

	appendSummary(memberId: string, summary: ISummary): number {
		return this.append(memberId, [{ kind: 'summary', payload: summary }])[0]!;
	}

	/** 把没看过的一批内容拿出上下文，在第一条的位置放一条说明。返回说明的 itemId。 */
	omit(memberId: string, items: readonly TimelineItem[]): number {
		const startTime = items[0]!.createdAt;
		const endTime = items.at(-1)!.createdAt;
		const omission: IOmission = { anchorItemId: items[0]!.itemId, startTime, endTime, rangeText: timeRangeText(startTime, endTime), count: items.length };
		const itemId = this.append(memberId, [{ kind: 'omission', payload: omission }])[0]!;
		this.setContextState(memberId, items.map(item => item.itemId), 'omitted', null);
		return itemId;
	}

	appendMemoryChange(memberId: string, change: IMemoryChange): void {
		this.append(memberId, [{ kind: 'memory_change', payload: change }]);
	}

	appendPruning(memberId: string, pruning: IPruning): void {
		this.append(memberId, [{ kind: 'pruning', payload: pruning }]);
	}

	/** 压缩记录，排在这次压缩的结果前面。返回 itemId：结果写完后整理后的估算才知道，在同一个事务里用 updateOptimization 补上。 */
	appendOptimization(memberId: string, optimization: IOptimization): number {
		return this.append(memberId, [{ kind: 'optimization', payload: optimization }])[0]!;
	}

	updateOptimization(memberId: string, itemId: number, optimization: IOptimization): void {
		this.db.run(`UPDATE timeline_items SET payload_json = ? WHERE item_id = ? AND member_id = ? AND kind = 'optimization'`, JSON.stringify(optimization), itemId, memberId);
	}

	/** 变动说明：请求前比较出来的，或者用户清空了计划、取消了定时时写的，不唤醒。运行时给成员的系统提示也用它。 */
	appendChangeNotice(memberId: string, notice: IChangeNotice): void {
		this.append(memberId, [{ kind: 'change_notice', payload: notice }]);
	}

	/** 计划说明：压缩后放回的计划，不唤醒。返回 itemId。 */
	appendPlan(memberId: string, items: readonly IPlanItem[]): number {
		const plan: IPlanNote = { items };
		return this.append(memberId, [{ kind: 'plan', payload: plan }])[0]!;
	}

	/** 这些内容改为被摘要代替、被删掉或拿出上下文。 */
	setContextState(memberId: string, itemIds: readonly number[], state: Exclude<ContextState, 'visible' | 'unreturned'>, summaryItemId: number | null): void {
		if (itemIds.length === 0) return;
		// 一次压缩可能改几千条，用一条语句改完。
		this.db.run(
			'UPDATE timeline_items SET context_state = ?, summary_item_id = ? WHERE member_id = ? AND item_id IN (SELECT value FROM json_each(?))',
			state, summaryItemId, memberId, JSON.stringify(itemIds),
		);
		this.events.emit({ type: 'timeline.updated', memberId, itemIds });
	}

	/**
	 * 旧摘要被新摘要代替：它们代替的内容改为直接指向新摘要，任何内容到当前的摘要都只有一跳。
	 * 被代替的摘要不再进上下文，查历史也不查摘要，留着中间这一跳没有用。状态不变，不推送。
	 */
	repointSummarized(memberId: string, oldSummaryIds: readonly number[], summaryItemId: number): void {
		if (oldSummaryIds.length === 0) return;
		this.db.run(
			'UPDATE timeline_items SET summary_item_id = ? WHERE member_id = ? AND summary_item_id IN (SELECT value FROM json_each(?))',
			summaryItemId, memberId, JSON.stringify(oldSummaryIds),
		);
	}

	/** 旧摘要被删掉：它们代替的内容也改为已删除，不再指向摘要，这时已经没有摘要代表它们了。 */
	pruneSummarized(memberId: string, oldSummaryIds: readonly number[]): void {
		if (oldSummaryIds.length === 0) return;
		const itemIds = this.db.all<{ item_id: number }>(
			`UPDATE timeline_items SET context_state = 'pruned', summary_item_id = NULL WHERE member_id = ? AND summary_item_id IN (SELECT value FROM json_each(?)) RETURNING item_id`,
			memberId, JSON.stringify(oldSummaryIds),
		).map(row => row.item_id);
		if (itemIds.length > 0) this.events.emit({ type: 'timeline.updated', memberId, itemIds });
	}

	/** 被这些摘要代替的内容，按先后，从 afterItemId 之后取 limit 条。 */
	summarizedBy(memberId: string, summaryIds: readonly number[], afterItemId: number, limit: number): TimelineItem[] {
		if (summaryIds.length === 0) return [];
		return this.db.all<ITimelineRow>(
			`${SELECT_ITEM} WHERE item.summary_item_id IN (SELECT value FROM json_each(?)) AND item.member_id = ? AND item.item_id > ? ORDER BY item.item_id LIMIT ?`,
			JSON.stringify(summaryIds), memberId, afterItemId, limit,
		).map(row => this.toItem(row));
	}

	/** 按先后返回一段：给了 beforeItemId 时取它之前最近的一段，否则从 afterItemId 之后往后取。 */
	list(memberId: string, options: { readonly afterItemId?: number; readonly beforeItemId?: number; readonly limit?: number } = {}): TimelineItem[] {
		const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
		if (options.beforeItemId !== undefined) {
			return this.db.all<ITimelineRow>(
				`${SELECT_ITEM} WHERE item.member_id = ? AND item.item_id < ? ORDER BY item.item_id DESC LIMIT ?`, memberId, options.beforeItemId, limit,
			).reverse().map(row => this.toItem(row));
		}
		return this.db.all<ITimelineRow>(
			`${SELECT_ITEM} WHERE item.member_id = ? AND item.item_id > ? ORDER BY item.item_id LIMIT ?`, memberId, options.afterItemId ?? 0, limit,
		).map(row => this.toItem(row));
	}

	/**
	 * 在上下文里的条目，按写进来的先后，带着在上下文里的位置。只读在上下文里的，耗时和时间线多长无关；
	 * 摘要和说明的位置按它们代替的最早那条内容查。
	 */
	inContext(memberId: string): { readonly item: TimelineItem; readonly place: IContextPlace }[] {
		const rows = this.db.all<ITimelineRow>(`${SELECT_ITEM} WHERE item.member_id = ? AND item.context_state = 'visible' ORDER BY item.item_id`, memberId);
		return rows.map(row => {
			const item = this.toItem(row);
			if (item.kind !== 'summary' && item.kind !== 'omission') return { item, place: placeOf(row) };
			const anchorItemId = item.kind === 'summary' ? item.summary.anchorItemId : item.omission.anchorItemId;
			const anchor = this.db.get<IPlaceRow>('SELECT request_id, seen_request_id FROM timeline_items WHERE item_id = ? AND member_id = ?', anchorItemId, memberId);
			return { item, place: anchor ? placeOf(anchor) : { requestId: null, reply: false } };
		});
	}

	/**
	 * 一次回复请求发出时，它看到的收到的内容里还没有位置的，记上这次请求：在上下文里排在这次请求前面。
	 * 条件里有 timeline_items_unplaced_idx 的条件，只扫还没有位置的。
	 */
	markRequested(memberId: string, requestId: number, throughItemId: number): void {
		this.db.run(
			`UPDATE timeline_items SET seen_request_id = ? WHERE member_id = ? AND item_id <= ? AND seen_request_id IS NULL AND request_id IS NULL AND kind IN (${INCOMING_SQL})`,
			requestId, memberId, throughItemId,
		);
	}

	/** 按先后取 afterItemId 之后的最多 limit 条：查历史分批扫整条时间线，每批读的行数有上限。 */
	batch(memberId: string, afterItemId: number, limit: number): TimelineItem[] {
		return this.db.all<ITimelineRow>(`${SELECT_ITEM} WHERE item.member_id = ? AND item.item_id > ? ORDER BY item.item_id LIMIT ?`, memberId, afterItemId, limit).map(row => this.toItem(row));
	}

	/** 整条时间线。 */
	all(memberId: string): TimelineItem[] {
		return this.db.all<ITimelineRow>(`${SELECT_ITEM} WHERE item.member_id = ? ORDER BY item.item_id`, memberId).map(row => this.toItem(row));
	}

	/** 一次模型请求的输出和工具结果，按先后。 */
	forRequest(memberId: string, requestId: number): TimelineItem[] {
		return this.db.all<ITimelineRow>(`${SELECT_ITEM} WHERE item.member_id = ? AND item.request_id = ? ORDER BY item.item_id`, memberId, requestId).map(row => this.toItem(row));
	}

	latestItemId(memberId: string): number {
		return this.db.get<{ id: number | null }>('SELECT MAX(item_id) AS id FROM timeline_items WHERE member_id = ?', memberId)?.id ?? 0;
	}

	/** 模型已经看到哪一条为止。只会往后移。 */
	markSeen(memberId: string, throughItemId: number): void {
		this.db.run('UPDATE member_states SET seen_through_item_id = ? WHERE member_id = ? AND seen_through_item_id < ?', throughItemId, memberId, throughItemId);
	}

	/** 模型还没看过的内容里，有没有会唤醒成员的。 */
	hasPendingWake(memberId: string): boolean {
		return this.db.get(`
			SELECT 1 FROM timeline_items item
			JOIN member_states state ON state.member_id = item.member_id
			WHERE item.member_id = ? AND item.wakes = 1 AND item.item_id > state.seen_through_item_id
			LIMIT 1
		`, memberId) !== undefined;
	}

	/** 数据库里的一行转成时间线条目；直接输入的附件按 ID 取出附件信息。 */
	private toItem(row: ITimelineRow): TimelineItem {
		const item = toItem(row);
		if (item.kind !== 'user_input') return item;
		const { text, attachments } = JSON.parse(row.payload_json!) as { text: string; attachments?: string[] };
		return { ...item, input: { text, attachments: (attachments ?? []).map(attachmentId => this.attachments.require(attachmentId)) } };
	}

	private isAi(memberId: string): boolean {
		return this.db.get<{ type: string }>('SELECT type FROM members WHERE member_id = ?', memberId)?.type === 'ai';
	}

	/** 成员开没开时间感知：member.json 没写时开着。只在收到内容时看，改了只影响之后收到的。 */
	private timeAware(memberId: string): boolean {
		const row = this.db.get<{ definition_json: string }>('SELECT definition_json FROM members WHERE member_id = ?', memberId);
		return row !== undefined && (JSON.parse(row.definition_json) as { timeAwareness?: boolean }).timeAwareness !== false;
	}

	/** 收到的内容要不要带时间（运行时设计第 5 部分「时间」）：只和上下文里还留着的内容带的时间比，被摘要、删掉、拿出上下文的不算。 */
	private timeNote(memberId: string): ITimeNote | undefined {
		const latest = (full: boolean) => this.db.get<IClock>(
			`SELECT time_at AS at, time_zone AS timeZone FROM timeline_items WHERE member_id = ? AND context_state = 'visible' AND time_text IS NOT NULL${full ? ' AND time_full = 1' : ''} ORDER BY item_id DESC LIMIT 1`,
			memberId,
		);
		return nextTimeNote(latest(true), latest(false), clockAt(this.now()));
	}

	/** 写进时间线。成员开着时间感知时，收到的内容判断要不要带时间，时间和内容在同一行；一次写好几条时，后面的和前面刚写下的比。 */
	private append(memberId: string, entries: readonly IEntry[]): number[] {
		const now = Date.now();
		const aware = entries.some(entry => ARRIVALS.has(entry.kind)) && this.timeAware(memberId);
		const itemIds = entries.map(entry => {
			const note = aware && ARRIVALS.has(entry.kind) ? this.timeNote(memberId) : undefined;
			return this.db.run(
				'INSERT INTO timeline_items (member_id, kind, message_id, request_id, payload_json, wakes, context_state, time_text, time_at, time_zone, time_full, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
				memberId, entry.kind, entry.messageId ?? null, entry.requestId ?? null,
				entry.payload === undefined ? null : JSON.stringify(entry.payload), entry.wakes ? 1 : 0, entry.contextState ?? 'visible',
				note?.text ?? null, note?.at ?? null, note?.timeZone ?? null, note === undefined ? null : note.full ? 1 : 0, now,
			).lastId;
		});
		this.events.emit({ type: 'timeline.appended', memberId, itemIds });
		return itemIds;
	}
}

function toItem(row: ITimelineRow): TimelineItem {
	const base = {
		itemId: row.item_id, wakes: row.wakes === 1, contextState: row.context_state, summaryItemId: row.summary_item_id, createdAt: row.created_at,
		...row.time_text === null ? {} : { time: { text: row.time_text, at: row.time_at!, timeZone: row.time_zone!, full: row.time_full === 1 } },
	};
	const payload = row.payload_json === null ? undefined : JSON.parse(row.payload_json);
	switch (row.kind) {
		case 'message': return { ...base, kind: 'message', messageId: row.message_id! };
		case 'group_event': return { ...base, kind: 'group_event', event: payload as IGroupEvent };
		case 'model_output': return { ...base, kind: 'model_output', requestId: row.request_id!, runId: row.run_id!, output: payload as IModelOutputItem };
		case 'tool_result': return { ...base, kind: 'tool_result', requestId: row.request_id!, runId: row.run_id!, result: payload as IToolResult };
		case 'task_result': return { ...base, kind: 'task_result', task: payload as ITaskResult };
		case 'terminal_event': return { ...base, kind: 'terminal_event', event: payload as ITerminalEvent };
		case 'external_event': return { ...base, kind: 'external_event', external: payload as IExternalEventItem };
		case 'user_input': return { ...base, kind: 'user_input', input: payload as IUserInput };
		case 'reminder': return { ...base, kind: 'reminder', reminder: payload as IReminderFired };
		case 'summary': return { ...base, kind: 'summary', summary: payload as ISummary };
		case 'omission': return { ...base, kind: 'omission', omission: payload as IOmission };
		case 'memory_change': return { ...base, kind: 'memory_change', change: payload as IMemoryChange };
		case 'pruning': return { ...base, kind: 'pruning', pruning: payload as IPruning };
		case 'optimization': return { ...base, kind: 'optimization', optimization: payload as IOptimization };
		case 'change_notice': return { ...base, kind: 'change_notice', notice: payload as IChangeNotice };
		case 'plan': return { ...base, kind: 'plan', plan: payload as IPlanNote };
	}
}
