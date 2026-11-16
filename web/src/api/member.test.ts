import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { queryKeys } from './keys.ts';
import { flushDeltas, patchTimeline, queueDelta, setTimelineFollowing, useStreams } from './member.ts';
import type { IMemberActivity, IRunDeltaEvent } from './types.ts';

function delta(requestId: number, attempt: number, kind: IRunDeltaEvent['kind'], text: string): IRunDeltaEvent {
	return { type: 'run.delta', memberId: 'M_A', runId: 1, requestId, attempt, kind, delta: text };
}

test('流式内容：攒着一起写；同一个请求重试了从头接，整理上下文的标记照旧；换了请求重新开始', () => {
	const optimizing = { phase: 'optimizing', since: 100 } as IMemberActivity;
	queueDelta(delta(7, 1, 'reasoning', '先看'), optimizing);
	queueDelta(delta(7, 1, 'reasoning', '旧内容'), optimizing);
	queueDelta(delta(7, 2, 'reasoning', '重来'), undefined);
	assert.equal(useStreams.getState().streams['M_A'], undefined);
	flushDeltas();
	assert.deepEqual(useStreams.getState().streams['M_A'], { runId: 1, requestId: 7, attempt: 2, reasoning: '重来', text: '', optimizingSince: 100 });

	queueDelta(delta(8, 1, 'text', '好'), undefined);
	flushDeltas();
	assert.deepEqual(useStreams.getState().streams['M_A'], { runId: 1, requestId: 8, attempt: 1, reasoning: '', text: '好', optimizingSince: null });
});

test('时间线补取：新增的只取最后一条之后的；改动的换掉那一段，已加载以前的不管；没人看时只标记失效', async t => {
	const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
	const key = queryKeys.timeline('M_A');
	let server = [1, 2, 3, 4, 5, 6, 7, 8].map(itemId => ({ itemId, version: 1 }));
	const requests: string[] = [];
	t.mock.method(globalThis, 'fetch', async (path: string) => {
		const url = new URL(path, 'http://runtime');
		requests.push(url.search);
		const after = Number(url.searchParams.get('after'));
		const limit = Number(url.searchParams.get('limit'));
		return new Response(JSON.stringify({ items: server.filter(item => item.itemId > after).slice(0, limit) }));
	});
	queryClient.setQueryData(key, { items: server.slice(2, 6), hasOlder: true, hasNewer: false });
	const observer = new QueryObserver(queryClient, { queryKey: key, enabled: false });
	const unsubscribe = observer.subscribe(() => {});
	const loaded = () => (queryClient.getQueryData(key) as { items: { itemId: number; version: number }[] }).items;

	await patchTimeline(queryClient, 'M_A');
	assert.deepEqual(requests, ['?after=6&limit=500']);
	assert.deepEqual(loaded().map(item => item.itemId), [3, 4, 5, 6, 7, 8]);

	server = server.map(item => [1, 4, 5].includes(item.itemId) ? { ...item, version: 2 } : item);
	const seventh = loaded()[4];
	requests.length = 0;
	await patchTimeline(queryClient, 'M_A', [1, 4, 5]);
	assert.deepEqual(requests, ['?after=3&limit=500']);
	assert.deepEqual(loaded().map(item => `${item.itemId}.${item.version}`), ['3.1', '4.2', '5.2', '6.1', '7.1', '8.1']);
	assert.equal(loaded()[4], seventh);

	requests.length = 0;
	await patchTimeline(queryClient, 'M_A', [1, 2]);
	assert.deepEqual(requests, []);

	unsubscribe();
	await patchTimeline(queryClient, 'M_A');
	assert.deepEqual(requests, []);
	assert.equal(queryClient.getQueryState(key)?.isInvalidated, true);
});

test('时间线开久了：停在底部时超过 45 次运行只留最新的 30 次；翻着历史时新来的最多接上 500 条，再多记成后面还有', async t => {
	const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
	const key = queryKeys.timeline('M_B');
	// 每次运行两条，运行 r 的条目是 2r-1、2r。
	let server = Array.from({ length: 100 }, (_, index) => ({ itemId: index + 1, runId: Math.floor(index / 2) + 1 }));
	const requests: string[] = [];
	t.mock.method(globalThis, 'fetch', async (path: string) => {
		const url = new URL(path, 'http://runtime');
		requests.push(url.search);
		const after = Number(url.searchParams.get('after'));
		const limit = Number(url.searchParams.get('limit'));
		return new Response(JSON.stringify({ items: server.filter(item => item.itemId > after).slice(0, limit) }));
	});
	queryClient.setQueryData(key, { items: server, hasOlder: false, hasNewer: false });
	const observer = new QueryObserver(queryClient, { queryKey: key, enabled: false });
	t.after(observer.subscribe(() => {}));
	const window = () => queryClient.getQueryData(key) as { items: { itemId: number }[]; hasOlder: boolean; hasNewer: boolean };

	// 第 51 次运行：留下第 22 到 51 次运行。
	server = [...server, { itemId: 101, runId: 51 }, { itemId: 102, runId: 51 }];
	await patchTimeline(queryClient, 'M_B');
	assert.deepEqual([window().items.length, window().items[0]!.itemId, window().hasOlder], [60, 43, true]);

	// 翻着历史：新来 600 条，只接上 500 条，之后不再取。
	setTimelineFollowing(queryClient, 'M_B', false);
	server = [...server, ...Array.from({ length: 600 }, (_, index) => ({ itemId: 103 + index, runId: 52 + index }))];
	await patchTimeline(queryClient, 'M_B');
	assert.deepEqual([window().items.length, window().items.at(-1)!.itemId, window().hasNewer], [560, 602, true]);
	requests.length = 0;
	await patchTimeline(queryClient, 'M_B');
	assert.deepEqual(requests, []);
});

test('时间线补取：前一次还在取时，接着来的几条事件并成一次，改动的和新增的一起补', async t => {
	const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
	const key = queryKeys.timeline('M_C');
	let server = [1, 2, 3, 4, 5, 6].map(itemId => ({ itemId, version: 1 }));
	const requests: string[] = [];
	let release!: () => void;
	const gate = new Promise<void>(resolve => release = resolve);
	t.mock.method(globalThis, 'fetch', async (path: string) => {
		const url = new URL(path, 'http://runtime');
		requests.push(url.search);
		const after = Number(url.searchParams.get('after'));
		const limit = Number(url.searchParams.get('limit'));
		const items = server.filter(item => item.itemId > after).slice(0, limit);
		if (requests.length === 1) await gate;
		return new Response(JSON.stringify({ items }));
	});
	queryClient.setQueryData(key, { items: server.slice(0, 4), hasOlder: false, hasNewer: false });
	const observer = new QueryObserver(queryClient, { queryKey: key, enabled: false });
	t.after(observer.subscribe(() => {}));
	const loaded = () => (queryClient.getQueryData(key) as { items: { itemId: number; version: number }[] }).items;

	const first = patchTimeline(queryClient, 'M_C');
	while (requests.length === 0) await new Promise(resolve => setImmediate(resolve));
	// 第一次正在取 5、6：这时新增了 7、改了 2，来了三条事件。
	server = [...server.map(item => item.itemId === 2 ? { ...item, version: 2 } : item), { itemId: 7, version: 1 }];
	const later = [patchTimeline(queryClient, 'M_C'), patchTimeline(queryClient, 'M_C', [2]), patchTimeline(queryClient, 'M_C')];
	assert.ok(later.every(promise => promise === later[0]));
	release();
	await Promise.all([first, ...later]);
	assert.deepEqual(requests, ['?after=4&limit=500', '?after=1&limit=500', '?after=6&limit=500']);
	assert.deepEqual(loaded().map(item => `${item.itemId}.${item.version}`), ['1.1', '2.2', '3.1', '4.1', '5.1', '6.1', '7.1']);
});
