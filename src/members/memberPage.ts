import { invalid, notFound } from '../common/errors.ts';
import type { EventHub } from '../common/events.ts';
import { newId } from '../common/ids.ts';
import type { Database } from '../database/database.ts';
import type { ConversationTarget, Messages } from '../messages/messages.ts';
import { messageText } from '../timeline/timeline.ts';
import type { Members } from './members.ts';

/** 分组名最多几个字。 */
const SECTION_NAME_MAX_LENGTH = 20;
/** 成员页预览里结果的正文最多几个字。 */
const RESULT_TEXT_LENGTH = 100;
/** 找最近一次直接输出时一次看几条：有的输出项只有空文字（同时调了工具），要跳过。 */
const OUTPUT_SCAN = 50;

export interface IMemberSection {
	readonly sectionId: string;
	readonly name: string;
	/** 分组里的成员，包括已删除的：网页端不显示，恢复后还在。 */
	readonly memberIds: readonly string[];
}

/** AI 成员最近的结果：发出的消息或直接输出。text 把空白合成一个空格，截到 100 字。 */
export type MemberResult =
	| { readonly kind: 'message'; readonly at: number; readonly target: ConversationTarget; readonly text: string }
	| { readonly kind: 'output'; readonly at: number; readonly text: string };

/** 成员页每一行要显示的内容。 */
export type MemberOverview =
	| {
		readonly memberId: string;
		readonly type: 'ai';
		/** 时间线最后一条的时间。 */
		readonly lastActivityAt: number | null;
		readonly lastResult: MemberResult | null;
		/** 使用者看到的那一条之后有没有新的结果。 */
		readonly hasNewResult: boolean;
	}
	| {
		readonly memberId: string;
		readonly type: 'human';
		/** 它所有对话的未读数、其中点名它的数、最近一条未读消息的时间。 */
		readonly unreadCount: number;
		readonly mentionCount: number;
		readonly lastUnreadAt: number | null;
	};

/**
 * 网页端成员页用的数据：使用者自己整理列表的分组、看到每个 AI 成员时间线的哪一条，以及每一行的概况。
 * 只给网页端用，不进任何成员的上下文，不出现在工具里：分组是使用者整理列表的方式，和成员无关。
 */
export class MemberPage {
	private readonly db: Database;
	private readonly events: EventHub;
	private readonly members: Members;
	private readonly messages: Messages;

	constructor(db: Database, events: EventHub, members: Members, messages: Messages) {
		this.db = db;
		this.events = events;
		this.members = members;
		this.messages = messages;
	}

	sections(): IMemberSection[] {
		const rows = this.db.all<{ section_id: string; name: string }>('SELECT section_id, name FROM member_sections ORDER BY position');
		const members = this.db.all<{ section_id: string; member_id: string }>('SELECT section_id, member_id FROM member_section_members ORDER BY rowid');
		return rows.map(row => ({
			sectionId: row.section_id,
			name: row.name,
			memberIds: members.filter(item => item.section_id === row.section_id).map(item => item.member_id),
		}));
	}

	/** 新建分组，排在最后。 */
	createSection(name: string): IMemberSection {
		return this.db.transaction(() => {
			const checked = this.checkName(name, undefined);
			const sectionId = newId('L', id => this.db.get('SELECT 1 FROM member_sections WHERE section_id = ?', id) !== undefined);
			const position = this.db.get<{ next: number }>('SELECT COALESCE(MAX(position), 0) + 1 AS next FROM member_sections')!.next;
			this.db.run('INSERT INTO member_sections (section_id, name, position) VALUES (?, ?, ?)', sectionId, checked, position);
			this.events.emit({ type: 'memberSections.changed' });
			return this.requireSection(sectionId);
		});
	}

	/** 改名，或者整个替换里面的成员。成员要存在、没有彻底删除；重复的只算一次。 */
	updateSection(sectionId: string, change: { readonly name?: string; readonly memberIds?: readonly string[] }): IMemberSection {
		return this.db.transaction(() => {
			this.requireSection(sectionId);
			if (change.name !== undefined) {
				this.db.run('UPDATE member_sections SET name = ? WHERE section_id = ?', this.checkName(change.name, sectionId), sectionId);
			}
			if (change.memberIds !== undefined) {
				const memberIds = [...new Set(change.memberIds)];
				for (const memberId of memberIds) this.members.requireIncludingDeleted(memberId);
				this.db.run('DELETE FROM member_section_members WHERE section_id = ?', sectionId);
				for (const memberId of memberIds) this.db.run('INSERT INTO member_section_members (section_id, member_id) VALUES (?, ?)', sectionId, memberId);
			}
			this.events.emit({ type: 'memberSections.changed' });
			return this.requireSection(sectionId);
		});
	}

	/** 删除分组，里面的成员不受影响。 */
	removeSection(sectionId: string): void {
		this.db.transaction(() => {
			this.requireSection(sectionId);
			this.db.run('DELETE FROM member_section_members WHERE section_id = ?', sectionId);
			this.db.run('DELETE FROM member_sections WHERE section_id = ?', sectionId);
			this.events.emit({ type: 'memberSections.changed' });
		});
	}

	/** 调整分组的先后，要正好列出全部分组。 */
	orderSections(sectionIds: readonly string[]): IMemberSection[] {
		return this.db.transaction(() => {
			const existing = this.db.all<{ section_id: string }>('SELECT section_id FROM member_sections').map(row => row.section_id);
			if (sectionIds.length !== existing.length || new Set(sectionIds).size !== sectionIds.length || !sectionIds.every(id => existing.includes(id))) {
				throw invalid('须列出全部分组，且每个分组只出现一次');
			}
			sectionIds.forEach((sectionId, index) => this.db.run('UPDATE member_sections SET position = ? WHERE section_id = ?', index + 1, sectionId));
			this.events.emit({ type: 'memberSections.changed' });
			return this.sections();
		});
	}

	/** 使用者看到了这个 AI 成员时间线的哪一条。只往后记，比已记的小时不变。返回现在记的位置。 */
	markViewed(memberId: string, itemId: number): number {
		return this.db.transaction(() => {
			const member = this.members.requireIncludingDeleted(memberId);
			if (member.type !== 'ai') throw invalid(`${member.name} 不是 AI 成员，没有时间线`);
			if (!this.db.get('SELECT 1 FROM timeline_items WHERE member_id = ? AND item_id = ?', memberId, itemId)) throw notFound(`${member.name} 的时间线中不存在 ${itemId}`);
			const { changes } = this.db.run(`
				INSERT INTO timeline_views (member_id, viewed_through_item_id) VALUES (?, ?)
				ON CONFLICT (member_id) DO UPDATE SET viewed_through_item_id = excluded.viewed_through_item_id
				WHERE excluded.viewed_through_item_id > timeline_views.viewed_through_item_id
			`, memberId, itemId);
			if (changes > 0) this.events.emit({ type: 'timeline.viewed', memberId });
			return this.viewedThrough(memberId);
		});
	}

	/** 每个没有彻底删除的成员一项；给了 memberIds 时只算这几个（网页端收到事件后只补变了的）。 */
	overview(memberIds?: ReadonlySet<string>): MemberOverview[] {
		// 只补几个时按 ID 取这几个，不列全部成员：补取每来一条内容、一条消息就有一次。
		const members = memberIds ? [...memberIds].flatMap(memberId => this.members.get(memberId) ?? []) : this.members.list();
		return members.filter(member => !member.purged).map((member): MemberOverview => {
			if (member.type === 'human') {
				const { unreadCount, mentionCount, lastUnreadMessageId } = this.messages.totalUnread(member.memberId);
				const lastUnreadAt = lastUnreadMessageId === null ? null : this.db.get<{ at: number }>('SELECT sent_at AS at FROM messages WHERE message_id = ?', lastUnreadMessageId)!.at;
				return { memberId: member.memberId, type: 'human', unreadCount, mentionCount, lastUnreadAt };
			}
			const { memberId } = member;
			// 条目按写入的先后编号，最后一条就是最后活动的时间。
			const lastActivityAt = this.db.get<{ at: number }>('SELECT created_at AS at FROM timeline_items WHERE member_id = ? ORDER BY item_id DESC LIMIT 1', memberId)?.at ?? null;
			const sent = this.lastSent(memberId);
			const output = this.lastOutput(memberId);
			const lastResult = sent && output ? (output.result.at > sent.at ? output.result : sent) : sent ?? output?.result ?? null;
			// 直接输出就在时间线里，按条目比；发出的消息不在发送人自己的时间线里，按时间和看到的那一条比。
			const hasNewResult = (output !== null && output.itemId > this.viewedThrough(memberId)) || (sent !== null && sent.at > this.viewedAt(memberId));
			return { memberId, type: 'ai', lastActivityAt, lastResult, hasNewResult };
		});
	}

	private lastSent(memberId: string): MemberResult | null {
		const message = this.db.get<{ sent_at: number; direct_member_id: string | null; group_id: string | null; text: string }>(
			'SELECT sent_at, direct_member_id, group_id, text FROM messages WHERE sender_member_id = ? ORDER BY message_id DESC LIMIT 1', memberId,
		);
		if (!message) return null;
		return {
			kind: 'message',
			at: message.sent_at,
			target: message.group_id !== null ? { kind: 'group', groupId: message.group_id } : { kind: 'direct', memberId: message.direct_member_id! },
			text: brief(message.text),
		};
	}

	/** 最近一次有文字的直接输出。条件和 timeline_items_output_idx 的写法一致才用得上索引。 */
	private lastOutput(memberId: string): { readonly itemId: number; readonly result: MemberResult } | null {
		const rows = this.db.all<{ item_id: number; payload_json: string; created_at: number }>(`
			SELECT item_id, payload_json, created_at FROM timeline_items
			WHERE member_id = ? AND kind = 'model_output' AND json_extract(payload_json, '$.type') = 'message'
			ORDER BY item_id DESC LIMIT ?
		`, memberId, OUTPUT_SCAN);
		for (const row of rows) {
			const text = messageText((JSON.parse(row.payload_json) as Record<string, unknown>)['content']).trim();
			if (text) return { itemId: row.item_id, result: { kind: 'output', at: row.created_at, text: brief(text) } };
		}
		return null;
	}

	private viewedThrough(memberId: string): number {
		return this.db.get<{ id: number }>('SELECT viewed_through_item_id AS id FROM timeline_views WHERE member_id = ?', memberId)?.id ?? 0;
	}

	/** 看到的那一条的时间，没看过时是 0。 */
	private viewedAt(memberId: string): number {
		return this.db.get<{ at: number }>(`
			SELECT item.created_at AS at FROM timeline_views view JOIN timeline_items item ON item.item_id = view.viewed_through_item_id
			WHERE view.member_id = ?
		`, memberId)?.at ?? 0;
	}

	private requireSection(sectionId: string): IMemberSection {
		const section = this.sections().find(item => item.sectionId === sectionId);
		if (!section) throw notFound(`分组不存在：${sectionId}`);
		return section;
	}

	/** 分组名去掉首尾空白后不能为空、最多 20 个字、不能和别的分组重复（不分大小写）。返回去掉空白的名字。 */
	private checkName(name: string, sectionId: string | undefined): string {
		const trimmed = name.trim();
		if (!trimmed) throw invalid('分组名不能为空');
		if ([...trimmed].length > SECTION_NAME_MAX_LENGTH) throw invalid(`分组名最多 ${SECTION_NAME_MAX_LENGTH} 个字`);
		const same = this.db.get<{ section_id: string }>('SELECT section_id FROM member_sections WHERE name = ?', trimmed);
		if (same && same.section_id !== sectionId) throw invalid(`已存在名为「${trimmed}」的分组`);
		return trimmed;
	}
}

/** 空白合成一个空格，截到 100 字。 */
function brief(text: string): string {
	return [...text.replace(/\s+/g, ' ').trim()].slice(0, RESULT_TEXT_LENGTH).join('');
}
