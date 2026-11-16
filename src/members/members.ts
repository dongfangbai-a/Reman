import { statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { EventHub } from '../common/events.ts';
import { invalid, notFound } from '../common/errors.ts';
import { newId, wrongKind } from '../common/ids.ts';
import { assertMemberName, memberDescriptionProblem } from '../common/names.ts';
import type { Database } from '../database/database.ts';
import type { IModelRef } from '../models/config.ts';
import { ruleNames, type IMemberDefinition } from './definition.ts';

/** human 是真人，ai 是 AI 成员。 */
export type MemberType = 'human' | 'ai';

/** 对其他 AI 成员的限制：都不允许、都允许、只允许名单里的、除了名单里的都允许。私聊和群聊共用。 */
export type MemberRuleMode = 'none' | 'all' | 'allow' | 'deny';

/** 对其他 AI 成员的限制，名单换成了现在的 AI 成员的 ID；memberIds 只在 allow、deny 时有。 */
interface IMemberRule {
	readonly mode: MemberRuleMode;
	readonly memberIds: readonly string[];
}

export interface IMember {
	readonly memberId: string;
	readonly name: string;
	readonly type: MemberType;
	/** 备注：一句话，用户用来记成员负责什么、有什么特点。 */
	readonly description: string;
	/** 能和哪些 AI 成员私聊（双方都允许才行）。真人没有限制，是 none。 */
	readonly directMessage: IMemberRule;
	/** 哪些 AI 成员能把它拉进群聊。真人没有限制，是 all。 */
	readonly groupInvite: IMemberRule;
	/** 成员自己的提示词，放在系统提示词里。 */
	readonly prompt: string;
	/** 使用哪个供应商的哪个模型；null 表示用 models.json 里的默认模型。 */
	readonly model: IModelRef | null;
	/** 思考强度；null 表示不指定，由模型服务决定。 */
	readonly reasoningEffort: string | null;
	/** 有哪些可设置的工具；null 表示用新成员的默认设置。 */
	readonly tools: readonly string[] | null;
	/** 能读的技能；成员文件没写技能时是新成员的默认技能。 */
	readonly skills: readonly string[];
	/** 时间感知：收到的内容带不带收到时的时间（运行时设计第 5 部分「时间」）。成员文件没写时开着；真人不运行模型，是 true。 */
	readonly timeAwareness: boolean;
	/** 头像内容的哈希；null 表示没有头像。 */
	readonly avatar: string | null;
	/** 工作目录（绝对路径）；null 表示用运行时分配的默认目录。 */
	readonly workingDirectory: string | null;
	/** 运行时分配的默认工作目录，不管现在用没用；真人是 null。 */
	readonly defaultWorkingDirectory: string | null;
	/** 指定的工作目录现在不能用的原因（不存在、不是文件夹、无法访问）；没问题或用默认目录时是 null。 */
	readonly workingDirectoryProblem: string | null;
	/** 暂停时照常收消息，但不会开始运行。 */
	readonly paused: boolean;
	readonly createdAt: number;
	/** 已删除或彻底删除。 */
	readonly deleted: boolean;
	readonly deletedAt: number | null;
	/** 彻底删除：只留名字，对话里显示发送者用。 */
	readonly purged: boolean;
	/** 已删除、还能恢复的 AI 成员删除时做了什么；其他成员是 null。 */
	readonly deletion: IMemberDeletion | null;
}

interface IMemberDeletion {
	readonly dissolvedGroups: readonly IGroupRef[];
	readonly leftGroups: readonly IGroupRef[];
	/** 删除期间不触发的定时数。 */
	readonly reminders: number;
}

interface IGroupRef {
	readonly groupId: string;
	readonly name: string;
}

/** 删除时解散和退出了哪些群聊、当时谁关注着，恢复时按它还原。 */
export interface IDeletionRecord {
	readonly dissolved: readonly { readonly groupId: string; readonly watching: readonly string[] }[];
	readonly left: readonly { readonly groupId: string; readonly watching: boolean }[];
}

/** 运行时存的一份成员文件，恢复时用它重新生成成员文件夹。头像不存，恢复后没有头像。 */
interface IMemberBackup {
	readonly definitionJson: string;
	readonly prompt: string;
	readonly memory: string;
}

/** AI 成员来自成员文件夹的配置。 */
export interface IAiDefinition {
	readonly description: string;
	readonly prompt: string;
	readonly model: IModelRef | null;
	readonly reasoningEffort: string | null;
	readonly tools: readonly string[] | null;
	/** null 表示用新成员的默认技能。 */
	readonly skills: readonly string[] | null;
	/** 头像文件的版本（大小和修改时间）；没有头像时为 null。 */
	readonly avatar: string | null;
	/** 按运行时的格式重写的 member.json。 */
	readonly definitionJson: string;
}

interface IMemberRow {
	readonly member_id: string;
	readonly name: string;
	readonly type: MemberType;
	readonly description: string;
	readonly prompt: string;
	readonly model_provider: string | null;
	readonly model: string | null;
	readonly reasoning_effort: string | null;
	readonly tools_json: string | null;
	readonly skills_json: string | null;
	readonly avatar_hash: string | null;
	readonly definition_json: string;
	readonly working_directory: string | null;
	readonly paused: number | null;
	readonly created_at: number;
	readonly deleted_at: number | null;
	readonly deletion_json: string | null;
	readonly purged_at: number | null;
}

/** 目录现在能不能用：不存在、不是文件夹、无法访问时说明原因。 */
function directoryProblem(path: string): string | null {
	try {
		return statSync(path).isDirectory() ? null : '不是文件夹';
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'ENOENT' ? '目录不存在' : '无法访问该目录';
	}
}

/** 检查工作目录：空表示用默认目录，否则必须是绝对路径。 */
export function checkWorkingDirectory(workingDirectory: string | null | undefined): string | null {
	const directory = workingDirectory?.trim() || null;
	if (directory !== null && !isAbsolute(directory)) throw invalid('工作目录必须是绝对路径');
	return directory;
}

/** 成员。真人通过接口创建；AI 成员由成员文件夹定义，这里只负责把同步结果写进数据库。 */
export class Members {
	private readonly db: Database;
	private readonly events: EventHub;
	/** AI 成员的默认工作目录都放在这里，每个成员一个以 ID 命名的子目录。 */
	readonly workspacesDirectory: string;
	/** 新成员的默认技能。 */
	private readonly defaultSkills: () => readonly string[];

	constructor(db: Database, events: EventHub, workspacesDirectory: string, defaultSkills: () => readonly string[]) {
		this.db = db;
		this.events = events;
		this.workspacesDirectory = workspacesDirectory;
		this.defaultSkills = defaultSkills;
	}

	createHuman(name: string): IMember {
		assertMemberName(name);
		return this.db.transaction(() => {
			if (this.findByName(name)) throw invalid(`成员名「${name}」已被使用`);
			const memberId = this.newMemberId();
			this.db.run('INSERT INTO members (member_id, name, type, created_at) VALUES (?, ?, ?, ?)', memberId, name, 'human', Date.now());
			this.events.emit({ type: 'member.changed', memberId });
			return this.require(memberId);
		});
	}

	list(): IMember[] {
		return this.db.all<IMemberRow>(`${SELECT_MEMBER} ORDER BY member.created_at, member.member_id`).map(row => this.toMember(row));
	}

	/** 成员名，没有这个成员时是 undefined。只要名字时用它，不用读整个成员。 */
	name(memberId: string): string | undefined {
		return this.db.get<{ name: string }>('SELECT name FROM members WHERE member_id = ?', memberId)?.name;
	}

	get(memberId: string): IMember | undefined {
		const row = this.db.get<IMemberRow>(`${SELECT_MEMBER} WHERE member.member_id = ?`, memberId);
		return row && this.toMember(row);
	}

	/** 新成员的 ID：彻底删除的成员也留着记录，查重时一起算，它在以前的消息里出现过，不能给别人用。 */
	private newMemberId(): string {
		return newId('M', id => this.db.get('SELECT 1 FROM members WHERE member_id = ?', id) !== undefined);
	}

	/** 按名字找成员（不区分大小写），包括已删除的，不包括彻底删除的。 */
	findByName(name: string): IMember | undefined {
		const row = this.db.get<IMemberRow>(`${SELECT_MEMBER} WHERE member.name = ? AND member.purged_at IS NULL`, name);
		return row && this.toMember(row);
	}

	/** 取一个没被删除的成员，不存在时报错。 */
	require(memberId: string): IMember {
		const member = this.get(memberId);
		if (!member || member.deleted) throw notFound(wrongKind(memberId, 'M') ?? `成员不存在：${memberId}`);
		return member;
	}

	/** 取一个成员，包括已删除的（查看它的时间线等记录用）；不存在或彻底删除了时报错。 */
	requireIncludingDeleted(memberId: string): IMember {
		const member = this.get(memberId);
		if (!member || member.purged) throw notFound(wrongKind(memberId, 'M') ?? `成员不存在：${memberId}`);
		return member;
	}

	/** 取一个已删除、还能恢复的 AI 成员。 */
	requireDeletedAi(memberId: string): IMember {
		const member = this.requireIncludingDeleted(memberId);
		if (member.type !== 'ai') throw invalid(`${member.name} 不是 AI 成员`);
		if (!member.deleted) throw invalid(`${member.name} 未被删除`);
		return member;
	}

	/**
	 * 按成员文件夹新建或更新没被删除的 AI 成员，同时存下成员文件的内容。内容没变时不写、不发事件。
	 * 名字由调用方检查。返回成员 ID。
	 */
	saveAi(memberId: string | undefined, name: string, definition: IAiDefinition): string {
		return this.db.transaction(() => {
			const row = memberId === undefined ? undefined : this.db.get<IMemberRow>(`${SELECT_MEMBER} WHERE member.member_id = ?`, memberId);
			const existing = row && this.toMember(row);
			const skillsJson = definition.skills === null ? null : JSON.stringify(definition.skills);
			// 技能比较成员文件里写的，不比较用上默认技能以后的。
			if (existing && row.skills_json === skillsJson && row.definition_json === definition.definitionJson && sameDefinition(existing, definition)) {
				return existing.memberId;
			}
			const id = existing?.memberId ?? this.newMemberId();
			const values = [
				definition.description, definition.prompt, definition.model?.provider ?? null, definition.model?.model ?? null, definition.reasoningEffort,
				definition.tools === null ? null : JSON.stringify(definition.tools), skillsJson, definition.definitionJson, definition.avatar,
			];
			if (existing) {
				this.db.run(`
					UPDATE members SET description = ?, prompt = ?, model_provider = ?, model = ?, reasoning_effort = ?,
						tools_json = ?, skills_json = ?, definition_json = ?, avatar_hash = ?
					WHERE member_id = ?
				`, ...values, id);
			} else {
				this.db.run(`
					INSERT INTO members (description, prompt, model_provider, model, reasoning_effort, tools_json, skills_json,
						definition_json, avatar_hash, member_id, name, type, created_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ai', ?)
				`, ...values, id, name, Date.now());
				this.db.run('INSERT INTO member_states (member_id) VALUES (?)', id);
			}
			this.events.emit({ type: 'member.changed', memberId: id });
			return id;
		});
	}

	/** 存下成员现在的记忆，恢复时用；没变时不写。 */
	saveMemory(memberId: string, memory: string): void {
		this.db.run('UPDATE members SET memory = ? WHERE member_id = ? AND memory <> ?', memory, memberId, memory);
	}

	/** 改已删除的成员存的 member.json，恢复时按它生成。 */
	saveDefinitionBackup(memberId: string, definitionJson: string): void {
		this.db.run('UPDATE members SET definition_json = ? WHERE member_id = ?', definitionJson, memberId);
	}

	/** 存的成员文件，恢复时用它重新生成成员文件夹。 */
	backup(memberId: string): IMemberBackup {
		const row = this.db.get<{ definition_json: string; prompt: string; memory: string }>(
			'SELECT definition_json, prompt, memory FROM members WHERE member_id = ?', memberId,
		);
		if (!row) throw notFound(`成员不存在：${memberId}`);
		return { definitionJson: row.definition_json, prompt: row.prompt, memory: row.memory };
	}

	/** 设置真人的备注；AI 成员的备注写在成员文件里。 */
	setHumanDescription(memberId: string, description: string): IMember {
		const text = description.trim();
		const problem = memberDescriptionProblem(text);
		if (problem) throw invalid(problem);
		return this.db.transaction(() => {
			const member = this.require(memberId);
			if (member.type !== 'human') throw invalid('AI 成员的备注须在成员文件中修改');
			if (member.description !== text) {
				this.db.run('UPDATE members SET description = ? WHERE member_id = ?', text, memberId);
				this.events.emit({ type: 'member.changed', memberId });
			}
			return this.require(memberId);
		});
	}

	/** 软删除：数据都保留，记下删除时解散和退出了哪些群聊，恢复时用。头像跟着成员文件夹没了，显示默认头像。 */
	markDeleted(memberId: string, record: IDeletionRecord): void {
		this.db.transaction(() => {
			this.db.run(
				'UPDATE members SET deleted_at = ?, deletion_json = ?, avatar_hash = NULL WHERE member_id = ? AND deleted_at IS NULL',
				Date.now(), JSON.stringify(record), memberId,
			);
			this.events.emit({ type: 'member.changed', memberId });
		});
	}

	/** 已删除的成员又退出了一个群聊（它删除时解散的群聊恢复了，它在群里），恢复它时也加回去。 */
	recordLeftGroup(memberId: string, groupId: string): void {
		const record = this.deletionRecord(memberId);
		this.db.run('UPDATE members SET deletion_json = ? WHERE member_id = ?', JSON.stringify({ ...record, left: [...record.left, { groupId, watching: false }] }), memberId);
		this.events.emit({ type: 'member.changed', memberId });
	}

	/** 取消删除，返回删除时的记录。群聊由调用方按记录还原。 */
	undelete(memberId: string): IDeletionRecord {
		return this.db.transaction(() => {
			const record = this.deletionRecord(this.requireDeletedAi(memberId).memberId);
			this.db.run('UPDATE members SET deleted_at = NULL, deletion_json = NULL WHERE member_id = ?', memberId);
			this.events.emit({ type: 'member.changed', memberId });
			return record;
		});
	}

	/**
	 * 彻底删除已删除的 AI 成员：删掉只属于它的数据（存的成员文件、时间线和运行记录、计划、定时、工具审批方式、已读位置，
	 * 网页端成员页分组里的它、使用者看到哪一条），只留名字给对话里的消息显示发送者；名字空出来。浏览数据由调用方删。
	 */
	purge(memberId: string): void {
		this.db.transaction(() => {
			this.requireDeletedAi(memberId);
			// 它发出的消息留着，指向它时间线的调用条目要先清掉。
			this.db.run('UPDATE messages SET sender_item_id = NULL WHERE sender_member_id = ? AND sender_item_id IS NOT NULL', memberId);
			// 计划指着时间线里的条目，先删。
			for (const table of ['approvals', 'code_calls', 'tasks', 'plans', 'timeline_items']) this.db.run(`DELETE FROM ${table} WHERE member_id = ?`, memberId);
			this.db.run('DELETE FROM model_requests WHERE run_id IN (SELECT run_id FROM runs WHERE member_id = ?)', memberId);
			for (const table of ['runs', 'member_states', 'tool_policies', 'reminders', 'conversation_reads', 'timeline_views']) {
				this.db.run(`DELETE FROM ${table} WHERE member_id = ?`, memberId);
			}
			if (this.db.run('DELETE FROM member_section_members WHERE member_id = ?', memberId).changes > 0) this.events.emit({ type: 'memberSections.changed' });
			this.db.run(`
				UPDATE members SET description = '', prompt = '', model_provider = NULL, model = NULL, reasoning_effort = NULL,
					tools_json = NULL, skills_json = NULL, definition_json = '{}', memory = '', avatar_hash = NULL,
					working_directory = NULL, deletion_json = NULL, purged_at = ?
				WHERE member_id = ?
			`, Date.now(), memberId);
			this.events.emit({ type: 'member.changed', memberId });
		});
	}

	private deletionRecord(memberId: string): IDeletionRecord {
		const json = this.db.get<{ deletion_json: string | null }>('SELECT deletion_json FROM members WHERE member_id = ?', memberId)?.deletion_json;
		return json ? JSON.parse(json) as IDeletionRecord : { dissolved: [], left: [] };
	}

	/** 工作目录只能由用户设置，不在成员文件夹里。 */
	setWorkingDirectory(memberId: string, workingDirectory: string | null): IMember {
		const directory = checkWorkingDirectory(workingDirectory);
		return this.db.transaction(() => {
			this.requireAi(memberId);
			this.db.run('UPDATE members SET working_directory = ? WHERE member_id = ?', directory, memberId);
			this.events.emit({ type: 'member.changed', memberId });
			return this.require(memberId);
		});
	}

	/** 只改暂停标记；中止正在进行的运行由 Runs 负责。 */
	setPaused(memberId: string, paused: boolean): IMember {
		return this.db.transaction(() => {
			this.requireAi(memberId);
			const { changes } = this.db.run('UPDATE member_states SET paused = ? WHERE member_id = ? AND paused <> ?', paused ? 1 : 0, memberId, paused ? 1 : 0);
			if (changes > 0) this.events.emit({ type: 'member.changed', memberId });
			return this.require(memberId);
		});
	}

	requireAi(memberId: string): IMember {
		const member = this.require(memberId);
		if (member.type !== 'ai') throw invalid(`${member.name} 不是 AI 成员`);
		return member;
	}

	/** 两个 AI 成员之间，双方的设置都允许对方才能私聊；只要有一方是真人就没有限制。 */
	canDirectMessage(first: IMember, second: IMember): boolean {
		if (first.type === 'human' || second.type === 'human') return true;
		return allows(first.directMessage, second.memberId) && allows(second.directMessage, first.memberId);
	}

	/** AI 成员能不能把 target 拉进群聊：看 target 的设置；拉的是真人、或者是真人在拉时没有限制。 */
	canInviteToGroup(inviter: IMember, target: IMember): boolean {
		if (inviter.type === 'human' || target.type === 'human') return true;
		return allows(target.groupInvite, inviter.memberId);
	}

	/**
	 * 私聊、群聊名单写在成员文件里，用到时按名字找现在的 AI 成员，找不到的不算：名单里的成员以后才建、删除后又恢复，都不用重新同步。
	 * 真人没有成员文件，用 fallback。
	 */
	private rule(row: IMemberRow, definition: IMemberDefinition, key: 'directMessage' | 'groupInvite', fallback: 'none' | 'all'): IMemberRule {
		const rule = row.type === 'ai' ? definition[key] ?? fallback : fallback;
		if (typeof rule === 'string') return { mode: rule, memberIds: [] };
		// 名字列是 COLLATE NOCASE，直接比就不分大小写；带上 purged_at IS NULL 才用得上名字索引（部分索引）。
		const memberIds = ruleNames(rule).map(name => this.db.get<{ member_id: string }>(
			`SELECT member_id FROM members WHERE type = 'ai' AND deleted_at IS NULL AND name = ? AND purged_at IS NULL`, name,
		)?.member_id).filter(memberId => memberId !== undefined).sort();
		return { mode: 'allow' in rule ? 'allow' : 'deny', memberIds };
	}

	private toMember(row: IMemberRow): IMember {
		const definition = JSON.parse(row.definition_json) as IMemberDefinition;
		return {
			memberId: row.member_id,
			name: row.name,
			type: row.type,
			description: row.description,
			directMessage: this.rule(row, definition, 'directMessage', 'none'),
			groupInvite: this.rule(row, definition, 'groupInvite', 'all'),
			prompt: row.prompt,
			model: row.model_provider !== null && row.model !== null ? { provider: row.model_provider, model: row.model } : null,
			reasoningEffort: row.reasoning_effort,
			tools: row.tools_json === null ? null : JSON.parse(row.tools_json) as string[],
			skills: row.skills_json === null ? this.defaultSkills() : JSON.parse(row.skills_json) as string[],
			timeAwareness: row.type !== 'ai' || definition.timeAwareness !== false,
			avatar: row.avatar_hash,
			workingDirectory: row.working_directory,
			defaultWorkingDirectory: row.type === 'ai' ? join(this.workspacesDirectory, row.member_id) : null,
			// 目录可能在运行时外面被删掉或改名，每次都重新检查。
			workingDirectoryProblem: row.working_directory ? directoryProblem(row.working_directory) : null,
			paused: row.paused === 1,
			createdAt: row.created_at,
			deleted: row.deleted_at !== null,
			deletedAt: row.deleted_at,
			purged: row.purged_at !== null,
			deletion: row.deletion_json === null ? null : this.toDeletion(row.member_id, JSON.parse(row.deletion_json) as IDeletionRecord),
		};
	}

	private toDeletion(memberId: string, record: IDeletionRecord): IMemberDeletion {
		const groups = (ids: readonly string[]) => ids.map(groupId => ({
			groupId, name: this.db.get<{ name: string }>('SELECT name FROM groups WHERE group_id = ?', groupId)?.name ?? groupId,
		}));
		return {
			dissolvedGroups: groups(record.dissolved.map(group => group.groupId)),
			leftGroups: groups(record.left.map(group => group.groupId)),
			reminders: this.db.get<{ count: number }>('SELECT COUNT(*) AS count FROM reminders WHERE member_id = ?', memberId)!.count,
		};
	}
}

// 不取头像图片和存的成员文件，列成员时用不到。
const SELECT_MEMBER = `
	SELECT member.member_id, member.name, member.type, member.description, member.prompt, member.model_provider, member.model,
		member.reasoning_effort, member.tools_json, member.skills_json, member.avatar_hash, member.definition_json,
		member.working_directory, member.created_at, member.deleted_at, member.deletion_json, member.purged_at, state.paused
	FROM members member
	LEFT JOIN member_states state ON state.member_id = member.member_id
`;

function sameDefinition(member: IMember, definition: IAiDefinition): boolean {
	return member.description === definition.description && member.prompt === definition.prompt
		&& JSON.stringify(member.model) === JSON.stringify(definition.model)
		&& member.reasoningEffort === definition.reasoningEffort
		&& JSON.stringify(member.tools) === JSON.stringify(definition.tools) && member.avatar === definition.avatar;
}

function allows(rule: IMemberRule, targetId: string): boolean {
	switch (rule.mode) {
		case 'all': return true;
		case 'none': return false;
		case 'allow': return rule.memberIds.includes(targetId);
		case 'deny': return !rule.memberIds.includes(targetId);
	}
}
