import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api } from './client.ts';
import { queryKeys } from './keys.ts';
import type { IBrowserBlocklist, ICustomToolsSnapshot, IEventLogPage, IExternalOverview, IGroup, IMcpSnapshot, IReminder, IMemberFoldersSnapshot, IModelList, ISkill, ISkillDetail, ISkillSource, ISkillsSnapshot, IToolInfo } from './types.ts';

/** 没解散的群聊。 */
export function useGroups() {
	return useQuery({
		queryKey: queryKeys.groups,
		queryFn: async () => (await api<{ groups: IGroup[] }>('GET', '/v1/groups')).groups,
	});
}

export function useMemberFolders() {
	return useQuery({
		queryKey: queryKeys.memberFolders,
		queryFn: () => api<IMemberFoldersSnapshot>('GET', '/v1/member-folders'),
	});
}

export function useModels() {
	return useQuery({
		queryKey: queryKeys.models,
		queryFn: () => api<IModelList>('GET', '/v1/models'),
	});
}

/** 技能列表接口返回的内容：技能不含正文。 */
export type SkillList = Omit<ISkillsSnapshot, 'skills'> & { skills: Omit<ISkill, 'content'>[] };

const skillsQuery = {
	queryKey: queryKeys.skills,
	queryFn: () => api<SkillList>('GET', '/v1/skills'),
};

/** 技能目录、技能列表（不含正文）和读不出来的技能文件夹。 */
export function useSkillsSnapshot() {
	return useQuery(skillsQuery);
}

/** 技能列表，不含正文。 */
export function useSkills() {
	return useQuery({ ...skillsQuery, select: data => data.skills });
}

/** 一个技能的正文和文件夹里的其他文件。name 为空时不取。 */
export function useSkillDetail(name: string | undefined) {
	return useQuery({
		queryKey: queryKeys.skill(name ?? ''),
		queryFn: () => api<ISkillDetail>('GET', `/v1/skills/${encodeURIComponent(name!)}`),
		enabled: !!name,
		retry: false,
	});
}

/** 可以导入的技能：path 为空时是常见的全局 agent 技能目录，否则是这个文件夹。 */
export function useSkillSources(path: string) {
	return useQuery({
		queryKey: queryKeys.skillSources(path),
		queryFn: async () => (await api<{ sources: ISkillSource[] }>('GET', path ? `/v1/skill-sources?path=${encodeURIComponent(path)}` : '/v1/skill-sources')).sources,
	});
}

/** 成员的定时，和运行时所在机器现在的时区。 */
export function useReminders(memberId: string | undefined) {
	return useQuery({
		queryKey: queryKeys.reminders(memberId ?? ''),
		queryFn: () => api<{ reminders: IReminder[]; timeZone: string }>('GET', `/v1/members/${memberId}/reminders`),
		enabled: memberId !== undefined,
	});
}

/** AI 成员的记忆和上限字数。enabled 为 false 时不再请求，已经拿到的数据还在。 */
export function useMemory(memberId: string | undefined, enabled = true) {
	return useQuery({
		queryKey: queryKeys.memory(memberId ?? ''),
		queryFn: () => api<{ memory: string; limit: number }>('GET', `/v1/members/${memberId}/memory`),
		enabled: memberId !== undefined && enabled,
	});
}

/** MCP 服务器：配置文件、每个服务器的状态和工具。 */
export function useMcp() {
	return useQuery({
		queryKey: queryKeys.mcp,
		queryFn: () => api<IMcpSnapshot>('GET', '/v1/mcp'),
	});
}

/** 自定义工具：目录、每一项的配置和状态、读不出来的文件夹。 */
export function useCustomTools() {
	return useQuery({
		queryKey: queryKeys.customTools,
		queryFn: () => api<ICustomToolsSnapshot>('GET', '/v1/custom-tools'),
	});
}

/** 成员的浏览器禁止访问的网址。 */
export function useBrowserBlocklist() {
	return useQuery({
		queryKey: queryKeys.browserBlocklist,
		queryFn: () => api<IBrowserBlocklist>('GET', '/v1/browser-blocklist'),
	});
}

/** 全部工具和新成员的默认设置，新建 AI 成员时用。 */
export function useToolCatalog(enabled = true) {
	return useQuery({
		queryKey: queryKeys.toolCatalog,
		queryFn: async () => (await api<{ tools: IToolInfo[] }>('GET', '/v1/tools')).tools,
		enabled,
		staleTime: Infinity,
	});
}

/** enabled 为 false 时不再请求，已经拿到的数据还在。 */
export function useTools(memberId: string | undefined, enabled = true) {
	return useQuery({
		queryKey: queryKeys.tools(memberId ?? ''),
		queryFn: async () => (await api<{ tools: IToolInfo[] }>('GET', `/v1/members/${memberId}/tools`)).tools,
		enabled: memberId !== undefined && enabled,
	});
}

/** 外部事件的来源、路由和路由目录。 */
export function useExternal() {
	return useQuery({
		queryKey: queryKeys.external,
		queryFn: () => api<IExternalOverview>('GET', '/v1/external'),
	});
}

const LOG_PAGE_SIZE = 100;

/** 事件日志的一天，新的在前，每页 100 条，往下翻用 fetchNextPage。date 为空时是最近有日志的一天，source 为空时是全部来源。 */
export function useEventLog(date: string, source: string) {
	return useInfiniteQuery({
		queryKey: queryKeys.externalLog(date, source),
		queryFn: ({ pageParam }) => {
			const query = new URLSearchParams({ limit: String(LOG_PAGE_SIZE) });
			// 翻页时用第一页定下的日期，免得中间换了一天。
			const day = pageParam?.date ?? date;
			if (day) query.set('date', day);
			if (source) query.set('source', source);
			if (pageParam) query.set('before', String(pageParam.before));
			return api<IEventLogPage>('GET', `/v1/external/log?${query}`);
		},
		initialPageParam: undefined as { date: string; before: number } | undefined,
		getNextPageParam: page => page.more && page.date ? { date: page.date, before: page.entries.at(-1)!.offset } : undefined,
	});
}
