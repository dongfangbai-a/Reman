import type { Groups } from '../groups/groups.ts';
import type { IMember, Members } from '../members/members.ts';
import type { Memories } from '../members/memory.ts';
import type { IFunctionTool } from '../models/client.ts';
import type { IModelRef } from '../models/config.ts';
import type { Sandbox } from '../sandbox/sandbox.ts';
import type { Skills } from '../skills/skills.ts';
import type { IChangeNotice } from '../timeline/timeline.ts';
import { SANDBOX_RULES } from '../tools/command/shell.ts';
import { toolSummary, type Tools } from '../tools/tools.ts';
import { listedDescription } from '../tools/work/readSkill.ts';
import type { Environment, IShellInfo } from './environment.ts';

/** 变动说明给用户看的概括里，名字多时只写前几个。 */
const BRIEF_NAMES = 3;

interface IGroupState {
	readonly name: string;
	/** 「群名」(ID)。 */
	readonly label: string;
	/** 创建者在通讯录里的写法。创建者不会变：不能退群，被删除时群跟着解散。 */
	readonly owner: string;
	readonly watching: boolean;
	/** 群成员 ID 到通讯录里的写法，按群里的顺序。 */
	readonly members: ReadonlyMap<string, string>;
}

/** 成员这时能用什么、在什么环境里。每次请求记下，下一次请求拿来比；通讯录也按它写。 */
interface IState {
	/** 工具名到用途（说明的第一句）。 */
	readonly tools: ReadonlyMap<string, string>;
	/** 能读的技能（配置了、并且存在）到说明。 */
	readonly skills: ReadonlyMap<string, string>;
	readonly sandbox: boolean;
	readonly shell: IShellInfo;
	readonly workingDirectory: string;
	/** 开没开时间感知。 */
	readonly timeAware: boolean;
	/** 所在的群聊，按加入的顺序。 */
	readonly groups: ReadonlyMap<string, IGroupState>;
	/** 能私聊的成员 ID 到通讯录里的写法。 */
	readonly contacts: ReadonlyMap<string, string>;
}

export interface IContextSnapshot {
	/** 生成快照时成员用的模型；配置有误时是 undefined。 */
	readonly model: string | undefined;
	readonly tools: readonly IFunctionTool[];
	/** 运行规则里要不要提关注群聊：有没有 manage_group。 */
	readonly canWatch: boolean;
	/** 运行规则里要不要说时间：开没开时间感知。中途改了用变动说明告诉模型，不改规则，免得缓存从最前面断掉。 */
	readonly timeAware: boolean;
	/** 开头那条用户消息里的运行环境和通讯录。 */
	readonly setting: string;
}

interface IStored extends IContextSnapshot {
	/** 生成运行环境和通讯录时，它前面的成员设定和记忆。 */
	readonly basis: string;
	state: IState;
}

export interface ISnapshotDependencies {
	readonly members: Members;
	readonly groups: Groups;
	readonly tools: Tools;
	readonly skills: Skills;
	readonly memories: Memories;
	readonly environment: Environment;
	readonly sandbox: Pick<Sandbox, 'state' | 'check'>;
	/** 成员现在用的模型，配置有误时是 undefined。 */
	readonly currentModel: (member: IMember) => IModelRef | undefined;
}

/**
 * 上下文里会变的固定内容用快照：工具列表在全部输入前面，运行环境和通讯录在开头那条用户消息的最后，一变后面的内容就都命中不了缓存。
 * 快照只在缓存本来就要断的时候重新生成：换了模型、压缩之后、运行时重启；运行环境和通讯录在它前面的成员设定或记忆变了时也跟着换。
 * 其他时候的变动，每次请求前和上一次请求时的状态比，在时间线里追加一条说明。快照里不写时间，时间由收到的内容带着（运行时设计第 5 部分「时间」）。快照只在内存里：升级后工具的说明和参数可能变了。
 */
export class ContextSnapshots {
	private readonly dependencies: ISnapshotDependencies;
	private readonly stored = new Map<string, IStored>();

	constructor(dependencies: ISnapshotDependencies) {
		this.dependencies = dependencies;
	}

	/** 这时用的快照。还没有时（运行时刚启动、压缩之后）临时生成一份，不存下：估算用量、压缩时用。 */
	current(member: IMember): IContextSnapshot {
		const stored = this.stored.get(member.memberId);
		if (!stored) return this.build(member);
		const basis = this.basis(member);
		if (stored.basis === basis) return stored;
		// 前面的成员设定或记忆变了，缓存已经从那里断了，运行环境和通讯录顺带换成最新的。
		const now = this.state(member);
		const next: IStored = {
			...stored, basis, setting: this.setting(member, now),
			state: { ...stored.state, shell: now.shell, workingDirectory: now.workingDirectory, groups: now.groups, contacts: now.contacts },
		};
		this.stored.set(member.memberId, next);
		return next;
	}

	/** 请求前调用：还没有快照、或者换了模型时重新生成并存下。沙箱还在检查时先等检查完，免得一有结果就多一条说明。 */
	async prepare(member: IMember): Promise<void> {
		const model = modelKey(this.dependencies.currentModel(member));
		const stored = this.stored.get(member.memberId);
		if (stored && stored.model === model) {
			this.current(member);
			return;
		}
		if (this.dependencies.sandbox.state().kind === 'checking') await this.dependencies.sandbox.check();
		this.stored.set(member.memberId, this.build(member));
	}

	/** 和上一次请求时比，有变动时返回说明，并记下这次的状态。没有存下的快照时不比。 */
	changes(member: IMember): IChangeNotice | undefined {
		const stored = this.stored.get(member.memberId);
		if (!stored) return undefined;
		const previous = stored.state;
		const now = this.state(member);
		// 沙箱正在检查、安装或卸载时不算变动，有了结果再比。
		const sandbox = settling(this.dependencies.sandbox.state().kind) ? previous.sandbox : now.sandbox;
		stored.state = { ...now, sandbox };
		return describeChanges(previous, stored.state);
	}

	/** 压缩之后调用：下次请求重新生成。 */
	refresh(memberId: string): void {
		this.stored.delete(memberId);
	}

	private build(member: IMember): IStored {
		const state = this.state(member);
		return {
			model: modelKey(this.dependencies.currentModel(member)),
			tools: this.dependencies.tools.definitions(member.memberId),
			canWatch: state.tools.has('manage_group'),
			timeAware: state.timeAware,
			setting: this.setting(member, state),
			basis: this.basis(member),
			state,
		};
	}

	private basis(member: IMember): string {
		return `${member.prompt}\u0000${this.dependencies.memories.snapshot(member.memberId)}`;
	}

	private setting(member: IMember, state: IState): string {
		return [this.dependencies.environment.describe(member.memberId), addressBook(state)].join('\n\n');
	}

	/** 每次请求前都要算一遍：成员一次全部取出，没配技能时不读技能目录。 */
	private state(member: IMember): IState {
		const { tools, skills, sandbox, environment, groups, members } = this.dependencies;
		const all = member.skills.length > 0 ? skills.snapshot().skills : [];
		const memberSkills = member.skills.flatMap(name => all.filter(skill => skill.name === name));
		const everyone = new Map(members.list().map(other => [other.memberId, other]));
		const memberGroups = groups.listForMember(member.memberId).flatMap(group => {
			const own = group.members.find(membership => membership.memberId === member.memberId);
			if (group.dissolved || !own) return [];
			const entries = group.members.map(membership => {
				const profile = everyone.get(membership.memberId)!;
				const notes = [profile.type === 'human' ? '真人' : 'AI'];
				if (membership.memberId === member.memberId) notes.push('你自己');
				return [membership.memberId, `${profile.name}(${membership.memberId}，${notes.join('，')})`] as const;
			});
			const labels = new Map(entries);
			const state: IGroupState = { name: group.name, label: `「${group.name}」(${group.groupId})`, owner: labels.get(group.ownerMemberId)!, watching: own.watching, members: labels };
			return [[group.groupId, state] as const];
		});
		const contacts = [...everyone.values()]
			.filter(other => !other.deleted && other.memberId !== member.memberId && members.canDirectMessage(member, other));
		return {
			tools: new Map(tools.available(member.memberId).map(tool => [tool.name, toolSummary(tool)])),
			skills: new Map(memberSkills.map(skill => [skill.name, listedDescription(skill.description)])),
			sandbox: sandbox.state().kind === 'ready',
			shell: environment.shell(),
			workingDirectory: environment.workingDirectory(member.memberId),
			timeAware: member.timeAwareness,
			groups: new Map(memberGroups),
			contacts: new Map(contacts.map(other => [other.memberId, contactLabel(other)])),
		};
	}
}

/** 开头快照里的通讯录，和比较用的状态出自同一份数据。 */
function addressBook(state: IState): string {
	const lines = [
		'# 通讯录',
		'已关注的群聊中，每条新消息都会提醒你处理；未关注的群聊中，只有点名你的消息会提醒你，其他消息不单独提醒，这些消息在你下次处理时一并提供。',
		'',
		'## 群聊',
	];
	for (const group of state.groups.values()) {
		lines.push(`- ${groupSummary(group)}`, `  成员：${[...group.members.values()].join('、')}`);
	}
	if (state.groups.size === 0) lines.push('无');
	lines.push('', '## 可私聊的成员');
	for (const label of state.contacts.values()) lines.push(`- ${label}`);
	if (state.contacts.size === 0) lines.push('无');
	return lines.join('\n');
}

/** 群名和 ID、创建者、关注没有：通讯录和变动说明里新进的群都这样写。创建者写在群名后面，不埋在成员列表里。 */
function groupSummary(group: IGroupState): string {
	return `${group.label}，创建者：${group.owner}，${group.watching ? '已关注' : '未关注'}`;
}

function modelKey(model: IModelRef | undefined): string | undefined {
	return model && `${model.provider}/${model.model}`;
}

function settling(kind: string): boolean {
	return kind === 'checking' || kind === 'installing' || kind === 'uninstalling';
}

function contactLabel(member: IMember): string {
	return `${member.name}(${member.memberId}，${member.type === 'human' ? '真人' : 'AI'})`;
}

/** 两次请求之间的变动：给模型的说明只陈述事实，给用户的概括一句话。没有变动时是 undefined。 */
function describeChanges(previous: IState, now: IState): IChangeNotice | undefined {
	const lines: string[] = [];
	const brief: string[] = [];

	const addedTools = [...now.tools].filter(([name]) => !previous.tools.has(name));
	const removedTools = [...previous.tools.keys()].filter(name => !now.tools.has(name));
	if (addedTools.length > 0) {
		lines.push('新增渐进式工具：', ...addedTools.map(([name, summary]) => `- ${name}：${summary}`));
		brief.push(`新增工具 ${names(addedTools.map(([name]) => name))}`);
	}
	if (removedTools.length > 0) {
		lines.push(`不再可用的工具：${removedTools.join('、')}`);
		brief.push(`工具 ${names(removedTools)} 不再可用`);
	}

	const addedSkills = [...now.skills].filter(([name]) => !previous.skills.has(name));
	const removedSkills = [...previous.skills.keys()].filter(name => !now.skills.has(name));
	if (addedSkills.length > 0) {
		lines.push('新增技能：', ...addedSkills.map(([name, description]) => `- ${name}：${description}`));
		brief.push(`新增技能 ${names(addedSkills.map(([name]) => name))}`);
	}
	if (removedSkills.length > 0) {
		lines.push(`不再可用的技能：${removedSkills.join('、')}`);
		brief.push(`技能 ${names(removedSkills)} 不再可用`);
	}

	// 沙箱只关系到 shell。新增 shell 时它的说明（more_tools 的 describe）是现在的，已经写了沙箱。
	if (now.sandbox !== previous.sandbox && now.tools.has('shell') && previous.tools.has('shell')) {
		lines.push(now.sandbox ? `命令改为在沙箱中执行：${SANDBOX_RULES}` : '命令不再在沙箱中执行。');
		brief.push(now.sandbox ? '命令改为在沙箱中执行' : '命令不再在沙箱中执行');
	}
	const shell = now.shell;
	if (shell.label !== previous.shell.label || shell.syntax !== previous.shell.syntax || shell.hint !== previous.shell.hint) {
		lines.push(`shell 工具和终端改为使用 ${shell.label}，命令采用 ${shell.syntax} 语法。${shell.hint ?? ''}`);
		brief.push(`shell 改用 ${shell.label}`);
	}
	if (now.workingDirectory !== previous.workingDirectory) {
		lines.push(`工作目录已改为 ${now.workingDirectory}。`);
		brief.push(`工作目录改为 ${now.workingDirectory}`);
	}
	if (now.timeAware !== previous.timeAware) {
		lines.push(now.timeAware ? '系统会不定期提供时间：写在收到的内容的内容编号之后，表示收到该内容的时刻。' : '系统已停止提供时间。上下文中已有的时间仅表示当时的时刻，不代表当前时刻。');
		brief.push(now.timeAware ? '开启时间感知' : '关闭时间感知');
	}

	const joined: string[] = [];
	const changed: string[] = [];
	for (const [groupId, group] of now.groups) {
		const before = previous.groups.get(groupId);
		if (!before) {
			lines.push(`新加入的群聊${groupSummary(group)}，成员：${[...group.members.values()].join('、')}`);
			joined.push(`「${group.name}」`);
			continue;
		}
		const added = [...group.members].filter(([memberId]) => !before.members.has(memberId)).map(([, label]) => label);
		const left = [...before.members].filter(([memberId]) => !group.members.has(memberId)).map(([, label]) => label);
		if (added.length === 0 && left.length === 0) continue;
		const parts = [...added.length > 0 ? [`新增成员：${added.join('、')}`] : [], ...left.length > 0 ? [`离开的成员：${left.join('、')}`] : []];
		lines.push(`群聊${group.label} ${parts.join('；')}`);
		changed.push(`「${group.name}」`);
	}
	const gone = [...previous.groups].filter(([groupId]) => !now.groups.has(groupId)).map(([, group]) => group);
	for (const group of gone) lines.push(`你已不在群聊${group.label}中`);
	if (joined.length > 0) brief.push(`加入群聊${names(joined)}`);
	if (changed.length > 0) brief.push(`群聊${names(changed)}成员变动`);
	if (gone.length > 0) brief.push(`已不在群聊${names(gone.map(group => `「${group.name}」`))}中`);

	const addedContacts = [...now.contacts].filter(([memberId]) => !previous.contacts.has(memberId)).map(([, label]) => label);
	const removedContacts = [...previous.contacts].filter(([memberId]) => !now.contacts.has(memberId)).map(([, label]) => label);
	if (addedContacts.length > 0) {
		lines.push(`新增可私聊的成员：${addedContacts.join('、')}`);
		brief.push(`新增可私聊成员 ${names(addedContacts.map(contactName))}`);
	}
	if (removedContacts.length > 0) {
		lines.push(`不再可私聊的成员：${removedContacts.join('、')}`);
		brief.push(`不再可私聊 ${names(removedContacts.map(contactName))}`);
	}

	return lines.length > 0 ? { text: lines.join('\n'), brief: brief.join('；') } : undefined;
}

/** 名字多时只写前几个和总数。 */
function names(list: readonly string[]): string {
	return list.length > BRIEF_NAMES ? `${list.slice(0, BRIEF_NAMES).join('、')} 等 ${list.length} 个` : list.join('、');
}

/** 通讯录写法「名字(ID，…)」里的名字。 */
function contactName(label: string): string {
	return label.slice(0, label.lastIndexOf('('));
}
