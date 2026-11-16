import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { conversationKey, queryKeys } from './keys.ts';
import { patchMemberOverview, refreshMessages, setMessagesAtBottom } from './queries.ts';
import type { ConversationTarget } from './types.ts';

test('对话开久了：在底部时超过 150 条只留最新的 100 条；不在底部时新来的超过 50 条就不合并，记成后面还有', async t => {
	const queryClient = new QueryClient();
	const target: ConversationTarget = { kind: 'group', groupId: 'G_A' };
	const key = queryKeys.messages('M_A', conversationKey('M_A', target));
	let server = Array.from({ length: 140 }, (_, index) => ({ messageId: index + 1 }));
	// 只取最新一页：最后 50 条。
	t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ messages: server.slice(-50) })));
	const window = () => queryClient.getQueryData(key) as { messages: { messageId: number }[]; hasOlder: boolean; hasNewer: boolean };
	queryClient.setQueryData(key, { messages: server, hasOlder: false, hasNewer: false });

	server = [...server, ...Array.from({ length: 20 }, (_, index) => ({ messageId: 141 + index }))];
	queryClient.setQueryData(key, await refreshMessages(queryClient, 'M_A', target));
	assert.deepEqual([window().messages.length, window().messages[0]!.messageId, window().hasOlder], [100, 61, true]);

	setMessagesAtBottom(queryClient, 'M_A', target, false);
	server = [...server, ...Array.from({ length: 30 }, (_, index) => ({ messageId: 161 + index }))];
	queryClient.setQueryData(key, await refreshMessages(queryClient, 'M_A', target));
	assert.deepEqual([window().messages.length, window().hasNewer], [130, false]);
	server = [...server, ...Array.from({ length: 30 }, (_, index) => ({ messageId: 191 + index }))];
	queryClient.setQueryData(key, await refreshMessages(queryClient, 'M_A', target));
	assert.deepEqual([window().messages.length, window().messages.at(-1)!.messageId, window().hasNewer], [130, 190, true]);
});

test('刷新消息：已加载的同一条沿用原来的对象，已经显示的不重画', async t => {
	const queryClient = new QueryClient();
	const target: ConversationTarget = { kind: 'group', groupId: 'G_B' };
	const loaded = [1, 2, 3].map(messageId => ({ messageId }));
	queryClient.setQueryData(queryKeys.messages('M_A', conversationKey('M_A', target)), { messages: loaded, hasOlder: false, hasNewer: false });
	t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ messages: [1, 2, 3, 4].map(messageId => ({ messageId })) })));

	const { messages } = await refreshMessages(queryClient, 'M_A', target);
	assert.deepEqual(messages.map(message => message.messageId), [1, 2, 3, 4]);
	assert.ok(loaded.every((message, index) => messages[index] === message));
});

test('概览补取：新建的补进来，没返回的（彻底删除了）去掉，别的不动', async t => {
	const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
	queryClient.setQueryData(queryKeys.memberOverview, new Map([['M_A', { memberId: 'M_A' }], ['M_B', { memberId: 'M_B' }]]));
	const unsubscribe = new QueryObserver(queryClient, { queryKey: queryKeys.memberOverview, enabled: false }).subscribe(() => {});
	const requests: string[] = [];
	t.mock.method(globalThis, 'fetch', async (path: string) => {
		requests.push(path);
		return new Response(JSON.stringify({ members: [{ memberId: 'M_C' }] }));
	});

	patchMemberOverview(queryClient, ['M_B', 'M_C']);
	await new Promise(resolve => setTimeout(resolve, 20));
	assert.deepEqual(requests, ['/v1/member-overview?memberIds=M_B,M_C']);
	assert.deepEqual([...queryClient.getQueryData<Map<string, unknown>>(queryKeys.memberOverview)!.keys()], ['M_A', 'M_C']);
	unsubscribe();
});
