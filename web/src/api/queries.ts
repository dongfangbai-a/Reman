import { useInfiniteQuery, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { api } from './client.ts';
import { conversationKey, queryKeys } from './keys.ts';
import type { ConversationTarget, IConversationSummary, IGroup, IMemberSection, IMessage, IMember, MemberOverview } from './types.ts';

const PAGE_SIZE = 50;
/** 停在底部时，已加载的超过这么多条就去掉最早的，留最新的 KEEP_MESSAGES 条。 */
const TRIM_MESSAGES = 150;
const KEEP_MESSAGES = 100;
/** 离开底部后新来的，接在后面的最多这么多条；再多就记成后面还有。 */
const DETACHED_NEW_MESSAGES = 50;

export function useMembers() {
	return useQuery({
		queryKey: queryKeys.members,
		queryFn: async () => (await api<{ members: IMember[] }>('GET', '/v1/members')).members,
	});
}

/** 成员页每一行要显示的：AI 成员最近的结果、使用者看过没有，真人的未读。图标栏的角标也用它，网页开着就一直在用。 */
export function useMemberOverview() {
	return useQuery({
		queryKey: queryKeys.memberOverview,
		queryFn: async () => new Map((await api<{ members: MemberOverview[] }>('GET', '/v1/member-overview')).members.map(member => [member.memberId, member])),
	});
}

/** 等着补概览的成员：补的请求在路上时来的事件先攒在这里，回来后一次补完。 */
const overviewPending = new Set<string>();
let overviewPatching = false;

/**
 * 只补这几个成员的概览，不重算全部：新建的补进来，补取时没返回的（彻底删除了）去掉。一次只发一个请求，连着来的事件自然合在一起。
 * 整个概览正在取时（第一次打开、重连、成员增删），那次取到的可能早于这个变化，就整个重取。
 */
export function patchMemberOverview(queryClient: QueryClient, memberIds: readonly string[]): void {
	const query = queryClient.getQueryCache().find({ queryKey: queryKeys.memberOverview, exact: true });
	if (!query) return;
	if (query.state.fetchStatus === 'fetching' || query.getObserversCount() === 0 || query.state.data === undefined) {
		void queryClient.invalidateQueries({ queryKey: queryKeys.memberOverview, exact: true });
		return;
	}
	for (const memberId of memberIds) overviewPending.add(memberId);
	if (!overviewPatching) void drainOverview(queryClient);
}

async function drainOverview(queryClient: QueryClient): Promise<void> {
	overviewPatching = true;
	try {
		while (overviewPending.size > 0) {
			const memberIds = [...overviewPending];
			overviewPending.clear();
			const { members } = await api<{ members: MemberOverview[] }>('GET', `/v1/member-overview?memberIds=${memberIds.map(encodeURIComponent).join(',')}`);
			queryClient.setQueryData<Map<string, MemberOverview>>(queryKeys.memberOverview, current => {
				if (!current) return current;
				const next = new Map(current);
				// 没返回的是彻底删除了。
				for (const memberId of memberIds) next.delete(memberId);
				for (const member of members) next.set(member.memberId, member);
				return next;
			});
		}
	} catch {
		// 补取失败时整个重取。
		overviewPending.clear();
		void queryClient.invalidateQueries({ queryKey: queryKeys.memberOverview, exact: true });
	} finally {
		overviewPatching = false;
	}
}

/** 成员页的分组，按先后排。 */
export function useMemberSections() {
	return useQuery({
		queryKey: queryKeys.memberSections,
		queryFn: async () => (await api<{ sections: IMemberSection[] }>('GET', '/v1/member-sections')).sections,
	});
}

export function useGroup(groupId: string | undefined) {
	return useQuery({
		queryKey: queryKeys.group(groupId ?? ''),
		queryFn: async () => (await api<{ group: IGroup }>('GET', `/v1/groups/${groupId}`)).group,
		enabled: groupId !== undefined,
	});
}

const SEARCH_PAGE_SIZE = 20;

/** 视角成员能看到的消息里包含所有关键词的，新的在前；往下翻用 fetchNextPage。 */
export function useMessageSearch(viewerMemberId: string, query: string) {
	return useInfiniteQuery({
		queryKey: queryKeys.messageSearch(viewerMemberId, query),
		queryFn: async ({ pageParam }) => {
			const before = pageParam === undefined ? '' : `&before=${pageParam}`;
			return (await api<{ messages: IMessage[] }>('GET', `/v1/members/${viewerMemberId}/messages/search?q=${encodeURIComponent(query)}&limit=${SEARCH_PAGE_SIZE}${before}`)).messages;
		},
		initialPageParam: undefined as number | undefined,
		getNextPageParam: page => page.length === SEARCH_PAGE_SIZE ? page.at(-1)!.messageId : undefined,
		enabled: query !== '',
		// 搜索结果每次重新搜。
		staleTime: 0,
		gcTime: 30_000,
	});
}

export function useConversations(memberId: string | undefined) {
	return useQuery({
		queryKey: queryKeys.conversations(memberId ?? ''),
		queryFn: async () => (await api<{ conversations: IConversationSummary[] }>('GET', `/v1/members/${memberId}/conversations`)).conversations,
		enabled: memberId !== undefined,
	});
}

/** 一个对话里已经加载的消息（按先后），以及更早、更新的还有没有。 */
interface IMessageWindow {
	readonly messages: readonly IMessage[];
	readonly hasOlder: boolean;
	/** 跳到某条消息后，后面还有没加载的。这时不和最新一页合并，往下滚用 loadNewer 接上。 */
	readonly hasNewer: boolean;
}

/** page 是 before、after 或 around 参数。 */
function messagesPath(viewerMemberId: string, target: ConversationTarget, page = ''): string {
	const id = target.kind === 'direct' ? target.memberId : target.groupId;
	return `/v1/members/${viewerMemberId}/conversations/${target.kind}/${id}/messages?limit=${PAGE_SIZE}${page}`;
}

/**
 * 对话的看法：atBottom 是停在底部跟着看最新的；不在底部时，detachedAfter 是离开底部时已加载的最后一条，之后新来的按 DETACHED_NEW_MESSAGES 限制。
 * 消息列表滚动时记下，列表关掉后留着。没有记过的按停在底部算。按查询的键记。
 */
const messageViews = new Map<string, { readonly atBottom: boolean; readonly detachedAfter: number }>();

function messageViewOf(id: string): { readonly atBottom: boolean; readonly detachedAfter: number } {
	return messageViews.get(id) ?? { atBottom: true, detachedAfter: 0 };
}

/** 消息列表记下自己在不在底部；离开底部时记下已加载的最后一条。回到底部时顺带去掉太早的。 */
export function setMessagesAtBottom(queryClient: QueryClient, viewerMemberId: string, target: ConversationTarget, atBottom: boolean): void {
	const key = queryKeys.messages(viewerMemberId, conversationKey(viewerMemberId, target));
	const id = key.join('|');
	const view = messageViewOf(id);
	if (atBottom && !view.atBottom) {
		messageViews.set(id, { atBottom: true, detachedAfter: 0 });
		const current = queryClient.getQueryData<IMessageWindow>(key);
		const next = current && trimmedMessages(current);
		if (next !== current) queryClient.setQueryData(key, next);
	} else if (!atBottom && view.atBottom) {
		messageViews.set(id, { atBottom: false, detachedAfter: queryClient.getQueryData<IMessageWindow>(key)?.messages.at(-1)?.messageId ?? 0 });
	}
}

/** 已加载的超过 TRIM_MESSAGES 条时只留最新的 KEEP_MESSAGES 条。 */
function trimmedMessages(window: IMessageWindow): IMessageWindow {
	return window.messages.length > TRIM_MESSAGES ? { ...window, messages: window.messages.slice(-KEEP_MESSAGES), hasOlder: true } : window;
}

/**
 * 对话的消息。每次刷新取最新的一页，和已加载的合并：接得上就合并，接不上（中间断了）就只留最新一页；在底部时去掉太早的。
 * 不在底部时，离开底部后新来的超过 DETACHED_NEW_MESSAGES 条或者接不上，就不合并，记成后面还有，往下滚时再接上。
 * 更早的消息用 loadOlder 往前翻。
 */
export function useMessages(viewerMemberId: string, target: ConversationTarget) {
	const queryClient = useQueryClient();
	const key = queryKeys.messages(viewerMemberId, conversationKey(viewerMemberId, target));
	const id = key.join('|');
	const query = useQuery({
		queryKey: key,
		queryFn: () => refreshMessages(queryClient, viewerMemberId, target),
	});
	const loadOlder = useCallback(() => loadOlderMessages(queryClient, key, viewerMemberId, target), [queryClient, id]);
	/** 往下接着取一页；接上的都看过了，离开底部的位置跟着往后挪。 */
	const loadNewer = useCallback(async () => {
		await loadNewerMessages(queryClient, key, viewerMemberId, target);
		if (!messageViewOf(id).atBottom) messageViews.set(id, { atBottom: false, detachedAfter: queryClient.getQueryData<IMessageWindow>(key)?.messages.at(-1)?.messageId ?? 0 });
	}, [queryClient, id]);
	const jumpTo = useCallback(async (messageId: number) => {
		const around = (await api<{ messages: IMessage[] }>('GET', messagesPath(viewerMemberId, target, `&around=${messageId}`))).messages;
		const index = around.findIndex(message => message.messageId === messageId);
		const before = Math.floor(PAGE_SIZE / 2);
		queryClient.setQueryData<IMessageWindow>(key, { messages: around, hasOlder: index === before, hasNewer: around.length - index === PAGE_SIZE - before });
	}, [queryClient, id]);
	/** 回到最新：只留最新一页。 */
	const backToLatest = useCallback(async () => {
		const latest = (await api<{ messages: IMessage[] }>('GET', messagesPath(viewerMemberId, target))).messages;
		queryClient.setQueryData<IMessageWindow>(key, { messages: latest, hasOlder: latest.length === PAGE_SIZE, hasNewer: false });
	}, [queryClient, id]);
	return { ...query, loadOlder, loadNewer, jumpTo, backToLatest };
}

/** 刷新对话的消息，见 useMessages。 */
export async function refreshMessages(queryClient: QueryClient, viewerMemberId: string, target: ConversationTarget): Promise<IMessageWindow> {
	const key = queryKeys.messages(viewerMemberId, conversationKey(viewerMemberId, target));
	// 正停在跳到的位置：新消息等往下滚时再接上。
	const current = queryClient.getQueryData<IMessageWindow>(key);
	if (current?.hasNewer) return current;
	const latest = (await api<{ messages: IMessage[] }>('GET', messagesPath(viewerMemberId, target))).messages;
	const existing = queryClient.getQueryData<IMessageWindow>(key);
	const fresh = { messages: latest, hasOlder: latest.length === PAGE_SIZE, hasNewer: false };
	if (!existing || existing.messages.length === 0 || latest.length === 0) return fresh;
	const view = messageViewOf(key.join('|'));
	// 最新一页是满的、而且全都比已加载的新：中间可能还有没取到的，接不上。
	const gap = latest.length === PAGE_SIZE && latest[0]!.messageId > existing.messages.at(-1)!.messageId;
	if (view.atBottom) return gap ? fresh : trimmedMessages({ messages: mergeMessages(existing.messages, latest), hasOlder: existing.hasOlder, hasNewer: false });
	const merged = gap ? [] : mergeMessages(existing.messages, latest);
	if (gap || merged.filter(message => message.messageId > view.detachedAfter).length > DETACHED_NEW_MESSAGES) return { ...existing, hasNewer: true };
	return { messages: merged, hasOlder: existing.hasOlder, hasNewer: false };
}

async function loadOlderMessages(queryClient: QueryClient, key: readonly unknown[], viewerMemberId: string, target: ConversationTarget): Promise<void> {
	const existing = queryClient.getQueryData<IMessageWindow>(key);
	if (!existing?.hasOlder || existing.messages.length === 0) return;
	const older = (await api<{ messages: IMessage[] }>('GET', messagesPath(viewerMemberId, target, `&before=${existing.messages[0]!.messageId}`))).messages;
	queryClient.setQueryData<IMessageWindow>(key, current => current && {
		...current,
		messages: mergeMessages(current.messages, older),
		hasOlder: older.length === PAGE_SIZE,
	});
}

async function loadNewerMessages(queryClient: QueryClient, key: readonly unknown[], viewerMemberId: string, target: ConversationTarget): Promise<void> {
	const existing = queryClient.getQueryData<IMessageWindow>(key);
	if (!existing?.hasNewer || existing.messages.length === 0) return;
	const newer = (await api<{ messages: IMessage[] }>('GET', messagesPath(viewerMemberId, target, `&after=${existing.messages.at(-1)!.messageId}`))).messages;
	queryClient.setQueryData<IMessageWindow>(key, current => current && {
		...current,
		messages: mergeMessages(current.messages, newer),
		hasNewer: newer.length === PAGE_SIZE,
	});
}

/** 合并两段消息。消息发出后不会再变，同一条沿用 left 里已有的对象，已经显示的消息就不重画。 */
function mergeMessages(left: readonly IMessage[], right: readonly IMessage[]): IMessage[] {
	const byId = new Map<number, IMessage>();
	for (const message of [...left, ...right]) {
		if (!byId.has(message.messageId)) byId.set(message.messageId, message);
	}
	return [...byId.values()].sort((a, b) => a.messageId - b.messageId);
}
