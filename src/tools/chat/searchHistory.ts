import { setImmediate as nextTurn } from 'node:timers/promises';
import { invalid } from '../../common/errors.ts';
import { addDays, firstInstantFrom, formatLocal, formatOffset, instantsOf, isTimeZone, localTime, offset, parseDateTime, systemTimeZone } from '../../common/time.ts';
import type { ConversationTarget, IMessage, ISearchableMessage, Messages } from '../../messages/messages.ts';
import { externalBody, searchText, type Describer } from '../../runs/describe.ts';
import { messageText, type Timeline, type TimelineItem } from '../../timeline/timeline.ts';
import type { ITool } from '../tools.ts';
import { parseTarget } from './sendMessage.ts';

const NAME = 'search_history';
const MAX_KEYWORDS = 16;
const MAX_KEYWORD_LENGTH = 128;
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;
/** 返回的各条合计最多多少字：每条默认返回全文，按先后放入，放不下的整条不返回。 */
const MAX_TOTAL_CHARS = 25_000;
const TIME_FORMAT = 'YYYY-MM-DD HH:mm:ss';
const TIME_PATTERN = /^(\d{4})-(\d{1,2})-(\d{1,2})(?: (\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
/** send_message 发出的内容按对话消息查，不再查那次调用，免得同一条出现两次；查历史本身的调用和结果不查。 */
const SKIPPED_TOOLS = ['send_message', NAME];

/**
 * 分批扫的大小：消息按 ID 一段一段扫（看不到的消息也要扫过，按 ID 段限住每次扫的行数），时间线每批取这么多条。
 * 批与批之间让出主线程：消息和时间线很长时，查一次不会一直占着运行时。
 */
export interface IScanBatch {
	readonly messageSpan: number;
	readonly timelineItems: number;
}

const SCAN_BATCH: IScanBatch = { messageSpan: 20_000, timelineItems: 2000 };

/**
 * 找到的一条：消息或时间线里的一条。body 是用来匹配关键词的正文（带附件那几行），
 * text 是返回时写的正文（附件由来源的写法自己加上），截短时截它。
 */
interface IEntry {
	readonly time: number;
	readonly sequence: number;
	readonly body: string;
	readonly text: string;
	readonly source: { readonly message: ISearchableMessage } | { readonly item: TimelineItem };
}

/**
 * 找到的历史：total 是一共找到几条，entries 是按 limit 返回的那些，text 开头写明来源。
 * omitted 是 limit 以内、因合计超过 2.5 万字而未返回的条数。
 * time 按 timeZone 写；返回的几条 UTC 偏移相同时 offset 是它，time 不带偏移；不同时（中间跨了夏令时切换）offset 是 null，每条 time 后面带自己的偏移。
 */
export interface ISearchResult {
	readonly total: number;
	readonly omitted: number;
	readonly timeZone: string;
	readonly offset: string | null;
	readonly entries: readonly { readonly time: string; readonly text: string }[];
}

/**
 * 查自己的历史：发出和收到的全部对话消息，用户直接输入的话，外部事件，以及自己直接输出的内容、工具调用和结果。
 * 不搜思考，也不搜 send_message 和查历史本身的调用。调用时还在上下文里的不查：模型正看着原文（运行时设计第 5 部分「查历史」）。
 */
export function createSearchHistoryTool(messages: Messages, timeline: Timeline, describer: Describer, scan: IScanBatch = SCAN_BATCH): ITool<ISearchResult> {
	return {
		name: NAME,
		label: '查找历史记录',
		progressive: true,
		description: [
			'查找你自己的历史记录：私聊和群聊消息、用户输入、外部事件、你的输出、工具调用及其结果。',
			'用于查找你已看不到原文的早期内容，如已被摘要代替或删除的内容；你现在仍能看到原文的内容不会被查找。新消息会直接送达，不要用本工具检查或等待新消息。',
		].join('\n'),
		defaultPolicy: 'allow',
		returns: '{ total: number; omitted: number; timeZone: string; offset: string | null; entries: { time: string; text: string }[] }',
		parameters: {
			type: 'object',
			properties: {
				keywords: { type: 'array', items: { type: 'string' }, description: '关键词，不区分大小写；不写时不按关键词筛选' },
				match: { type: 'string', enum: ['all', 'any'], description: 'all 要求包含全部关键词，any 包含任一个即可；默认 all' },
				conversation: { type: 'string', description: '仅查找指定的私聊或群聊：成员 ID（M_ 开头）或群聊 ID（G_ 开头）' },
				sender: { type: 'string', description: '仅查找该成员发送的消息（成员 ID）' },
				start_time: { type: 'string', description: `仅查找该时间及以后的内容，格式为 ${TIME_FORMAT}，可省略秒或时刻；按 timezone 解释` },
				end_time: { type: 'string', description: `仅查找该时间及以前的内容，格式同 start_time；只写日期时包含当天全天，只写到分钟时包含该分钟` },
				timezone: { type: 'string', description: 'start_time、end_time 所用的时区，结果中的时间也按此时区表示：IANA 时区名，如 America/Chicago。不写时使用运行时所在机器的当前时区。按上下文中的时间查找时，填写该时间所标注的时区' },
				order: { type: 'string', enum: ['latest', 'oldest'], description: 'latest 先返回较新的，oldest 先返回较早的；默认 latest' },
				limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, description: `最多返回的条数，默认 ${DEFAULT_LIMIT}，最大 ${MAX_LIMIT}；各条合计最多 2.5 万字，超出的条目不返回` },
				max_chars_per_entry: { type: 'integer', minimum: 1, description: '每条正文最多返回的字符数，超出部分截去；不写时返回全文' },
				images_only: { type: 'boolean', description: '为 true 时仅查找含图片的内容：带图片附件的消息和用户输入，以及带图片的工具结果' },
			},
			additionalProperties: false,
		},
		async execute(context, args) {
			const keywords = readKeywords(args['keywords']);
			const match = readEnum(args, 'match', ['all', 'any'], 'all');
			const order = readEnum(args, 'order', ['latest', 'oldest'], 'latest');
			const limit = readLimit(args['limit']);
			const maxChars = readMaxChars(args['max_chars_per_entry']);
			const conversation = readConversation(args['conversation']);
			const imagesOnly = readImagesOnly(args['images_only']);
			const sender = args['sender'];
			if (sender !== undefined && typeof sender !== 'string') throw invalid('sender 必须是成员 ID');
			const timeZone = readTimeZone(args['timezone']);
			const startTime = readTime(args, 'start_time', false, timeZone);
			const endTime = readTime(args, 'end_time', true, timeZone);
			if (startTime !== undefined && endTime !== undefined && startTime > endTime) throw invalid('start_time 不能晚于 end_time');

			const viewer = context.memberId;
			const lowered = keywords.map(keyword => keyword.toLowerCase());
			const matches = (entry: IEntry) => {
				if ((startTime !== undefined && entry.time < startTime) || (endTime !== undefined && entry.time > endTime)) return false;
				if (lowered.length === 0) return true;
				const body = entry.body.toLowerCase();
				return match === 'all' ? lowered.every(keyword => body.includes(keyword)) : lowered.some(keyword => body.includes(keyword));
			};
			// 只留排在最前面的 limit 条，其余的只计数：不用把找到的全部留着再排。先后按时间，同一时间按 ID。
			let total = 0;
			const shown: IEntry[] = [];
			const ahead = (left: IEntry, right: IEntry) => {
				const difference = (left.time - right.time) || (left.sequence - right.sequence);
				return order === 'latest' ? difference > 0 : difference < 0;
			};
			const consider = (entry: IEntry) => {
				if (!matches(entry)) return;
				total++;
				if (shown.length === limit && !ahead(entry, shown.at(-1)!)) return;
				const index = shown.findIndex(other => ahead(entry, other));
				shown.splice(index === -1 ? shown.length : index, 0, entry);
				if (shown.length > limit) shown.pop();
			};

			// 代发的外部事件连 meta 一起搜，meta 已经在 body 里。开始查以后新来的不算。
			const filter = { target: conversation, senderMemberId: sender, startTime, endTime, imagesOnly };
			const latestMessage = messages.latestMessageId();
			for (let after = 0; after < latestMessage; after += scan.messageSpan) {
				for (const message of messages.searchable(viewer, filter, after, Math.min(after + scan.messageSpan, latestMessage))) {
					const text = message.external ? externalBody(message.external.meta, message.text) : message.text;
					consider({ time: message.sentAt, sequence: message.messageId, body: searchText(text, message.attachments), text, source: { message } });
				}
				await nextTurn();
				context.signal.throwIfAborted();
			}
			// 自己的文字和工具调用不属于哪个对话、也不是谁发的消息，限定了对话或发送者时不搜。
			if (!conversation && sender === undefined) {
				const latestItem = timeline.latestItemId(viewer);
				for (let after = 0; after < latestItem;) {
					const batch = timeline.batch(viewer, after, scan.timelineItems);
					if (batch.length === 0) break;
					for (const item of batch) {
						// 还在上下文里的不查；开始查以后新写的不算。
						if (item.itemId > latestItem || item.contextState === 'visible' || (imagesOnly && !hasImages(item))) continue;
						const text = itemText(item);
						if (text !== undefined) consider({ time: item.createdAt, sequence: item.itemId, body: matchedText(item, text), text, source: { item } });
					}
					after = batch.at(-1)!.itemId;
					await nextTurn();
					context.signal.throwIfAborted();
				}
			}

			const full = messages.getMany(shown.flatMap(entry => 'message' in entry.source ? [entry.source.message.messageId] : []));
			const render = (entry: IEntry, text: string) => 'message' in entry.source
				? renderMessage(describer, viewer, full.get(entry.source.message.messageId)!, text)
				: renderItem(describer, entry.source.item, text);
			// 按先后放入，合计超过上限时后面的整条不返回；第一条就超过时只截这一条。
			const returned: { entry: IEntry; text: string }[] = [];
			let used = 0;
			for (const entry of shown) {
				const body = maxChars === undefined ? entry.text : truncate(entry.text, maxChars);
				let text = render(entry, body);
				if (used + text.length > MAX_TOTAL_CHARS) {
					if (returned.length > 0) break;
					text = render(entry, truncate(entry.text, Math.max(0, MAX_TOTAL_CHARS - (text.length - body.length))));
				}
				used += text.length;
				returned.push({ entry, text });
			}
			const offsets = new Set(returned.map(({ entry }) => formatOffset(offset(entry.time, timeZone))));
			const uniform = offsets.size === 1 ? [...offsets][0]! : null;
			return {
				total,
				omitted: shown.length - returned.length,
				timeZone,
				offset: uniform,
				entries: returned.map(({ entry, text }) => {
					const time = formatLocal(localTime(entry.time, timeZone), 'always');
					return { time: uniform ? time : `${time} ${formatOffset(offset(entry.time, timeZone))}`, text };
				}),
			};
		},
		format(result) {
			if (result.total === 0) return '未找到匹配的历史记录。本工具只查找你已看不到原文的早期内容（已被摘要代替或删除的内容），你现在仍能看到原文的内容不会被查找。';
			const zone = `时区为 ${result.timeZone}${result.offset ? `（${result.offset}）` : ''}`;
			const header = result.total > result.entries.length ? `共找到 ${result.total} 条，显示前 ${result.entries.length} 条，${zone}：` : `找到 ${result.total} 条，${zone}：`;
			const note = result.omitted > 0
				? [`（另有 ${result.omitted} 条因合计超过 2.5 万字未返回；可缩小查找范围、减少 limit，或设置 max_chars_per_entry 只返回每条的开头）`]
				: [];
			return [header, ...result.entries.map(entry => `[${entry.time}] ${entry.text}`), ...note].join('\n\n');
		},
	};
}

/**
 * 时间线里一条能搜的内容的正文：自己直接输出的文字、工具调用和结果、用户直接说的话、外部事件、后台任务的结果。别的不搜。
 * 用户直接说的话，匹配时还要加上附件那几行（searchableItemText）。
 */
function itemText(item: TimelineItem): string | undefined {
	if (item.kind === 'model_output' && item.output.type === 'message') {
		const text = messageText(item.output['content']);
		return text.trim() ? text : undefined;
	}
	if (item.kind === 'model_output' && item.output.type === 'function_call') {
		const name = String(item.output['name']);
		return SKIPPED_TOOLS.includes(name) ? undefined : `${name} ${String(item.output['arguments'] ?? '')}`;
	}
	if (item.kind === 'tool_result') return SKIPPED_TOOLS.includes(item.result.name) ? undefined : item.result.output;
	if (item.kind === 'user_input') return item.input.text;
	if (item.kind === 'external_event') return externalBody(item.external.meta, item.external.text);
	if (item.kind === 'task_result') return item.task.output || undefined;
	return undefined;
}

/** 时间线里一条内容查历史时匹配用的正文；查不到的内容是 undefined。压缩时校验摘要的关键词也用它。 */
export function searchableItemText(item: TimelineItem): string | undefined {
	const text = itemText(item);
	return text === undefined ? undefined : matchedText(item, text);
}

/** 匹配用的正文：用户直接说的话加上附件那几行，其他的就是正文。 */
function matchedText(item: TimelineItem, text: string): string {
	return item.kind === 'user_input' ? searchText(text, item.input.attachments) : text;
}

/** 带图片：带图片附件的用户输入，带图片的工具结果。 */
function hasImages(item: TimelineItem): boolean {
	if (item.kind === 'user_input') return item.input.attachments.some(attachment => attachment.kind === 'image');
	return item.kind === 'tool_result' && (item.result.images?.length ?? 0) > 0;
}

/** 找到的消息写给成员看的样子：body 是要返回的正文（可能已截断），外部事件的 meta 已经在 body 里。 */
function renderMessage(describer: Describer, viewer: string, message: IMessage, body: string): string {
	return describer.message(viewer, { ...message, text: body, external: message.external && { source: message.external.source, meta: {} } });
}

/** 找到的时间线内容写给成员看的样子：body 是要返回的正文（可能已截断）。 */
function renderItem(describer: Describer, item: TimelineItem, body: string): string {
	switch (item.kind) {
		case 'model_output': return item.output.type === 'message' ? `你直接输出的内容：\n${body}` : `你调用了工具：\n${body}`;
		case 'tool_result': return `工具 ${item.result.name} 的结果${item.result.isError ? '（出错）' : ''}：\n${body}`;
		case 'user_input': return describer.userInput({ ...item.input, text: body });
		case 'external_event': return describer.externalEvent({ source: item.external.source, meta: {}, text: body });
		case 'task_result': return describer.taskResult({ ...item.task, output: body });
		default: throw new Error(`无法查找的内容：${item.kind}`);
	}
}

function readTimeZone(value: unknown): string {
	if (value === undefined || value === null) return systemTimeZone();
	if (typeof value !== 'string' || !isTimeZone(value)) throw invalid(`无法识别的时区「${String(value)}」，须为 IANA 时区名，如 America/Chicago`);
	return value;
}

function readTime(args: Record<string, unknown>, key: string, end: boolean, timeZone: string): number | undefined {
	const value = args[key];
	if (value === undefined || value === null) return undefined;
	const time = typeof value === 'string' ? timeBoundary(value, end, timeZone) : undefined;
	if (time === undefined) throw invalid(`${key} 的格式为 ${TIME_FORMAT}，可省略秒或时刻，如 2026-11-01 10:02 或 2026-11-01`);
	return time;
}

/**
 * 时间范围的一端（运行时设计第 5 部分「查历史」）：开始时间是写的这一段（这一秒、这一分钟或这一天）的第一刻，结束时间是最后一刻。
 * 秋天往回拨那天出现两次的时刻，开始按第一次、结束按第二次；春天往前拨跳过的时刻，开始从切换起，结束到切换前为止。格式不对时是 undefined。
 */
export function timeBoundary(text: string, end: boolean, timeZone: string): number | undefined {
	const match = TIME_PATTERN.exec(text.trim());
	if (!match) return undefined;
	const [, year, month, day, hour, minute, second] = match;
	const local = parseDateTime(`${year}-${month}-${day} ${hour ?? '0'}:${minute ?? '00'}${second === undefined ? '' : `:${second}`}`);
	if (!local) return undefined;
	if (!end) return firstInstantFrom(local, timeZone);
	if (hour === undefined) return firstInstantFrom(addDays(local, 1), timeZone) - 1;
	const last = instantsOf(local, timeZone).at(-1);
	return last === undefined ? firstInstantFrom(local, timeZone) - 1 : last + (second === undefined ? 60_000 : 1000) - 1;
}

function readKeywords(value: unknown): string[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) throw invalid('keywords 必须是字符串数组');
	const keywords = value.filter(keyword => keyword.trim());
	if (keywords.length > MAX_KEYWORDS) throw invalid(`keywords 最多 ${MAX_KEYWORDS} 个`);
	if (keywords.some(keyword => keyword.length > MAX_KEYWORD_LENGTH)) throw invalid(`每个关键词最多 ${MAX_KEYWORD_LENGTH} 个字符`);
	return keywords;
}

function readEnum<T extends string>(args: Record<string, unknown>, key: string, values: readonly T[], fallback: T): T {
	const value = args[key];
	if (value === undefined || value === null) return fallback;
	if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) throw invalid(`${key} 只能为 ${values.join(' 或 ')}`);
	return value as T;
}

function readLimit(value: unknown): number {
	if (value === undefined || value === null) return DEFAULT_LIMIT;
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_LIMIT) throw invalid(`limit 必须是 1 到 ${MAX_LIMIT} 的整数`);
	return value;
}

function readImagesOnly(value: unknown): boolean {
	if (value === undefined || value === null) return false;
	if (typeof value !== 'boolean') throw invalid('images_only 必须是布尔值');
	return value;
}

function readMaxChars(value: unknown): number | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw invalid('max_chars_per_entry 必须是正整数');
	return value;
}

function readConversation(value: unknown): ConversationTarget | undefined {
	return value === undefined || value === null ? undefined : parseTarget(value, 'conversation');
}

function truncate(text: string, chars: number): string {
	return text.length > chars ? `${text.slice(0, chars)}……（已截断，共 ${text.length} 字）` : text;
}
