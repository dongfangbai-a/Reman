import { type QueryClient, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { create } from 'zustand';
import { api, ApiError } from './client.ts';
import { queryKeys } from './keys.ts';
import type { IApproval, ICodeCall, IContextUsageInfo, IMemberActivity, IMemberState, IPlan, IRun, IRunDeltaEvent, ITask, TimelineEntry } from './types.ts';

const TIMELINE_PAGE = 100;
/** 刷新时一次往后取多少条。 */
const REFRESH_CHUNK = 500;

export function useMemberStates() {
	return useQuery({
		queryKey: queryKeys.memberStates,
		queryFn: async () => new Map((await api<{ states: IMemberState[] }>('GET', '/v1/member-states')).states.map(state => [state.memberId, state])),
	});
}

export function useRuns(memberId: string) {
	return useQuery({
		queryKey: queryKeys.runs(memberId),
		queryFn: async () => (await api<{ runs: IRun[] }>('GET', `/v1/members/${memberId}/runs?limit=200`)).runs,
	});
}

export function useTasks(memberId: string) {
	return useQuery({
		queryKey: queryKeys.tasks(memberId),
		queryFn: async () => (await api<{ tasks: ITask[] }>('GET', `/v1/members/${memberId}/tasks`)).tasks,
	});
}

/** 成员现在的计划。成员更新计划、压缩后放回计划时运行时发 plan.changed，事件流让它失效。 */
export function usePlan(memberId: string) {
	return useQuery({
		queryKey: queryKeys.plan(memberId),
		queryFn: async () => await api<IPlan>('GET', `/v1/members/${memberId}/plan`),
	});
}

/**
 * 执行中的 shell 调用到目前为止的输出；调用已经结束时是 null（结果从时间线或后台任务里取）。
 * 有新输出时运行时发 call.output，事件流让它失效：只有正在显示的会重新取，没人看时不取。
 */
export function useCallOutput(runId: number, callId: string, enabled: boolean) {
	return useQuery({
		queryKey: queryKeys.callOutput(runId, callId),
		queryFn: async () => {
			try {
				return (await api<{ output: string }>('GET', `/v1/runs/${runId}/calls/${encodeURIComponent(callId)}/output`)).output;
			} catch (error) {
				if (error instanceof ApiError && error.status === 404) return null;
				throw error;
			}
		},
		enabled,
		staleTime: Infinity,
	});
}

/** 成员的上下文用量，以及现在能不能手动压缩。 */
export function useContextUsage(memberId: string, enabled: boolean) {
	return useQuery({
		queryKey: queryKeys.contextUsage(memberId),
		queryFn: async () => (await api<{ context: IContextUsageInfo }>('GET', `/v1/members/${memberId}/context`)).context,
		enabled,
	});
}

/** 所有成员的待审批。 */
export function usePendingApprovals() {
	return useQuery({
		queryKey: queryKeys.approvals,
		queryFn: async () => (await api<{ approvals: IApproval[] }>('GET', '/v1/approvals')).approvals,
	});
}

export function useCodeCalls(memberId: string, runId: number, callId: string, enabled: boolean) {
	return useQuery({
		queryKey: queryKeys.codeCalls(memberId, runId, callId),
		queryFn: async () => (await api<{ codeCalls: ICodeCall[] }>('GET', `/v1/runs/${runId}/calls/${encodeURIComponent(callId)}/code-calls`)).codeCalls,
		enabled,
	});
}

interface ITimelineWindow {
	readonly items: readonly TimelineEntry[];
	readonly hasOlder: boolean;
	/** 往上翻着看历史时后面新来的太多，没有接着取：往下滚到末尾时用 loadNewer 接上。 */
	readonly hasNewer: boolean;
}

/** 停在底部时，已加载的超过这么多次运行就去掉最早的，留最新的 KEEP_RUNS 次：按运行数，不按条数，一次运行折叠起来只占几行，却可能有上百条。 */
const TRIM_RUNS = 45;
const KEEP_RUNS = 30;
/** 离开底部后新来的，接在后面的最多这么多条；再多就记成后面还有。 */
const DETACHED_NEW_ITEMS = 500;

/**
 * 时间线的看法：following 是停在底部跟着看最新的；不跟着时，detachedAfter 是离开底部时已加载的最后一条，之后新来的按 DETACHED_NEW_ITEMS 限制。
 * 时间线视图滚动时记下，视图关掉后留着，回来时按离开时的样子重取。没有记过的按停在底部算。
 */
const views = new Map<string, { readonly following: boolean; readonly detachedAfter: number }>();

function viewOf(memberId: string): { readonly following: boolean; readonly detachedAfter: number } {
	return views.get(memberId) ?? { following: true, detachedAfter: 0 };
}

/** 时间线视图记下自己跟不跟着底部；从跟着变成不跟着时记下已加载的最后一条。跟着时顺带去掉太早的。 */
export function setTimelineFollowing(queryClient: QueryClient, memberId: string, following: boolean): void {
	const view = viewOf(memberId);
	if (following && !view.following) {
		views.set(memberId, { following: true, detachedAfter: 0 });
		const key = queryKeys.timeline(memberId);
		const current = queryClient.getQueryData<ITimelineWindow>(key);
		const next = current && trimmed(current);
		if (next !== current) queryClient.setQueryData(key, next);
	} else if (!following && view.following) {
		const last = queryClient.getQueryData<ITimelineWindow>(queryKeys.timeline(memberId))?.items.at(-1)?.itemId ?? 0;
		views.set(memberId, { following: false, detachedAfter: last });
	}
}

/**
 * 成员的时间线：先取最新一页，更早的用 loadOlder 往前翻。
 * 有新增、改动时由事件流调 patchTimeline 只补取变了的一段；整个失效时（重连、没在看时有了变化）重取：
 * 停在底部的只取最新一页，翻着历史的从已加载的最早一条往后取，离开底部后新来的按 DETACHED_NEW_ITEMS 限制。
 */
export function useTimeline(memberId: string) {
	const queryClient = useQueryClient();
	const key = queryKeys.timeline(memberId);
	const query = useQuery({
		queryKey: key,
		queryFn: async (): Promise<ITimelineWindow> => {
			const existing = queryClient.getQueryData<ITimelineWindow>(key);
			const view = viewOf(memberId);
			if (!existing || existing.items.length === 0 || view.following) return await latestTimeline(memberId);
			const loaded = (await fetchAfter(memberId, existing.items[0]!.itemId - 1, existing.items.at(-1)!.itemId)).items;
			if (existing.hasNewer) return { items: loaded, hasOlder: existing.hasOlder, hasNewer: true };
			const newer = await fetchAfter(memberId, existing.items.at(-1)!.itemId, Infinity, allowance(loaded, view.detachedAfter));
			return { items: [...loaded, ...newer.items], hasOlder: existing.hasOlder, hasNewer: newer.more };
		},
		// 切走再回来时要停在原来看到的位置，已加载的部分多留一会儿。
		gcTime: 30 * 60 * 1000,
	});
	const loadOlder = useCallback(async () => {
		const existing = queryClient.getQueryData<ITimelineWindow>(key);
		if (!existing?.hasOlder || existing.items.length === 0) return;
		const older = await fetchTimeline(memberId, `before=${existing.items[0]!.itemId}&limit=${TIMELINE_PAGE}`);
		queryClient.setQueryData<ITimelineWindow>(key, current => current && { ...current, items: [...older, ...current.items], hasOlder: older.length === TIMELINE_PAGE });
	}, [queryClient, memberId]);
	/** 往下接着取一页；接上的都看过了，离开底部的位置跟着往后挪。 */
	const loadNewer = useCallback(async () => {
		const existing = queryClient.getQueryData<ITimelineWindow>(key);
		if (!existing?.hasNewer || existing.items.length === 0) return;
		const last = existing.items.at(-1)!.itemId;
		const newer = await fetchTimeline(memberId, `after=${last}&limit=${TIMELINE_PAGE}`);
		const window = queryClient.setQueryData<ITimelineWindow>(key, current => current && {
			...current, items: [...current.items.filter(item => item.itemId <= last), ...newer], hasNewer: newer.length === TIMELINE_PAGE,
		});
		const view = viewOf(memberId);
		if (!view.following && window) views.set(memberId, { following: false, detachedAfter: window.items.at(-1)?.itemId ?? 0 });
	}, [queryClient, memberId]);
	/** 回到最新：和第一次打开一样只取最新一页。 */
	const backToLatest = useCallback(async () => {
		queryClient.setQueryData<ITimelineWindow>(key, await latestTimeline(memberId));
	}, [queryClient, memberId]);
	return { ...query, loadOlder, loadNewer, backToLatest };
}

async function latestTimeline(memberId: string): Promise<ITimelineWindow> {
	const items = await fetchTimeline(memberId, `before=${Number.MAX_SAFE_INTEGER}&limit=${TIMELINE_PAGE}`);
	return { items, hasOlder: items.length === TIMELINE_PAGE, hasNewer: false };
}

/** 离开底部后还能接上多少条新来的。 */
function allowance(items: readonly TimelineEntry[], detachedAfter: number): number {
	return Math.max(0, DETACHED_NEW_ITEMS - items.filter(item => item.itemId > detachedAfter).length);
}

/**
 * 已加载的超过 TRIM_RUNS 次运行时，只留最新的 KEEP_RUNS 次：切在第 KEEP_RUNS + 1 次运行的最后一条之后，夹在两次运行之间的收到的内容跟着后面那次运行。
 * 只有工具调用、模型输出带运行编号。
 */
function trimmed(window: ITimelineWindow): ITimelineWindow {
	const runs = new Set<number>();
	let cut = 0;
	for (let index = window.items.length - 1; index >= 0; index--) {
		const item = window.items[index]!;
		if (!('runId' in item) || runs.has(item.runId)) continue;
		if (runs.size === KEEP_RUNS) cut = index + 1;
		runs.add(item.runId);
		if (runs.size > TRIM_RUNS) return { ...window, items: window.items.slice(cut), hasOlder: true };
	}
	return window;
}

/** 同一个成员的补取排队执行，后一次按前一次补完的样子算从哪里取。 */
const patching = new Map<string, Promise<void>>();

/**
 * 排着、还没开始的那次补取。后来的事件并进它，不再另排：它开始时按当时最新的样子取，排着期间新增、改动的都取得到。
 * 原来每条事件排一次，一下子来几条时，第一次就取完了，后面几次都是空取。
 */
interface IQueuedPatch {
	readonly changed: Set<number>;
	appended: boolean;
	done?: Promise<void>;
}
const queuedPatches = new Map<string, IQueuedPatch>();

/**
 * 时间线有新增或改动后只补取变了的一段，不再从已加载的最早一条全部重取（往上翻了很多页以后，运行中每来一条都要重取几百上千条）。
 * changed 是改动了的条目：从其中最早的一条取到最晚的一条，换掉已加载的这一段，已加载范围以前的不管；不给时取最后一条之后新增的。
 * 没人在看的时间线只标记失效，下次打开时整个重取。
 */
export function patchTimeline(queryClient: QueryClient, memberId: string, changed?: readonly number[]): Promise<void> {
	const key = queryKeys.timeline(memberId);
	const query = queryClient.getQueryCache().find({ queryKey: key, exact: true });
	if (!query) return Promise.resolve();
	if (query.getObserversCount() === 0) return queryClient.invalidateQueries({ queryKey: key, exact: true });
	const appended = !changed || changed.length === 0;
	const queued = queuedPatches.get(memberId);
	if (queued) {
		for (const itemId of changed ?? []) queued.changed.add(itemId);
		queued.appended ||= appended;
		return queued.done!;
	}
	const patch: IQueuedPatch = { changed: new Set(changed), appended };
	queuedPatches.set(memberId, patch);
	const next = (patching.get(memberId) ?? Promise.resolve())
		.then(() => {
			// 开始了：之后来的事件另排一次。
			if (queuedPatches.get(memberId) === patch) queuedPatches.delete(memberId);
			return patchOnce(queryClient, memberId, [...patch.changed], patch.appended);
		})
		// 补取失败时整个重取。
		.catch(() => queryClient.invalidateQueries({ queryKey: key, exact: true }));
	patch.done = next;
	patching.set(memberId, next);
	void next.finally(() => {
		if (patching.get(memberId) === next) patching.delete(memberId);
	});
	return next;
}

/** changed 是改动了的条目，appended 是有新增的。 */
async function patchOnce(queryClient: QueryClient, memberId: string, changed: readonly number[], appended: boolean): Promise<void> {
	const key = queryKeys.timeline(memberId);
	// 正在整个取（第一次打开、重连）时先等它取完，再按它的结果补，免得晚到的整段盖掉补上的。
	if (queryClient.getQueryCache().find({ queryKey: key, exact: true })?.state.fetchStatus === 'fetching') {
		await queryClient.refetchQueries({ queryKey: key, exact: true }, { cancelRefetch: false });
	}
	const existing = queryClient.getQueryData<ITimelineWindow>(key);
	if (!existing) return;
	if (existing.items.length === 0) {
		await queryClient.invalidateQueries({ queryKey: key, exact: true });
		return;
	}
	const first = existing.items[0]!.itemId;
	const last = existing.items.at(-1)!.itemId;
	if (changed.length > 0) {
		// 已加载范围里改动的：从最早一条取到最晚一条，换掉这一段。已加载范围以前的不管。
		const loaded = changed.filter(itemId => itemId >= first && itemId <= last);
		if (loaded.length > 0) {
			const after = Math.min(...loaded) - 1;
			const until = Math.max(...loaded);
			const fetched = await fetchAfter(memberId, after, until);
			queryClient.setQueryData<ITimelineWindow>(key, current => current && {
				...current,
				items: [...current.items.filter(item => item.itemId <= after), ...fetched.items, ...current.items.filter(item => item.itemId > until)],
			});
		}
		// 改动的条目还没加载到（一般不会：新增的事件在前），连同新增的一起取。
		if (!appended && !changed.some(itemId => itemId > last)) return;
	}
	// 新增的：停在底部的取最后一条之后的全部，再去掉太早的；翻着历史的按 DETACHED_NEW_ITEMS 限制，再多就记成后面还有。
	const current = queryClient.getQueryData<ITimelineWindow>(key);
	if (!current || current.hasNewer || current.items.length === 0) return;
	const end = current.items.at(-1)!.itemId;
	const view = viewOf(memberId);
	const fetched = await fetchAfter(memberId, end, Infinity, view.following ? Infinity : allowance(current.items, view.detachedAfter));
	queryClient.setQueryData<ITimelineWindow>(key, window => {
		if (!window) return window;
		const next = { ...window, items: [...window.items.filter(item => item.itemId <= end), ...fetched.items], hasNewer: fetched.more };
		return viewOf(memberId).following ? trimmed(next) : next;
	});
}

/** 取 after 之后的条目，取到 until 那一条（含）为止，最多 max 条；until 是 Infinity 时取到最后。more 是因为 max 没取完。 */
async function fetchAfter(memberId: string, after: number, until: number, max = Infinity): Promise<{ items: TimelineEntry[]; more: boolean }> {
	const items: TimelineEntry[] = [];
	while (items.length < max) {
		const limit = Math.min(REFRESH_CHUNK, max - items.length);
		const chunk = await fetchTimeline(memberId, `after=${after}&limit=${limit}`);
		items.push(...chunk);
		if (chunk.length < limit || chunk.at(-1)!.itemId >= until) {
			return { items: until === Infinity ? items : items.filter(item => item.itemId <= until), more: false };
		}
		after = chunk.at(-1)!.itemId;
	}
	// 取满了 max 条：后面还有没有，再看一条。
	const more = (await fetchTimeline(memberId, `after=${after}&limit=1`)).length > 0;
	return { items: until === Infinity ? items : items.filter(item => item.itemId <= until), more: until === Infinity && more };
}

async function fetchTimeline(memberId: string, query: string): Promise<TimelineEntry[]> {
	return (await api<{ items: TimelineEntry[] }>('GET', `/v1/members/${memberId}/timeline?${query}`)).items;
}

/**
 * 正在生成的思考和文字。这次请求的输出进入时间线后，时间线视图不再显示它。
 * 压缩请求只有思考：optimizingSince 是收到第一段时成员这一步（整理上下文的这次请求）开始的时间，别的请求是 null。
 */
export interface IStream {
	readonly runId: number;
	readonly requestId: number;
	/** 这次请求的第几次尝试：自动重试时模型从头输出，换了就从头接。 */
	readonly attempt: number;
	readonly reasoning: string;
	readonly text: string;
	readonly optimizingSince: number | null;
}

export const useStreams = create<{ streams: Record<string, IStream> }>(() => ({ streams: {} }));

/**
 * 某次请求正在生成的思考或文字；不是这次请求的时是空的。
 * 只让显示它的组件跟着增量更新：时间线别的部分不订阅内容，已加载多少条都不影响每段增量的耗时。
 */
export function useStreamText(memberId: string, requestId: number | undefined, kind: IRunDeltaEvent['kind']): string {
	return useStreams(store => {
		const stream = store.streams[memberId];
		return stream && stream.requestId === requestId ? stream[kind] : '';
	});
}

/** 收到的增量攒这么久写一次：模型差不多一个词一段，每段都重画的话正文长了（每次整段重新解析 Markdown）会占满主线程。 */
const DELTA_FLUSH_MS = 50;
let pendingDeltas: { readonly event: IRunDeltaEvent; readonly activity: IMemberActivity | null | undefined }[] = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * 攒下一段增量，约 50 毫秒后和同期的一起写进去。activity 是收到这一段时成员在做的事：在整理上下文时，这是压缩请求的思考。
 * 处理别的事件前先 flushDeltas，先后不乱。
 */
export function queueDelta(event: IRunDeltaEvent, activity: IMemberActivity | null | undefined): void {
	pendingDeltas.push({ event, activity });
	flushTimer ??= setTimeout(flushDeltas, DELTA_FLUSH_MS);
}

/**
 * 把攒着的增量一次写进去。同一个请求重试了（attempt 变了）时从头接，已经收到的不要；整理上下文的那次请求不变，optimizingSince 照旧。
 */
export function flushDeltas(): void {
	clearTimeout(flushTimer);
	flushTimer = undefined;
	if (pendingDeltas.length === 0) return;
	const batch = pendingDeltas;
	pendingDeltas = [];
	useStreams.setState(state => {
		const streams = { ...state.streams };
		for (const { event, activity } of batch) {
			const current = streams[event.memberId];
			const stream = current?.requestId === event.requestId
				? current.attempt === event.attempt ? current : { ...current, attempt: event.attempt, reasoning: '', text: '' }
				: {
					runId: event.runId, requestId: event.requestId, attempt: event.attempt, reasoning: '', text: '',
					optimizingSince: activity?.phase === 'optimizing' ? activity.since : null,
				};
			streams[event.memberId] = event.kind === 'text' ? { ...stream, text: stream.text + event.delta } : { ...stream, reasoning: stream.reasoning + event.delta };
		}
		return { streams };
	});
}

/** 重连时清掉全部流式内容，攒着还没写的也不要：运行时连上时会先发一遍到目前为止的全部。 */
export function clearStreams(): void {
	clearTimeout(flushTimer);
	flushTimer = undefined;
	pendingDeltas = [];
	useStreams.setState({ streams: {} });
}

/** 运行结束后清掉它的流式内容。 */
export function clearStream(memberId: string, runId: number): void {
	useStreams.setState(state => {
		if (state.streams[memberId]?.runId !== runId) return state;
		const { [memberId]: _, ...rest } = state.streams;
		return { streams: rest };
	});
}
