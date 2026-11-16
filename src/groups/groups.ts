import type { EventHub } from '../common/events.ts';
import { forbidden, invalid, notFound } from '../common/errors.ts';
import { newId, wrongKind } from '../common/ids.ts';
import { assertGroupName } from '../common/names.ts';
import type { Database } from '../database/database.ts';
import type { IDeletionRecord, Members } from '../members/members.ts';
import type { IGroupEvent, Timeline } from '../timeline/timeline.ts';

export interface IGroupMember {
	readonly memberId: string;
	readonly joinedAt: number;
	/** 关注后，群里任何人发言都会唤醒它，不需要点名。 */
	readonly watching: boolean;
}

export interface IGroup {
	readonly groupId: string;
	readonly name: string;
	readonly ownerMemberId: string;
	readonly createdAt: number;
	readonly dissolved: boolean;
	/** 当前成员；已移出的不在这里。 */
	readonly members: readonly IGroupMember[];
}

interface IGroupRow {
	readonly group_id: string;
	readonly name: string;
	readonly owner_member_id: string;
	readonly created_at: number;
	readonly dissolved_at: number | null;
}

/** 群聊。只有创建者能加人、移出别人、解散；其他成员只能退出。 */
export class Groups {
	private readonly db: Database;
	private readonly events: EventHub;
	private readonly members: Members;
	private readonly timeline: Timeline;

	constructor(db: Database, events: EventHub, members: Members, timeline: Timeline) {
		this.db = db;
		this.events = events;
		this.members = members;
		this.timeline = timeline;
	}

	create(ownerMemberId: string, name: string, memberIds: readonly string[]): IGroup {
		assertGroupName(name);
		return this.db.transaction(() => {
			this.members.require(ownerMemberId);
			const groupId = newId('G', id => this.db.get('SELECT 1 FROM groups WHERE group_id = ?', id) !== undefined);
			const now = Date.now();
			this.db.run('INSERT INTO groups (group_id, name, owner_member_id, created_at) VALUES (?, ?, ?, ?)', groupId, name, ownerMemberId, now);
			for (const memberId of new Set([ownerMemberId, ...memberIds])) {
				this.members.require(memberId);
				this.db.run('INSERT INTO group_members (group_id, member_id, joined_at) VALUES (?, ?, ?)', groupId, memberId, now);
				if (memberId !== ownerMemberId) this.notify(memberId, 'added', groupId, name, ownerMemberId);
			}
			this.events.emit({ type: 'group.changed', groupId });
			return this.require(groupId);
		});
	}

	/** 群名，没有这个群时是 undefined。只要名字时用它，不用读群成员。 */
	name(groupId: string): string | undefined {
		return this.db.get<{ name: string }>('SELECT name FROM groups WHERE group_id = ?', groupId)?.name;
	}

	get(groupId: string): IGroup | undefined {
		const row = this.db.get<IGroupRow>('SELECT * FROM groups WHERE group_id = ?', groupId);
		if (!row) return undefined;
		const members = this.db.all<{ member_id: string; joined_at: number; watching: number }>(
			'SELECT member_id, joined_at, watching FROM group_members WHERE group_id = ? AND removed_at IS NULL ORDER BY joined_at, member_id',
			groupId,
		).map(membership => ({ memberId: membership.member_id, joinedAt: membership.joined_at, watching: membership.watching === 1 }));
		return {
			groupId: row.group_id,
			name: row.name,
			ownerMemberId: row.owner_member_id,
			createdAt: row.created_at,
			dissolved: row.dissolved_at !== null,
			members,
		};
	}

	/** 取一个没解散的群聊，不存在时报错。 */
	require(groupId: string): IGroup {
		const group = this.get(groupId);
		if (!group || group.dissolved) throw notFound(wrongKind(groupId, 'G') ?? `群聊不存在：${groupId}`);
		return group;
	}

	/** 要求 memberId 是这个没解散的群聊的当前成员。 */
	requireMember(groupId: string, memberId: string): IGroup {
		const group = this.require(groupId);
		if (!group.members.some(membership => membership.memberId === memberId)) throw notFound(`群聊不存在：${groupId}`);
		return group;
	}

	/** 没解散的群聊。 */
	listActive(): IGroup[] {
		return this.db.all<{ group_id: string }>('SELECT group_id FROM groups WHERE dissolved_at IS NULL ORDER BY created_at, group_id')
			.map(row => this.get(row.group_id)!);
	}

	/** 成员被删除：它建的群聊解散，它所在的其他群聊里它退出。返回解散和退出了哪些群聊、当时谁关注着，恢复时用。 */
	removeMember(memberId: string): IDeletionRecord {
		return this.db.transaction(() => {
			const dissolved: IDeletionRecord['dissolved'][number][] = [];
			const left: IDeletionRecord['left'][number][] = [];
			for (const group of this.listForMember(memberId)) {
				const membership = group.members.find(item => item.memberId === memberId);
				if (group.dissolved || !membership) continue;
				if (group.ownerMemberId === memberId) {
					dissolved.push({ groupId: group.groupId, watching: group.members.filter(item => item.watching).map(item => item.memberId) });
					this.dissolve(memberId, group.groupId);
				} else {
					left.push({ groupId: group.groupId, watching: membership.watching });
					this.updateMembers(memberId, group.groupId, [], [memberId]);
				}
			}
			return { dissolved, left };
		});
	}

	/**
	 * 成员恢复：删除时解散的群聊恢复，通知群里其他成员；删除时退出的群聊，还在的重新加回去，不通知。关注照删除前的。
	 * 恢复的群聊里有这期间被删除的成员时，让它退出，记进它的删除记录，它恢复时再加回来。
	 */
	restoreMember(memberId: string, record: IDeletionRecord): void {
		this.db.transaction(() => {
			for (const { groupId, watching } of record.dissolved) {
				const group = this.get(groupId);
				if (!group?.dissolved) continue;
				this.db.run('UPDATE groups SET dissolved_at = NULL WHERE group_id = ?', groupId);
				for (const membership of group.members) {
					const member = this.members.get(membership.memberId);
					if (member?.deleted) {
						this.db.run('UPDATE group_members SET removed_at = ? WHERE group_id = ? AND member_id = ?', Date.now(), groupId, membership.memberId);
						if (!member.purged) this.members.recordLeftGroup(membership.memberId, groupId);
						continue;
					}
					if (watching.includes(membership.memberId)) this.db.run('UPDATE group_members SET watching = 1 WHERE group_id = ? AND member_id = ?', groupId, membership.memberId);
					if (membership.memberId !== memberId) this.notify(membership.memberId, 'restored', groupId, group.name, memberId);
				}
				this.events.emit({ type: 'group.changed', groupId });
			}
			for (const { groupId, watching } of record.left) {
				const group = this.get(groupId);
				if (!group || group.dissolved) continue;
				this.db.run(
					'UPDATE group_members SET removed_at = NULL, watching = ? WHERE group_id = ? AND member_id = ? AND removed_at IS NOT NULL',
					watching ? 1 : 0, groupId, memberId,
				);
				this.events.emit({ type: 'group.changed', groupId });
			}
		});
	}

	/** 这个人参与过的所有群聊（包括已退出、已解散的），用于对话列表。 */
	listForMember(memberId: string): IGroup[] {
		return this.db.all<{ group_id: string }>('SELECT group_id FROM group_members WHERE member_id = ? ORDER BY joined_at, rowid', memberId)
			.map(row => this.get(row.group_id)!)
			.filter(group => group !== undefined);
	}

	/**
	 * AI 成员拉人进群前检查：要拉的 AI 成员里有不允许它拉的就报错，写明是谁，一个都不加。
	 * 已经在这个群里的不算。用户在网页端建群、加人不经过这里。
	 */
	checkInvites(requesterMemberId: string, memberIds: readonly string[], groupId?: string): void {
		const requester = this.members.require(requesterMemberId);
		const current = new Set(groupId ? this.require(groupId).members.map(membership => membership.memberId) : []);
		const refused = [...new Set(memberIds)].filter(memberId => !current.has(memberId) && memberId !== requesterMemberId)
			.map(memberId => this.members.get(memberId))
			.filter(member => member !== undefined && !this.members.canInviteToGroup(requester, member))
			.map(member => `${member!.name}(${member!.memberId})`);
		if (refused.length > 0) throw forbidden(`以下成员不允许你邀请加入群聊：${refused.join('、')}；请移除这些成员后重试`);
	}

	updateMembers(requesterMemberId: string, groupId: string, addMemberIds: readonly string[], removeMemberIds: readonly string[]): IGroup {
		return this.db.transaction(() => {
			const group = this.requireMember(groupId, requesterMemberId);
			const isOwner = group.ownerMemberId === requesterMemberId;
			if (!isOwner && (addMemberIds.length > 0 || removeMemberIds.some(memberId => memberId !== requesterMemberId))) {
				throw forbidden('非创建者只能将自己移出群聊');
			}
			if (removeMemberIds.includes(group.ownerMemberId)) {
				throw forbidden('创建者不能移出自己；如需结束群聊，请解散群聊');
			}
			const now = Date.now();
			const current = new Set(group.members.map(membership => membership.memberId));
			for (const memberId of new Set(addMemberIds)) {
				if (current.has(memberId)) continue;
				this.members.require(memberId);
				this.db.run(`
					INSERT INTO group_members (group_id, member_id, joined_at) VALUES (?, ?, ?)
					ON CONFLICT (group_id, member_id) DO UPDATE SET joined_at = excluded.joined_at, removed_at = NULL, watching = 0
				`, groupId, memberId, now);
				this.notify(memberId, 'added', groupId, group.name, requesterMemberId);
			}
			for (const memberId of new Set(removeMemberIds)) {
				if (!current.has(memberId)) continue;
				this.db.run('UPDATE group_members SET removed_at = ?, watching = 0 WHERE group_id = ? AND member_id = ?', now, groupId, memberId);
				if (memberId !== requesterMemberId) this.notify(memberId, 'removed', groupId, group.name, requesterMemberId);
			}
			this.events.emit({ type: 'group.changed', groupId });
			return this.require(groupId);
		});
	}

	dissolve(requesterMemberId: string, groupId: string): void {
		this.db.transaction(() => {
			const group = this.requireMember(groupId, requesterMemberId);
			if (group.ownerMemberId !== requesterMemberId) throw forbidden('只有创建者可以解散群聊');
			this.db.run('UPDATE groups SET dissolved_at = ? WHERE group_id = ?', Date.now(), groupId);
			this.db.run('UPDATE group_members SET watching = 0 WHERE group_id = ?', groupId);
			for (const membership of group.members) {
				if (membership.memberId !== requesterMemberId) this.notify(membership.memberId, 'dissolved', groupId, group.name, requesterMemberId);
			}
			this.events.emit({ type: 'group.changed', groupId });
		});
	}

	/**
	 * 设置 AI 成员是否关注这个群聊。关注只决定这个成员什么时候被唤醒，是成员自己的设置，不是群里的操作，群里的其他人不知道：
	 * 使用者可以直接设置任何 AI 成员的（by 是 user）；AI 成员自己用工具时只能设置自己的（by 是 self，由工具保证）。
	 *
	 * 使用者改的要记进这个成员的时间线。上下文末尾的通讯录只写现在关注没有，成员不知道被人改过：
	 * 它自己关注过、工具结果写着「已关注」，后来通讯录却是「未关注」，前后对不上，可能以为没关注上，又去关注一次。
	 * 自己用工具改的，工具结果里已经写了，不再记。
	 */
	setWatching(groupId: string, memberId: string, watching: boolean, by: 'user' | 'self'): IGroup {
		return this.db.transaction(() => {
			const group = this.requireMember(groupId, memberId);
			if (this.members.require(memberId).type !== 'ai') throw invalid('只有 AI 成员可以关注群聊');
			const { changes } = this.db.run(
				'UPDATE group_members SET watching = ? WHERE group_id = ? AND member_id = ? AND watching <> ?',
				watching ? 1 : 0, groupId, memberId, watching ? 1 : 0,
			);
			if (changes > 0) {
				if (by === 'user') this.timeline.appendGroupEvent(memberId, { type: watching ? 'watched' : 'unwatched', groupId, groupName: group.name, actorMemberId: null });
				this.events.emit({ type: 'group.changed', groupId });
			}
			return this.require(groupId);
		});
	}

	private notify(memberId: string, type: IGroupEvent['type'], groupId: string, groupName: string, actorMemberId: string): void {
		this.timeline.appendGroupEvent(memberId, { type, groupId, groupName, actorMemberId });
	}
}
