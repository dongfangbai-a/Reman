import type { ConversationRef, ConversationTarget } from './types.ts';

/** 对话的唯一标识，和运行时的 conversation_key 一致：私聊 D:<两人 ID 排序>，群聊 G:<群聊 ID>。 */
export function conversationKey(viewerMemberId: string, target: ConversationTarget): string {
	return target.kind === 'direct' ? `D:${[viewerMemberId, target.memberId].sort().join(':')}` : `G:${target.groupId}`;
}

export function refKey(ref: ConversationRef): string {
	return ref.kind === 'direct' ? `D:${[...ref.memberIds].sort().join(':')}` : `G:${ref.groupId}`;
}

/** 视角页里的对话；给了 messageId 时跳到那条消息。 */
export function conversationPath(perspectiveId: string, target: ConversationTarget, messageId?: number): string {
	const path = `/as/${perspectiveId}/${target.kind}/${target.kind === 'direct' ? target.memberId : target.groupId}`;
	return messageId === undefined ? path : `${path}?message=${messageId}`;
}

/** 从查看者的角度，消息所在的对话。 */
export function refTarget(ref: ConversationRef, viewerMemberId: string): ConversationTarget {
	if (ref.kind === 'group') return { kind: 'group', groupId: ref.groupId };
	return { kind: 'direct', memberId: ref.memberIds.find(id => id !== viewerMemberId) ?? viewerMemberId };
}

export function sameTarget(left: ConversationTarget, right: ConversationTarget): boolean {
	return left.kind === 'direct' ? right.kind === 'direct' && left.memberId === right.memberId : right.kind === 'group' && left.groupId === right.groupId;
}

export const queryKeys = {
	members: ['members'] as const,
	memberOverview: ['memberOverview'] as const,
	memberSections: ['memberSections'] as const,
	group: (groupId: string) => ['group', groupId] as const,
	conversations: (memberId: string) => ['conversations', memberId] as const,
	messages: (viewerMemberId: string, key: string) => ['messages', viewerMemberId, key] as const,
	memberStates: ['memberStates'] as const,
	groups: ['groups'] as const,
	messageSearch: (viewerMemberId: string, query: string) => ['messageSearch', viewerMemberId, query] as const,
	directories: (path: string | null) => ['directories', path ?? ''] as const,
	memberFolders: ['memberFolders'] as const,
	models: ['models'] as const,
	upstreamModels: (providerId: string) => ['upstreamModels', providerId] as const,
	runtimeState: ['runtimeState'] as const,
	portableGit: ['portableGit'] as const,
	sandbox: ['sandbox'] as const,
	terminalLimits: ['terminalLimits'] as const,
	remote: ['remote'] as const,
	terminals: ['terminals'] as const,
	skills: ['skills'] as const,
	skill: (name: string) => ['skill', name] as const,
	skillSources: (path: string) => ['skillSources', path] as const,
	tools: (memberId: string) => ['tools', memberId] as const,
	toolCatalog: ['toolCatalog'] as const,
	mcp: ['mcp'] as const,
	customTools: ['customTools'] as const,
	external: ['external'] as const,
	externalLog: (date: string, source: string) => ['external', 'log', date, source] as const,
	browserBlocklist: ['browserBlocklist'] as const,
	timeline: (memberId: string) => ['timeline', memberId] as const,
	runs: (memberId: string) => ['runs', memberId] as const,
	tasks: (memberId: string) => ['tasks', memberId] as const,
	callOutput: (runId: number, callId: string) => ['callOutput', runId, callId] as const,
	reminders: (memberId: string) => ['reminders', memberId] as const,
	memory: (memberId: string) => ['memory', memberId] as const,
	plan: (memberId: string) => ['plan', memberId] as const,
	contextUsage: (memberId: string) => ['contextUsage', memberId] as const,
	// since 不传（全部）用 'all'，和 0（1970 年以来的全部）分开。
	usage: (groupBy: string, since: number | undefined) => ['usage', groupBy, since ?? 'all'] as const,
	approvals: ['approvals'] as const,
	codeCalls: (memberId: string, runId: number, callId: string) => ['codeCalls', memberId, runId, callId] as const,
};
