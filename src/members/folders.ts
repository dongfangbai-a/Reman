import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import type { EventHub } from '../common/events.ts';
import { errorMessage, invalid, notFound } from '../common/errors.ts';
import { assertMemberName } from '../common/names.ts';
import type { Database } from '../database/database.ts';
import type { Groups } from '../groups/groups.ts';
import { CUSTOM_PREFIX } from '../customTools/definition.ts';
import { MCP_PREFIX } from '../mcp/config.ts';
import type { IModelRef } from '../models/config.ts';
import { skillNameProblem } from '../skills/skills.ts';
import {
	AVATAR_FILES, DEFINITION_FILE, INDEX_FILE, MEMORY_FILE, PROMPT_FILE, ruleNames, parseDefinition, serializeDefinition, type IMemberDefinition,
} from './definition.ts';
import type { IAiDefinition, IMember, Members } from './members.ts';
import { formatLocalTime } from '../common/text.ts';

const DEFINITION_MAX_BYTES = 64 * 1024;
const PROMPT_MAX_CHARS = 5_000;
const AVATAR_MAX_BYTES = 10 * 1024 * 1024;
const DELETED_NAME_ISSUE = '与已删除的成员同名：如需恢复该成员，请在网页端成员页的「已删除」中恢复；如需新建成员，请更换名字';
/** 文件夹里的文件变化后，等写入停下来再统一读取。 */
const WATCH_DEBOUNCE_MS = 300;

type MemberFolderStatus = 'ok' | 'warning' | 'error';

/** 一个成员文件夹最近一次读取的结果。 */
export interface IMemberFolderState {
	/** 文件夹名，也就是成员名。 */
	readonly name: string;
	/** 对应的成员；文件夹有误且从没成功读取过时没有。 */
	readonly memberId: string | null;
	readonly status: MemberFolderStatus;
	/** 有误或有警告时的说明。 */
	readonly issues: readonly string[];
	readonly path: string;
}

export interface IMemberFoldersSnapshot {
	readonly directory: string;
	/** AI 成员默认工作目录所在的目录。 */
	readonly workspacesDirectory: string;
	readonly loadedAt: number;
	readonly folders: readonly IMemberFolderState[];
}

/** 成员文件里能写的工具名：可设置的工具，以及总是可用、不用写的工具。 */
export interface IToolNames {
	readonly configurable: ReadonlySet<string>;
	readonly all: ReadonlySet<string>;
}

/** 检查成员文件时要知道的现有工具和技能。 */
interface IMemberFileChecks {
	toolNames(): IToolNames;
	skillNames(): ReadonlySet<string>;
	/** 模型能不能用；不能时说明原因。 */
	modelProblem(model: IModelRef): string | undefined;
}

/** 新建或修改成员时要写的内容；没给的文件不变。 */
export interface IMemberFiles {
	readonly definition?: IMemberDefinition;
	readonly prompt?: string;
}

interface IFolderScan {
	readonly name: string;
	readonly path: string;
	readonly definition: IMemberDefinition | undefined;
	readonly prompt: string;
	/** 头像文件的版本，见 avatarVersion；没有头像时为 null。 */
	readonly avatar: string | null;
	readonly errors: readonly string[];
}

/**
 * AI 成员由成员目录下的文件夹定义：文件夹名是成员名，member.json 写配置，prompt.md 写提示词，avatar.* 是头像；
 * memory.md 是成员自己记下的记忆，由 Memories 读写。
 * 文件改了就同步进数据库：文件有误时已有成员保持上一次正确的配置。数据库里同时存一份成员文件的内容。
 * 文件夹删掉时成员软删除；同名文件夹再出现时不读取，只能由用户在网页端恢复，恢复时文件夹不在就用存的内容重新生成。
 * 审批方式、工作目录、暂停不在文件里，只能由用户设置，成员改不了。
 */
export class MemberFolders {
	readonly directory: string;
	private readonly db: Database;
	private readonly events: EventHub;
	private readonly members: Members;
	private readonly groups: Groups;
	private readonly checks: IMemberFileChecks;
	private readonly onDeleted: (memberId: string) => void;
	private readonly onSynced: () => void;
	private states: readonly IMemberFolderState[] = [];
	private loadedAt = 0;
	private watcher: FSWatcher | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		directory: string, db: Database, events: EventHub, members: Members, groups: Groups, checks: IMemberFileChecks, onDeleted: (memberId: string) => void,
		onSynced: () => void = () => {},
	) {
		this.directory = directory;
		this.db = db;
		this.events = events;
		this.members = members;
		this.groups = groups;
		this.checks = checks;
		this.onDeleted = onDeleted;
		this.onSynced = onSynced;
		mkdirSync(directory, { recursive: true });
	}

	snapshot(): IMemberFoldersSnapshot {
		return { directory: this.directory, workspacesDirectory: this.members.workspacesDirectory, loadedAt: this.loadedAt, folders: this.states };
	}

	/** 读取全部成员文件夹，同步进数据库，再更新 INDEX.md。 */
	sync(): void {
		const scans = this.scan();
		const deleted: string[] = [];
		this.db.transaction(() => {
			const states = this.apply(scans, deleted);
			if (JSON.stringify(states) !== JSON.stringify(this.states)) this.events.emit({ type: 'memberFolders.changed' });
			this.states = states;
			this.loadedAt = Date.now();
		});
		for (const memberId of deleted) this.onDeleted(memberId);
		this.writeIndex();
		this.onSynced();
	}

	/** 新建 AI 成员：写好文件夹再同步；文件有误时删掉文件夹并报错。 */
	create(name: string, files: IMemberFiles): IMember {
		assertMemberName(name);
		const existing = this.members.findByName(name);
		if (existing?.deleted) throw invalid(`成员名「${name}」${DELETED_NAME_ISSUE}`);
		if (existing) throw invalid(`成员名「${name}」已被使用`);
		const path = join(this.directory, name);
		if (existsSync(path)) throw invalid(`成员文件夹「${name}」已存在`);
		mkdirSync(path);
		try {
			writeFiles(path, { definition: files.definition ?? {}, prompt: files.prompt ?? '' });
			return this.syncAndCheck(name);
		} catch (error) {
			rmSync(path, { recursive: true, force: true });
			this.sync();
			throw error;
		}
	}

	/** 修改 AI 成员的文件；改完有误时恢复原来的文件并报错。 */
	update(memberId: string, files: IMemberFiles): IMember {
		const member = this.members.requireAi(memberId);
		const path = join(this.directory, member.name);
		if (!existsSync(path)) throw notFound(`成员文件夹「${member.name}」不存在`);
		const previous = readOptional(join(path, DEFINITION_FILE));
		const previousPrompt = readOptional(join(path, PROMPT_FILE));
		try {
			writeFiles(path, files);
			return this.syncAndCheck(member.name);
		} catch (error) {
			restore(join(path, DEFINITION_FILE), previous);
			restore(join(path, PROMPT_FILE), previousPrompt);
			this.sync();
			throw error;
		}
	}

	/**
	 * 只改 member.json 里的模型和思考强度，其他字段原样保留。model 是 { provider, name }，null 表示用默认模型；
	 * reasoning 为 null 表示不指定。
	 */
	setModel(memberId: string, model: unknown, reasoning: unknown): IMember {
		const member = this.members.requireAi(memberId);
		const current = parseDefinition(readOptional(join(this.directory, member.name, DEFINITION_FILE)) ?? '{}');
		if (current.issues) throw invalid(`成员配置有误，请先在成员设置中修正：${current.issues.join('；')}`);
		const next = parseDefinition(JSON.stringify({
			...current.definition, model: undefined, reasoning: undefined,
			...model === null ? {} : { model }, ...reasoning === null ? {} : { reasoning },
		}));
		if (next.issues) throw invalid(next.issues.join('；'));
		// 文件里写了不可用的模型只算警告；这里是用户在选，不可用的直接拒绝。
		const chosen = next.definition.model;
		const problem = chosen && this.checks.modelProblem({ provider: chosen.provider, model: chosen.name });
		if (problem) throw invalid(problem);
		return this.update(memberId, { definition: next.definition });
	}

	/**
	 * member.json 没写 tools、skills 时写上给定的，成员不再跟着新成员的默认设置变。文件有错时不动。
	 * 已删除的成员改存的那份，恢复后也不变。
	 */
	pin(memberId: string, defaults: { readonly tools?: readonly string[]; readonly skills?: readonly string[] }): void {
		const member = this.members.requireIncludingDeleted(memberId);
		const text = member.deleted ? this.members.backup(memberId).definitionJson : readOptional(join(this.directory, member.name, DEFINITION_FILE)) ?? '{}';
		const current = parseDefinition(text);
		if (current.issues) return;
		const tools = current.definition.tools ?? defaults.tools;
		const skills = current.definition.skills ?? defaults.skills;
		if (tools === current.definition.tools && skills === current.definition.skills) return;
		const definition = { ...current.definition, ...tools && { tools }, ...skills && { skills } };
		if (member.deleted) this.members.saveDefinitionBackup(memberId, serializeDefinition(definition));
		else this.update(memberId, { definition });
	}

	/** 删除 AI 成员：删掉文件夹，同步后成员软删除。 */
	remove(memberId: string): void {
		const member = this.members.requireAi(memberId);
		rmSync(join(this.directory, member.name), { recursive: true, force: true });
		this.sync();
	}

	/**
	 * 恢复已删除的 AI 成员：成员文件夹不在时用存的内容生成，已有同名文件夹时用文件夹里的；
	 * 删除时解散和退出的群聊照记录还原。文件夹有误时和平常一样，成员用上次正确的配置。
	 */
	restore(memberId: string): IMember {
		const member = this.members.requireDeletedAi(memberId);
		const path = join(this.directory, member.name);
		if (!existsSync(path)) {
			const backup = this.members.backup(memberId);
			mkdirSync(path);
			writeFileSync(join(path, DEFINITION_FILE), backup.definitionJson, 'utf8');
			if (backup.prompt) writeFileSync(join(path, PROMPT_FILE), `${backup.prompt}\n`, 'utf8');
			if (backup.memory) writeFileSync(join(path, MEMORY_FILE), `${backup.memory}\n`, 'utf8');
		}
		this.db.transaction(() => this.groups.restoreMember(memberId, this.members.undelete(memberId)));
		this.sync();
		return this.members.require(memberId);
	}

	/** 头像文件的路径：只在成员文件夹里，已删除的成员没有。没有头像时是 undefined。 */
	avatarPath(memberId: string): string | undefined {
		const member = this.members.get(memberId);
		if (!member || member.type !== 'ai' || member.deleted) return undefined;
		const path = join(this.directory, member.name);
		return AVATAR_FILES.map(file => join(path, file)).find(file => existsSync(file));
	}

	/** 换头像：按内容判断图片格式，写成 avatar.<格式>，删掉原来的头像文件。content 为 undefined 时只删除。 */
	setAvatar(memberId: string, content: Buffer | undefined): IMember {
		const member = this.members.requireAi(memberId);
		const path = join(this.directory, member.name);
		if (!existsSync(path)) throw notFound(`成员文件夹「${member.name}」不存在`);
		let file: string | undefined;
		if (content !== undefined) {
			if (content.length > AVATAR_MAX_BYTES) throw invalid('头像不能超过 10 MB');
			const format = imageFormat(content);
			if (!format) throw invalid('头像只能是 png、jpg、webp 或 gif 图片');
			file = `avatar.${format}`;
		}
		for (const name of AVATAR_FILES) rmSync(join(path, name), { force: true });
		if (file && content) writeFileSync(join(path, file), content);
		this.sync();
		return this.members.requireAi(memberId);
	}

	/** 监听成员目录，文件变了自动同步。 */
	watch(): void {
		if (this.watcher) return;
		this.watcher = watch(this.directory, { recursive: true }, (_, file) => {
			// INDEX.md 是自己写的，不能因为它再同步一次。
			if (file === INDEX_FILE) return;
			clearTimeout(this.timer);
			this.timer = setTimeout(() => {
				try {
					this.sync();
				} catch (error) {
					console.error('同步成员文件夹失败：', error);
				}
			}, WATCH_DEBOUNCE_MS);
		});
		this.watcher.on('error', error => console.error('监听成员文件夹失败：', error));
	}

	close(): void {
		clearTimeout(this.timer);
		this.watcher?.close();
		this.watcher = undefined;
	}

	private syncAndCheck(name: string): IMember {
		this.sync();
		const state = this.states.find(item => item.name === name);
		if (!state?.memberId || state.status === 'error') throw invalid(`成员文件有误：${state?.issues.join('；') ?? '未能读取'}`);
		return this.members.require(state.memberId);
	}

	/** 以点开头的文件夹不算成员。 */
	private scan(): IFolderScan[] {
		return readdirSync(this.directory, { withFileTypes: true })
			.filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
			.map(entry => entry.name)
			.sort((left, right) => left.localeCompare(right))
			.map(name => scanFolder(name, join(this.directory, name)));
	}

	private apply(scans: readonly IFolderScan[], deleted: string[]): IMemberFolderState[] {
		const tools = this.checks.toolNames();
		const skills = this.checks.skillNames();
		const errors = new Map(scans.map(scan => [scan.name, [...scan.errors]]));
		const existing = new Map<string, IMember>();
		const seen = new Map<string, string>();
		for (const scan of scans) {
			const issues = errors.get(scan.name)!;
			const key = scan.name.toLowerCase();
			try {
				assertMemberName(scan.name);
			} catch (error) {
				issues.push(errorMessage(error));
			}
			// 区分大小写的文件系统上才会有名字只差大小写的两个文件夹。
			const other = seen.get(key);
			if (other !== undefined) issues.push(`与文件夹「${other}」的名字仅大小写不同，成员名不区分大小写`);
			seen.set(key, scan.name);
			const member = this.members.findByName(scan.name);
			if (member?.type === 'human') issues.push(`名字已被真人「${member.name}」使用`);
			else if (member?.deleted) issues.push(DELETED_NAME_ISSUE);
			else if (member && member.name !== scan.name) issues.push(`名字与成员「${member.name}」仅大小写不同；成员名创建后不能修改，请更换名字`);
			else if (member) existing.set(scan.name, member);
			for (const tool of scan.definition?.tools ?? []) {
				// MCP 服务器、自定义工具可能以后才有，下面只给警告。
				if (tools.configurable.has(tool) || tool.startsWith(MCP_PREFIX) || tool.startsWith(CUSTOM_PREFIX)) continue;
				issues.push(tools.all.has(tool) ? `工具「${tool}」始终可用，无需写入 tools` : `不存在名为「${tool}」的工具`);
			}
			for (const skill of scan.definition?.skills ?? []) {
				const problem = skillNameProblem(skill);
				if (problem) issues.push(problem);
			}
			if (scan.definition && ruleNames(scan.definition.directMessage).includes(scan.name)) issues.push('私聊名单中不能包含自己');
			if (scan.definition && ruleNames(scan.definition.groupInvite).includes(scan.name)) issues.push('群聊名单中不能包含自己');
		}

		// 先建好、更新好全部成员，再检查私聊、群聊名单：名单里可能有这次新建的成员。
		const saved = new Map<string, string>();
		for (const scan of scans) {
			if (errors.get(scan.name)!.length > 0 || !scan.definition) continue;
			saved.set(scan.name, this.members.saveAi(existing.get(scan.name)?.memberId, scan.name, toAiDefinition(scan)));
		}
		const folderKeys = new Set(scans.map(scan => scan.name.toLowerCase()));
		for (const member of this.members.list()) {
			if (member.type !== 'ai' || member.deleted || folderKeys.has(member.name.toLowerCase())) continue;
			this.members.markDeleted(member.memberId, this.groups.removeMember(member.memberId));
			deleted.push(member.memberId);
		}
		const activeAi = new Set(this.members.list().filter(member => member.type === 'ai' && !member.deleted).map(member => member.name.toLowerCase()));
		const warnings = new Map<string, string[]>();
		for (const scan of scans) {
			if (!saved.has(scan.name) || !scan.definition) continue;
			// 技能可能以后才放进技能目录，没找到只给警告。
			const notes = (scan.definition.skills ?? []).filter(skill => !skills.has(skill)).map(skill => `技能「${skill}」不存在，无法读取`);
			for (const tool of scan.definition.tools ?? []) {
				if (tool.startsWith(MCP_PREFIX) && !tools.configurable.has(tool)) notes.push(`不存在 MCP 服务器「${tool.slice(MCP_PREFIX.length)}」，无法使用其工具`);
				if (tool.startsWith(CUSTOM_PREFIX) && !tools.configurable.has(tool)) notes.push(`自定义工具「${tool.slice(CUSTOM_PREFIX.length)}」不存在，无法使用其工具`);
			}
			// 模型可能以后才添加，用不了只给警告，运行时会报错。
			const model = scan.definition.model;
			const modelProblem = model && this.checks.modelProblem({ provider: model.provider, model: model.name });
			if (modelProblem) notes.push(`模型不可用：${modelProblem}`);
			warnings.set(scan.name, notes);
			// 名单用到时按名字找（见 Members），这里只提醒找不到的。
			for (const [label, rule] of [['群聊', scan.definition.groupInvite], ['私聊', scan.definition.directMessage]] as const) {
				for (const name of ruleNames(rule)) {
					if (!activeAi.has(name.toLowerCase())) notes.push(`${label}名单中的「${name}」不是现有的 AI 成员，已忽略`);
				}
			}
		}

		return scans.map(scan => {
			const issues = errors.get(scan.name)!;
			const memberId = saved.get(scan.name) ?? existing.get(scan.name)?.memberId ?? null;
			if (issues.length > 0) return { name: scan.name, memberId, status: 'error', issues, path: scan.path };
			const notes = warnings.get(scan.name) ?? [];
			return { name: scan.name, memberId, status: notes.length > 0 ? 'warning' : 'ok', issues: notes, path: scan.path };
		});
	}

	/** INDEX.md：给用户和成员看的成员、群聊索引。内容没变时不重写。 */
	private writeIndex(): void {
		const members = this.members.list();
		const names = new Map(members.map(member => [member.memberId, member.name]));
		const deleted = members.filter(member => member.type === 'ai' && member.deleted && !member.purged);
		const lines = [
			'# 成员索引',
			'',
			'由运行时自动生成，手动修改会被覆盖。',
			'',
			`成员文件夹读取时间：${formatLocalTime(this.loadedAt)}`,
			'',
			'## AI 成员',
			'',
			'| 成员名 | ID | 备注 | 状态 |',
			'| --- | --- | --- | --- |',
			...this.states.map(state => {
				const member = state.memberId ? this.members.get(state.memberId) : undefined;
				const status = state.status === 'ok' ? '正常' : `${state.status === 'warning' ? '有警告' : '有误'}：${state.issues.join('；')}`;
				return `| ${cell(state.name)} | ${state.memberId ?? '—'} | ${cell(member?.description ?? '')} | ${cell(status)} |`;
			}),
			'',
			'## 群聊',
			'',
			'| 群聊名 | ID | 创建者 | 成员 |',
			'| --- | --- | --- | --- |',
			...this.groups.listActive().map(group => `| ${cell(group.name)} | ${group.groupId} | ${cell(names.get(group.ownerMemberId) ?? '')} | ${
				cell(group.members.map(membership => names.get(membership.memberId) ?? membership.memberId).join('、'))} |`),
			'',
			...deleted.length === 0 ? [] : [
				'## 已删除的成员',
				'',
				'这些名字仍被占用，新建成员时不能使用。用户可在网页端恢复这些成员。',
				'',
				'| 成员名 | ID | 删除时间 |',
				'| --- | --- | --- |',
				...deleted.map(member => `| ${cell(member.name)} | ${member.memberId} | ${formatLocalTime(member.deletedAt!)} |`),
				'',
			],
		];
		const content = lines.join('\n');
		const path = join(this.directory, INDEX_FILE);
		if (readOptional(path) !== content) writeFileSync(path, content, 'utf8');
	}
}

function scanFolder(name: string, path: string): IFolderScan {
	const errors: string[] = [];
	let definition: IMemberDefinition | undefined;
	const definitionPath = join(path, DEFINITION_FILE);
	if (!existsSync(definitionPath)) {
		errors.push(`缺少 ${DEFINITION_FILE}，最简写法为 {}`);
	} else if (statSync(definitionPath).size > DEFINITION_MAX_BYTES) {
		errors.push(`${DEFINITION_FILE} 过大，最大 ${DEFINITION_MAX_BYTES / 1024} KB`);
	} else {
		const parsed = parseDefinition(readFileSync(definitionPath, 'utf8'));
		if (parsed.definition) definition = parsed.definition;
		else errors.push(...parsed.issues);
	}
	const prompt = (readOptional(join(path, PROMPT_FILE)) ?? '').replace(/^﻿/, '').trimEnd();
	if (prompt.length > PROMPT_MAX_CHARS) errors.push(`${PROMPT_FILE} 过长，最多 ${PROMPT_MAX_CHARS} 个字符`);
	let avatar: string | null = null;
	const avatarFile = AVATAR_FILES.find(file => existsSync(join(path, file)));
	if (avatarFile) {
		const stat = statSync(join(path, avatarFile));
		if (stat.size > AVATAR_MAX_BYTES) errors.push('头像不能超过 10 MB');
		else avatar = avatarVersion(avatarFile, stat.size, stat.mtimeMs);
	}
	return { name, path, definition, prompt, avatar, errors };
}

/** 头像文件的版本：格式、大小和修改时间，变了前端重新加载。不读内容：每次同步每个成员都要算一遍，头像最大 10 MB。 */
function avatarVersion(file: string, size: number, mtimeMs: number): string {
	return `${file.slice(file.indexOf('.') + 1)}-${size.toString(36)}-${Math.floor(mtimeMs).toString(36)}`;
}

function toAiDefinition(scan: IFolderScan): IAiDefinition {
	const definition = scan.definition!;
	return {
		description: definition.description ?? '',
		prompt: scan.prompt,
		model: definition.model ? { provider: definition.model.provider, model: definition.model.name } : null,
		reasoningEffort: definition.reasoning ?? null,
		tools: definition.tools ?? null,
		skills: definition.skills ?? null,
		avatar: scan.avatar,
		definitionJson: serializeDefinition(definition),
	};
}

/** 写成员文件。传入的配置先按读文件的规则检查一遍，有误时不写。空提示词删掉 prompt.md。 */
function writeFiles(path: string, files: IMemberFiles): void {
	if (files.definition !== undefined) {
		const text = serializeDefinition(files.definition);
		const parsed = parseDefinition(text);
		if (parsed.issues) throw invalid(`成员配置有误：${parsed.issues.join('；')}`);
		writeFileSync(join(path, DEFINITION_FILE), text, 'utf8');
	}
	if (files.prompt !== undefined) {
		if (files.prompt.trim()) writeFileSync(join(path, PROMPT_FILE), files.prompt.endsWith('\n') ? files.prompt : `${files.prompt}\n`, 'utf8');
		else rmSync(join(path, PROMPT_FILE), { force: true });
	}
}

function imageFormat(content: Buffer): 'png' | 'jpg' | 'webp' | 'gif' | undefined {
	if (content.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
	if (content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff) return 'jpg';
	if (content.subarray(0, 4).toString('latin1') === 'RIFF' && content.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
	if (content.subarray(0, 4).toString('latin1') === 'GIF8') return 'gif';
	return undefined;
}

function readOptional(path: string): string | undefined {
	try {
		return readFileSync(path, 'utf8');
	} catch {
		return undefined;
	}
}

function restore(path: string, content: string | undefined): void {
	if (content === undefined) rmSync(path, { force: true });
	else writeFileSync(path, content, 'utf8');
}

function cell(text: string): string {
	return text.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
}
