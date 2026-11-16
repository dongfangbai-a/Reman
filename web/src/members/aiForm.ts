import type { IMember, IMemberDefinition, IToolInfo, MemberRuleMode, ToolPolicy } from '../api/types.ts';

/** AI 成员表单的内容。model 是「供应商\n模型」，空表示默认模型；reasoning 空表示不指定。 */
export interface IAiForm {
	readonly name: string;
	readonly description: string;
	readonly model: string;
	readonly reasoning: string;
	readonly prompt: string;
	/** 可设置的工具：有没有、审批方式。工具列表加载前为空。 */
	readonly tools: Readonly<Record<string, { readonly enabled: boolean; readonly policy: ToolPolicy }>>;
	readonly skills: readonly string[];
	readonly dmMode: MemberRuleMode;
	readonly dmMemberIds: readonly string[];
	/** 哪些 AI 成员能把它拉进群聊，默认都能。 */
	readonly groupMode: MemberRuleMode;
	readonly groupMemberIds: readonly string[];
	/** 时间感知：收到的内容带不带收到时的时间，默认带。 */
	readonly timeAwareness: boolean;
	/** 用指定的工作目录；false 时用运行时分配的默认目录，workingDirectory 不保存。 */
	readonly customDirectory: boolean;
	readonly workingDirectory: string;
}

export const EMPTY_FORM: IAiForm = {
	name: '', description: '', model: '', reasoning: '', prompt: '', tools: {}, skills: [],
	dmMode: 'none', dmMemberIds: [], groupMode: 'all', groupMemberIds: [], timeAwareness: true, customDirectory: false, workingDirectory: '',
};

export function modelKey(provider: string, model: string): string {
	return `${provider}\n${model}`;
}

export function fromMember(member: IMember, tools: readonly IToolInfo[] | undefined): IAiForm {
	return {
		name: member.name,
		description: member.description,
		model: member.model ? modelKey(member.model.provider, member.model.model) : '',
		reasoning: member.reasoningEffort ?? '',
		prompt: member.prompt,
		tools: tools ? { ...missingGroups(member, tools), ...toolsForm(tools) } : {},
		skills: member.skills,
		dmMode: member.directMessage.mode,
		dmMemberIds: member.directMessage.memberIds,
		groupMode: member.groupInvite.mode,
		groupMemberIds: member.groupInvite.memberIds,
		timeAwareness: member.timeAwareness,
		customDirectory: !!member.workingDirectory,
		workingDirectory: member.workingDirectory ?? '',
	};
}

/** 表单里可设置的工具。 */
export function toolsForm(tools: readonly IToolInfo[] | undefined): IAiForm['tools'] {
	return Object.fromEntries((tools ?? []).filter(tool => tool.configurable).map(tool => [tool.name, { enabled: tool.enabled, policy: tool.policy }]));
}

/** 文件里写了、但没有的 MCP 服务器和自定义工具：保留在表单里，保存时不丢。 */
function missingGroups(member: IMember, tools: readonly IToolInfo[]): IAiForm['tools'] {
	const names = (member.tools ?? []).filter(name => (name.startsWith('mcp:') || name.startsWith('custom:')) && !tools.some(tool => tool.name === name));
	return Object.fromEntries(names.map(name => [name, { enabled: true, policy: 'ask' as const }]));
}

/** 写进 member.json 的内容：只写和默认值不同的字段。私聊、群聊名单写成员名。 */
export function toDefinition(form: IAiForm, nameOf: (memberId: string) => string): IMemberDefinition {
	const definition: { -readonly [K in keyof IMemberDefinition]: IMemberDefinition[K] } = {};
	if (form.description.trim()) definition.description = form.description.trim();
	if (form.model) {
		const [provider, name] = form.model.split('\n') as [string, string];
		definition.model = { provider, name };
	}
	if (form.reasoning) definition.reasoning = form.reasoning;
	if (form.dmMode === 'all') definition.directMessage = 'all';
	if (form.dmMode === 'allow') definition.directMessage = { allow: form.dmMemberIds.map(nameOf) };
	if (form.dmMode === 'deny') definition.directMessage = { deny: form.dmMemberIds.map(nameOf) };
	if (form.groupMode === 'none') definition.groupInvite = 'none';
	if (form.groupMode === 'allow') definition.groupInvite = { allow: form.groupMemberIds.map(nameOf) };
	if (form.groupMode === 'deny') definition.groupInvite = { deny: form.groupMemberIds.map(nameOf) };
	if (!form.timeAwareness) definition.timeAwareness = false;
	// 技能和启用的工具都写明，以后改新成员的默认设置不影响这个成员。工具列表还没取到时不写工具。
	definition.skills = [...form.skills].sort();
	const tools = Object.entries(form.tools);
	if (tools.length > 0) definition.tools = tools.filter(([, tool]) => tool.enabled).map(([name]) => name).sort();
	return definition;
}

/** 要保存的工作目录：指定的路径，或者 null 表示用默认目录。 */
export function directoryValue(form: IAiForm): string | null {
	return form.customDirectory ? form.workingDirectory.trim() : null;
}

/** 比较两份表单保存出来是否一样。 */
export function sameForm(left: IAiForm, right: IAiForm): boolean {
	const normalize = (form: IAiForm) => JSON.stringify({
		definition: toDefinition(form, id => id),
		prompt: form.prompt.trim(),
		policies: Object.entries(form.tools).map(([name, tool]) => [name, tool.policy]).sort(),
		workingDirectory: directoryValue(form),
	});
	return normalize(left) === normalize(right);
}

/** 思考强度，按从低到高的顺序。 */
export const REASONING_LABELS: Record<string, string> = { low: '低', medium: '中', high: '高', xhigh: '极高', max: '最大' };

export const POLICY_LABELS: Record<ToolPolicy, string> = { ask: '每次审批', auto: '按规则判断', allow: '免审批' };

/** 删除、彻底删除 AI 成员前确认时的说明：成员列表的菜单和成员设置共用。 */
export const DELETE_DETAIL = '该成员创建的群聊将解散，定时将暂停。删除后可在成员页的「已删除」中恢复。';
export const PURGE_DETAIL = '时间线、运行记录、定时和浏览数据将被删除，且无法恢复。对话中的消息将保留。';

/** 私聊、拉进群聊的规则。 */
export const RULE_LABELS: Record<MemberRuleMode, string> = { none: '不允许', all: '全部允许', allow: '仅允许以下成员', deny: '允许以下成员之外的所有成员' };
