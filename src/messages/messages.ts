import type { ConversationRef, EventHub } from '../common/events.ts';
import { forbidden, invalid, notFound } from '../common/errors.ts';
import type { Database } from '../database/database.ts';
import type { IExternalOrigin } from '../external/external.ts';
import type { Groups } from '../groups/groups.ts';
import type { Members } from '../members/members.ts';
import type { Timeline } from '../timeline/timeline.ts';
import { MAX_ATTACHMENTS, type Attachments, type IAttachment } from './attachments.ts';

/** 从某个成员的角度指定一个对话：和谁的私聊，或哪个群聊。 */
export type ConversationTarget =
	| { readonly kind: 'direct'; readonly memberId: string }
	| { readonly kind: 'group'; readonly groupId: string };

export interface IMessage {
	readonly messageId: number;
	readonly conversation: ConversationRef;
	readonly senderMemberId: string;
	readonly text: string;
	readonly mentionAll: boolean;
	readonly mentionedMemberIds: readonly string[];
	readonly attachments: readonly IAttachment[];
	/** 真人成员代发的外部事件：来源和 meta。 */
	readonly external: IExternalOrigin | null;
	readonly sentAt: number;
}

export interface IConversationSummary {
	readonly target: ConversationTarget;
	readonly name: string;
	/** 已解散的群聊、已退出的群聊、已删除的成员：只能查看。 */
	readonly readonly: boolean;
	readonly lastMessage: IMessage | undefined;
	readonly unreadCount: number;
	readonly mentionCount: number;
}

/** 某个成员在一个对话或全部对话里的未读：条数、其中点名它的条数、最近一条未读的消息 ID（没有未读时是 null）。 */
export interface IUnread {
	readonly unreadCount: number;
	readonly mentionCount: number;
	readonly lastUnreadMessageId: number | null;
}

/** 对话列表里的一个对话：名字、能不能发、排序用的建立时间（群聊的建立时间，私聊是 0）。 */
interface IConversationInfo {
	readonly target: ConversationTarget;
	readonly name: string;
	readonly readonly: boolean;
	readonly createdAt: number;
}

interface IMessageRow {
	readonly message_id: number;
	readonly sender_member_id: string;
	readonly direct_member_id: string | null;
	readonly group_id: string | null;
	readonly text: string;
	readonly mention_all: number;
	readonly external_json: string | null;
	readonly sent_at: number;
}

/** 查历史时限定的范围：对话、发送者、发送时间（含两端）。 */
export interface ISearchFilter {
	readonly target?: ConversationTarget | undefined;
	readonly senderMemberId?: string | undefined;
	readonly startTime?: number | undefined;
	readonly endTime?: number | undefined;
	/** 只查带图片附件的消息。 */
	readonly imagesOnly?: boolean | undefined;
}

/** 查历史时匹配用的一条消息：只有匹配和排先后要的。 */
export interface ISearchableMessage {
	readonly messageId: number;
	readonly sentAt: number;
	readonly text: string;
	readonly external: IExternalOrigin | null;
	readonly attachments: readonly IAttachment[];
}

/** 翻页：before 往前，after 往后，around 取这条消息和它前后各一段。最多给一个。 */
interface IMessagePage {
	readonly beforeMessageId?: number | undefined;
	readonly afterMessageId?: number | undefined;
	readonly aroundMessageId?: number | undefined;
	readonly limit?: number | undefined;
}

export const MAX_TEXT_LENGTH = 30_000;
const MAX_SEARCH_KEYWORDS = 16;
/** 消息对某个成员可见：自己发的，或者自己是接收者。参数是两次成员 ID。 */
const VISIBLE = '(message.sender_member_id = ? OR EXISTS (SELECT 1 FROM message_recipients recipient WHERE recipient.message_id = message.message_id AND recipient.member_id = ?))';
const IN_CONTEXT_RECEIVED = "NOT EXISTS (SELECT 1 FROM timeline_items item WHERE item.message_id = message.message_id AND item.member_id = ? AND item.context_state = 'visible')";
const IN_CONTEXT_SENT = "NOT EXISTS (SELECT 1 FROM timeline_items item WHERE item.item_id = message.sender_item_id AND item.member_id = ? AND item.context_state = 'visible')";
const HAS_IMAGE = "EXISTS (SELECT 1 FROM message_attachments link JOIN attachments attachment ON attachment.attachment_id = link.attachment_id WHERE link.message_id = message.message_id AND attachment.kind = 'image')";

/** 对话消息：发到私聊或群聊的一条消息只存一份，每个接收者一行记录。 */
export class Messages {
	private readonly db: Database;
	private readonly events: EventHub;
	private readonly members: Members;
	private readonly groups: Groups;
	private readonly timeline: Timeline;
	private readonly attachments: Attachments;

	constructor(db: Database, events: EventHub, members: Members, groups: Groups, timeline: Timeline, attachments: Attachments) {
		this.db = db;
		this.events = events;
		this.members = members;
		this.groups = groups;
		this.timeline = timeline;
		this.attachments = attachments;
	}

	/**
	 * 发一条消息。真人从网页端发，AI 成员通过 send_message 工具发，走的都是这里。
	 * 群聊里 mentions 是被点名的成员 ID，或者 'all' 表示所有人；私聊不能点名。
	 * attachmentIds 是先保存好的附件；有附件时可以不写文字。external 是真人成员代发外部事件时事件的来源和 meta。
	 * senderItemId 是 AI 成员发出它的那次调用在其时间线里的条目，查历史据此判断它还在不在上下文里。
	 */
	send(
		senderMemberId: string, target: ConversationTarget, text: string, mentions: readonly string[] | 'all' = [], attachmentIds: readonly string[] = [],
		external: IExternalOrigin | null = null, senderItemId: number | null = null,
	): IMessage {
		if (typeof text !== 'string') throw invalid('消息内容必须为文本');
		if (!text.trim() && attachmentIds.length === 0) throw invalid('消息内容不能为空');
		if (text.length > MAX_TEXT_LENGTH) throw invalid(`消息过长，最多 ${MAX_TEXT_LENGTH} 个字符`);
		if (attachmentIds.length > MAX_ATTACHMENTS) throw invalid(`一条消息最多 ${MAX_ATTACHMENTS} 个附件`);
		return this.db.transaction(() => {
			for (const attachmentId of attachmentIds) this.attachments.require(attachmentId);
			const sender = this.members.require(senderMemberId);
			const now = Date.now();
			if (target.kind === 'direct') {
				if (mentions === 'all' || mentions.length > 0) throw invalid('私聊不能点名');
				if (target.memberId === senderMemberId) throw invalid('无法与自己私聊');
				const peer = this.members.require(target.memberId);
				if (!this.members.canDirectMessage(sender, peer)) throw forbidden(`你与 ${peer.name} 之间无法私聊`);
				const key = directKey(senderMemberId, peer.memberId);
				const messageId = this.insert(key, senderMemberId, peer.memberId, null, text, false, external, senderItemId, now, attachmentIds);
				this.db.run('INSERT INTO message_recipients (message_id, member_id, conversation_key) VALUES (?, ?, ?)', messageId, peer.memberId, key);
				this.timeline.appendMessage(peer.memberId, messageId, true);
				const conversation = toRef(senderMemberId, target);
				this.events.emit({ type: 'message.created', messageId, conversation, memberIds: [senderMemberId, peer.memberId] });
				return this.require(messageId);
			}
			const group = this.groups.requireMember(target.groupId, senderMemberId);
			const recipients = group.members.filter(membership => membership.memberId !== senderMemberId);
			const mentionAll = mentions === 'all';
			const mentioned = new Set(mentionAll ? recipients.map(membership => membership.memberId) : mentions);
			for (const memberId of mentioned) {
				if (!recipients.some(membership => membership.memberId === memberId)) throw invalid(`点名的 ${memberId} 不是该群聊中的其他成员`);
			}
			const key = groupKey(group.groupId);
			const messageId = this.insert(key, senderMemberId, null, group.groupId, text, mentionAll, external, senderItemId, now, attachmentIds);
			for (const membership of recipients) {
				const isMentioned = mentioned.has(membership.memberId);
				this.db.run(
					'INSERT INTO message_recipients (message_id, member_id, conversation_key, mentioned) VALUES (?, ?, ?, ?)',
					messageId, membership.memberId, key, isMentioned ? 1 : 0,
				);
				this.timeline.appendMessage(membership.memberId, messageId, isMentioned || membership.watching);
			}
			this.events.emit({
				type: 'message.created', messageId, conversation: { kind: 'group', groupId: group.groupId },
				memberIds: group.members.map(membership => membership.memberId),
			});
			return this.require(messageId);
		});
	}

	get(messageId: number): IMessage | undefined {
		return this.getMany([messageId]).get(messageId);
	}

	/** 一批消息，按 ID 放在 Map 里，没有的不在里面。拼上下文时一次取完，不一条一条查。 */
	getMany(messageIds: readonly number[]): Map<number, IMessage> {
		const rows = this.db.all<IMessageRow>('SELECT * FROM messages WHERE message_id IN (SELECT value FROM json_each(?))', JSON.stringify(messageIds));
		return new Map(this.toMessages(rows).map(message => [message.messageId, message]));
	}

	/**
	 * 某个成员在某个对话里能看到的消息：自己发的和发给自己的，按先后排列。
	 * 默认取最新的一页；before 往前翻页，after 往后翻页，around 取这条消息和它前后各一段（跳到消息用）。
	 */
	list(viewerMemberId: string, target: ConversationTarget, options: IMessagePage = {}): IMessage[] {
		const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
		const key = conversationKey(viewerMemberId, target);
		const page = (condition: string, id: number, order: 'ASC' | 'DESC', count: number) => this.db.all<IMessageRow>(`
			SELECT message.* FROM messages message
			WHERE message.conversation_key = ? AND message.message_id ${condition} ? AND ${VISIBLE}
			ORDER BY message.message_id ${order} LIMIT ?
		`, key, id, viewerMemberId, viewerMemberId, count);
		let rows: IMessageRow[];
		if (options.aroundMessageId !== undefined) {
			const around = options.aroundMessageId;
			if (!this.db.get('SELECT 1 FROM messages WHERE message_id = ? AND conversation_key = ?', around, key)) throw notFound(`该对话中不存在消息 ${around}`);
			const before = Math.floor(limit / 2);
			rows = [...page('<', around, 'DESC', before).reverse(), ...page('>=', around, 'ASC', limit - before)];
		} else if (options.afterMessageId !== undefined) {
			rows = page('>', options.afterMessageId, 'ASC', limit);
		} else {
			rows = page('<', options.beforeMessageId ?? Number.MAX_SAFE_INTEGER, 'DESC', limit).reverse();
		}
		return this.toMessages(rows);
	}

	/** 在某个成员能看到的消息里按关键词搜：空格分开的词都要包含，不分大小写，新的在前；before 往前翻页。 */
	search(viewerMemberId: string, query: string, options: { readonly beforeMessageId?: number; readonly limit?: number } = {}): IMessage[] {
		const keywords = query.split(/\s+/).filter(Boolean);
		if (keywords.length === 0) throw invalid('请输入要搜索的内容');
		if (keywords.length > MAX_SEARCH_KEYWORDS) throw invalid(`最多 ${MAX_SEARCH_KEYWORDS} 个关键词`);
		const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
		return this.toMessages(this.db.all<IMessageRow>(`
			SELECT message.* FROM messages message
			WHERE message.message_id < ? AND ${VISIBLE} AND ${keywords.map(() => 'instr(lower(message.text), lower(?)) > 0').join(' AND ')}
			ORDER BY message.message_id DESC LIMIT ?
		`, options.beforeMessageId ?? Number.MAX_SAFE_INTEGER, viewerMemberId, viewerMemberId, ...keywords, limit));
	}

	/**
	 * 某个成员能看到的消息里 ID 在 afterMessageId 之后、不超过 throughMessageId 的，按先后；可以限定对话、发送者和发送时间。
	 * 只取匹配要的几列：查历史按 ID 一段一段扫全部消息，每段扫的行数有上限，找到的那几条再用 getMany 取完整的。
	 */
	searchable(viewerMemberId: string, filter: ISearchFilter, afterMessageId: number, throughMessageId: number): ISearchableMessage[] {
		// 还在查找者上下文里的不查：收到的看它时间线里对应的那条，自己发的看发出它的那次调用。
		const conditions = ['message.message_id > ?', 'message.message_id <= ?', VISIBLE, IN_CONTEXT_RECEIVED, IN_CONTEXT_SENT];
		const params: (string | number)[] = [afterMessageId, throughMessageId, viewerMemberId, viewerMemberId, viewerMemberId, viewerMemberId];
		if (filter.imagesOnly) conditions.push(HAS_IMAGE);
		if (filter.target) {
			conditions.push('message.conversation_key = ?');
			params.push(conversationKey(viewerMemberId, filter.target));
		}
		if (filter.senderMemberId !== undefined) {
			conditions.push('message.sender_member_id = ?');
			params.push(filter.senderMemberId);
		}
		if (filter.startTime !== undefined) {
			conditions.push('message.sent_at >= ?');
			params.push(filter.startTime);
		}
		if (filter.endTime !== undefined) {
			conditions.push('message.sent_at <= ?');
			params.push(filter.endTime);
		}
		const rows = this.db.all<Pick<IMessageRow, 'message_id' | 'sent_at' | 'text' | 'external_json'>>(
			`SELECT message.message_id, message.sent_at, message.text, message.external_json FROM messages message WHERE ${conditions.join(' AND ')} ORDER BY message.message_id`,
			...params,
		);
		const attachments = rows.length > 0 ? this.attachments.inRange(afterMessageId, throughMessageId) : new Map<number, IAttachment[]>();
		return rows.map(row => ({
			messageId: row.message_id, sentAt: row.sent_at, text: row.text,
			external: row.external_json === null ? null : JSON.parse(row.external_json) as IExternalOrigin,
			attachments: attachments.get(row.message_id) ?? [],
		}));
	}

	/** 成员时间线里这些调用发出的消息（压缩时校验摘要的关键词用），按先后。 */
	sentBy(memberId: string, itemIds: readonly number[]): IMessage[] {
		if (itemIds.length === 0) return [];
		return this.toMessages(this.db.all<IMessageRow>(
			'SELECT * FROM messages WHERE sender_item_id IN (SELECT value FROM json_each(?)) AND sender_member_id = ? ORDER BY message_id', JSON.stringify(itemIds), memberId,
		));
	}

	/** 最新一条消息的 ID，没有消息时是 0。 */
	latestMessageId(): number {
		return this.db.get<{ id: number | null }>('SELECT MAX(message_id) AS id FROM messages')?.id ?? 0;
	}

	/** 某个成员的对话列表：私聊过的人和参与过的群聊，最近有消息的排前面。 */
	conversations(viewerMemberId: string): IConversationSummary[] {
		this.members.require(viewerMemberId);
		const reads = this.readThrough(viewerMemberId);
		const rows = this.targets(viewerMemberId).map(info => {
			const key = conversationKey(viewerMemberId, info.target);
			const lastId = this.db.get<{ id: number }>(`
				SELECT message.message_id AS id FROM messages message
				WHERE message.conversation_key = ? AND ${VISIBLE}
				ORDER BY message.message_id DESC LIMIT 1
			`, key, viewerMemberId, viewerMemberId)?.id;
			return { info, lastId, unread: this.unread(viewerMemberId, key, reads.get(key) ?? 0) };
		});
		// 每个对话的最后一条一次取完，点名和附件不再每个对话各查一次。
		const lastMessages = this.getMany(rows.flatMap(row => row.lastId === undefined ? [] : [row.lastId]));
		const summaries = rows.map(({ info: { target, name, readonly, createdAt }, lastId, unread }) => {
			const lastMessage = lastId === undefined ? undefined : lastMessages.get(lastId);
			return { target, name, readonly, lastMessage, unreadCount: unread.unreadCount, mentionCount: unread.mentionCount, sortTime: lastMessage?.sentAt ?? createdAt };
		});
		return summaries.sort((left, right) => right.sortTime - left.sortTime).map(({ sortTime: _, ...summary }) => summary);
	}

	/** 某个成员全部对话的未读加起来。 */
	totalUnread(viewerMemberId: string): IUnread {
		let unreadCount = 0;
		let mentionCount = 0;
		let last = 0;
		const reads = this.readThrough(viewerMemberId);
		for (const { target } of this.targets(viewerMemberId)) {
			const key = conversationKey(viewerMemberId, target);
			const unread = this.unread(viewerMemberId, key, reads.get(key) ?? 0);
			unreadCount += unread.unreadCount;
			mentionCount += unread.mentionCount;
			last = Math.max(last, unread.lastUnreadMessageId ?? 0);
		}
		return { unreadCount, mentionCount, lastUnreadMessageId: last || null };
	}

	/** 某个成员的全部对话：私聊过的人（两边各走一个只收私聊的索引）和参与过的群聊。 */
	private targets(viewerMemberId: string): IConversationInfo[] {
		const targets: IConversationInfo[] = [];
		const peers = this.db.all<{ peer: string }>(`
			SELECT direct_member_id AS peer FROM messages WHERE sender_member_id = ? AND direct_member_id IS NOT NULL
			UNION SELECT sender_member_id FROM messages WHERE direct_member_id = ?
		`, viewerMemberId, viewerMemberId);
		for (const { peer } of peers) {
			const member = this.members.get(peer)!;
			targets.push({ target: { kind: 'direct', memberId: peer }, name: member.name, readonly: member.deleted, createdAt: 0 });
		}
		for (const group of this.groups.listForMember(viewerMemberId)) {
			const isMember = group.members.some(membership => membership.memberId === viewerMemberId);
			targets.push({ target: { kind: 'group', groupId: group.groupId }, name: group.name, readonly: group.dissolved || !isMember, createdAt: group.createdAt });
		}
		return targets;
	}

	/** 某个成员每个对话读到了哪条消息，按对话键；没读过的对话不在里面。 */
	private readThrough(viewerMemberId: string): Map<string, number> {
		return new Map(this.db.all<{ key: string; id: number }>(
			'SELECT conversation_key AS key, read_through_message_id AS id FROM conversation_reads WHERE member_id = ?', viewerMemberId,
		).map(row => [row.key, row.id]));
	}

	/** 一个对话里读到的那条（readThrough）之后收到的消息：只扫收件记录里这个对话的那一段。 */
	private unread(viewerMemberId: string, key: string, readThrough: number): IUnread {
		const { count, last } = this.db.get<{ count: number; last: number | null }>(
			'SELECT COUNT(*) AS count, MAX(message_id) AS last FROM message_recipients WHERE member_id = ? AND conversation_key = ? AND message_id > ?',
			viewerMemberId, key, readThrough,
		)!;
		const { mentions } = this.db.get<{ mentions: number }>(
			'SELECT COUNT(*) AS mentions FROM message_recipients WHERE member_id = ? AND conversation_key = ? AND message_id > ? AND mentioned = 1',
			viewerMemberId, key, readThrough,
		)!;
		return { unreadCount: count, mentionCount: mentions, lastUnreadMessageId: last };
	}

	/** 标记读到哪条消息为止，用来计算未读数和 @ 数。只会往后移。 */
	markRead(viewerMemberId: string, target: ConversationTarget, throughMessageId: number): void {
		this.db.transaction(() => {
			this.members.require(viewerMemberId);
			const key = conversationKey(viewerMemberId, target);
			const { changes } = this.db.run(`
				INSERT INTO conversation_reads (member_id, conversation_key, read_through_message_id) VALUES (?, ?, ?)
				ON CONFLICT (member_id, conversation_key) DO UPDATE SET read_through_message_id = excluded.read_through_message_id
				WHERE excluded.read_through_message_id > conversation_reads.read_through_message_id
			`, viewerMemberId, key, throughMessageId);
			if (changes > 0) this.events.emit({ type: 'conversation.read', memberId: viewerMemberId, conversation: toRef(viewerMemberId, target) });
		});
	}

	private insert(
		key: string, senderMemberId: string, directMemberId: string | null, groupId: string | null, text: string, mentionAll: boolean,
		external: IExternalOrigin | null, senderItemId: number | null, sentAt: number, attachmentIds: readonly string[],
	): number {
		const messageId = this.db.run(
			'INSERT INTO messages (conversation_key, sender_member_id, direct_member_id, group_id, text, mention_all, external_json, sender_item_id, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
			key, senderMemberId, directMemberId, groupId, text, mentionAll ? 1 : 0, external && JSON.stringify(external), senderItemId, sentAt,
		).lastId;
		attachmentIds.forEach((attachmentId, position) => {
			this.db.run('INSERT INTO message_attachments (message_id, position, attachment_id) VALUES (?, ?, ?)', messageId, position, attachmentId);
		});
		return messageId;
	}

	private require(messageId: number): IMessage {
		return this.get(messageId)!;
	}

	/** 数据库里的消息转成 IMessage，顺序不变。点名和附件按这一批一起查，不一条一条查。 */
	private toMessages(rows: readonly IMessageRow[]): IMessage[] {
		if (rows.length === 0) return [];
		const ids = JSON.stringify(rows.map(row => row.message_id));
		const mentioned = new Map<number, string[]>();
		for (const recipient of this.db.all<{ message_id: number; member_id: string }>(
			'SELECT message_id, member_id FROM message_recipients WHERE message_id IN (SELECT value FROM json_each(?)) AND mentioned = 1 ORDER BY message_id, member_id', ids,
		)) {
			mentioned.set(recipient.message_id, [...mentioned.get(recipient.message_id) ?? [], recipient.member_id]);
		}
		const attachments = this.attachments.forMessages(rows.map(row => row.message_id));
		return rows.map(row => ({
			messageId: row.message_id,
			conversation: row.group_id !== null
				? { kind: 'group', groupId: row.group_id }
				: { kind: 'direct', memberIds: sortedPair(row.sender_member_id, row.direct_member_id!) } satisfies ConversationRef,
			senderMemberId: row.sender_member_id,
			text: row.text,
			mentionAll: row.mention_all === 1,
			mentionedMemberIds: mentioned.get(row.message_id) ?? [],
			attachments: attachments.get(row.message_id) ?? [],
			external: row.external_json === null ? null : JSON.parse(row.external_json) as IExternalOrigin,
			sentAt: row.sent_at,
		}));
	}
}

function conversationKey(viewerMemberId: string, target: ConversationTarget): string {
	return target.kind === 'direct' ? directKey(viewerMemberId, target.memberId) : groupKey(target.groupId);
}

function directKey(first: string, second: string): string {
	return `D:${sortedPair(first, second).join(':')}`;
}

function groupKey(groupId: string): string {
	return `G:${groupId}`;
}

function sortedPair(first: string, second: string): [string, string] {
	return first < second ? [first, second] : [second, first];
}

function toRef(viewerMemberId: string, target: ConversationTarget): ConversationRef {
	return target.kind === 'direct'
		? { kind: 'direct', memberIds: sortedPair(viewerMemberId, target.memberId) }
		: { kind: 'group', groupId: target.groupId };
}
