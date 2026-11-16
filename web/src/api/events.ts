import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { create } from 'zustand';
import { queryKeys, refKey } from './keys.ts';
import { clearStream, clearStreams, flushDeltas, patchTimeline, queueDelta, useStreams } from './member.ts';
import { patchMemberOverview } from './queries.ts';
import { applyPortableGitProgress, emitTerminalOutput } from './system.ts';
import type { ICallOutputEvent, IMemberActivityEvent, IMemberState, IPortableGitProgressEvent, IRun, IRunDeltaEvent, ITerminalOutputEvent, RuntimeEvent } from './types.ts';

type MessageCreatedEvent = Extract<RuntimeEvent, { type: 'message.created' }>;
const messageListeners = new Set<(event: MessageCreatedEvent) => void>();

/** 收听新消息事件（消息通知用）。返回取消收听的函数。 */
export function onMessageCreated(listener: (event: MessageCreatedEvent) => void): () => void {
	messageListeners.add(listener);
	return () => messageListeners.delete(listener);
}

/** 和运行时事件流的连接状态。 */
export const useConnection = create<{ connected: boolean }>(() => ({ connected: true }));

const RECONNECT_MS = 3000;

/**
 * 订阅运行时的事件流，按事件让对应的查询失效。断开后自动重连，运行时从最后收到的事件接着补发；
 * 运行时重启过（epoch 变了）或补不回来时，运行时发 resync，这时才全部重新拉取。
 * 增量不补发，重连时另外处理：成员在做的事和流式输出，运行时连上时先发一遍现在的（流式输出是到目前为止的全部），所以先清掉已有的流式内容再接；
 * 下载进度、执行中命令的输出重新取（见 reconnected）；终端画面自己看连接状态，重连后重新取快照。
 */
export function subscribeEvents(queryClient: QueryClient): () => void {
	let lastEventId = '';
	let source: EventSource | undefined;
	let timer: number | undefined;
	let closed = false;

	const open = () => {
		source = new EventSource(lastEventId ? `/v1/events?after=${encodeURIComponent(lastEventId)}` : '/v1/events');
		source.onopen = () => {
			if (!useConnection.getState().connected) {
				useConnection.setState({ connected: true });
				reconnected(queryClient, lastEventId !== '');
			}
		};
		source.onerror = () => {
			useConnection.setState({ connected: false });
			// 浏览器自己重连时 readyState 是 CONNECTING；被拒绝（比如运行时没在运行）时会关掉，由这里重连。
			if (source?.readyState === EventSource.CLOSED && !closed) {
				source.close();
				timer = window.setTimeout(open, RECONNECT_MS);
			}
		};
		source.addEventListener('resync', () => void queryClient.invalidateQueries());
		source.addEventListener('run.delta', message => {
			const event = JSON.parse(message.data) as IRunDeltaEvent;
			queueDelta(event, queryClient.getQueryData<Map<string, IMemberState>>(queryKeys.memberStates)?.get(event.memberId)?.activity);
		});
		source.addEventListener('member.activity', message => {
			flushDeltas();
			applyActivity(queryClient, JSON.parse(message.data) as IMemberActivityEvent);
		});
		source.addEventListener('portableGit.progress', message => applyPortableGitProgress(queryClient, JSON.parse(message.data) as IPortableGitProgressEvent));
		source.addEventListener('terminal.output', message => emitTerminalOutput(JSON.parse(message.data) as ITerminalOutputEvent));
		// 执行中的输出有更新：只让它失效，正在显示的才会重新取。
		source.addEventListener('call.output', message => {
			const event = JSON.parse(message.data) as ICallOutputEvent;
			void queryClient.invalidateQueries({ queryKey: queryKeys.callOutput(event.runId, event.callId) });
		});
		for (const type of Object.keys(HANDLERS)) {
			source.addEventListener(type, message => {
				if (message.lastEventId) lastEventId = message.lastEventId;
				// 攒着的流式增量在这个事件之前收到，先写进去：比如运行结束时要看有没有这次运行的流式内容。
				flushDeltas();
				const event = JSON.parse(message.data) as RuntimeEvent;
				(HANDLERS[event.type] as (queryClient: QueryClient, event: RuntimeEvent) => void)(queryClient, event);
			});
		}
	};
	open();
	return () => {
		closed = true;
		window.clearTimeout(timer);
		source?.close();
	};
}

/**
 * 重连上了：有编号的事件运行时会补发，不用重新拉取；只处理只靠增量推送、断开期间补不回来的。
 * 流式内容清掉，运行时连上时会先发一遍到目前为止的全部；下载进度、执行中命令的输出重新取。
 * resumed 是重连时说了收到哪里：还没收到过有编号的事件就断了时说不了，运行时不补发也不发 resync，只能全部重新拉取。
 */
export function reconnected(queryClient: QueryClient, resumed: boolean): void {
	clearStreams();
	if (resumed) {
		invalidate(queryClient, queryKeys.portableGit, ['callOutput']);
	} else {
		void queryClient.invalidateQueries();
	}
}

/** 成员换了一步：直接改状态里的 activity，不重新拉取。还没有这个成员的状态时等运行开始的事件去拉。 */
function applyActivity(queryClient: QueryClient, event: IMemberActivityEvent): void {
	queryClient.setQueryData<Map<string, IMemberState>>(queryKeys.memberStates, states => {
		const state = states?.get(event.memberId);
		if (!states || !state) return states;
		return new Map(states).set(event.memberId, { ...state, activity: event.activity });
	});
}

function invalidate(queryClient: QueryClient, ...keys: QueryKey[]): void {
	for (const queryKey of keys) void queryClient.invalidateQueries({ queryKey });
}

/** 每种有编号的事件怎么处理。按事件类型列全，运行时加了新事件这里没写会编译报错。 */
const HANDLERS: { readonly [Type in RuntimeEvent['type']]: (queryClient: QueryClient, event: Extract<RuntimeEvent, { type: Type }>) => void } = {
	'member.changed': (queryClient, event) => {
		invalidate(
			queryClient, queryKeys.members, queryKeys.memberStates,
			// 工具开没开记在成员的配置里，工具列表要跟着刷新。
			queryKeys.tools(event.memberId), queryKeys.memory(event.memberId),
			// 提示词、记忆、模型、通讯录都会影响上下文用量。
			['contextUsage'],
		);
		// 新建的补进来，彻底删除的去掉。
		patchMemberOverview(queryClient, [event.memberId]);
	},
	// 成员的工具和技能来自成员文件夹。
	'memberFolders.changed': queryClient => invalidate(queryClient, queryKeys.members, queryKeys.memberFolders, ['tools'], queryKeys.skills, ['contextUsage']),
	// 成员文件没写技能时用新成员的默认技能，默认技能变了成员的技能也变。
	'skills.changed': queryClient => invalidate(queryClient, queryKeys.skills, queryKeys.members, ['skill'], ['skillSources']),
	// 每个 MCP 服务器是工具列表里的一项，服务器增减时工具列表也变；外部事件的来源就是 MCP 服务器。
	'mcp.changed': queryClient => invalidate(queryClient, queryKeys.mcp, queryKeys.toolCatalog, ['tools'], queryKeys.external),
	// 每项自定义工具是工具列表里的一项，配置好没有也显示在成员设置里。
	'customTools.changed': queryClient => invalidate(queryClient, queryKeys.customTools, queryKeys.toolCatalog, ['tools']),
	'external.changed': queryClient => invalidate(queryClient, queryKeys.external),
	'tools.changed': (queryClient, event) => invalidate(queryClient, queryKeys.tools(event.memberId), queryKeys.contextUsage(event.memberId)),
	'toolDefaults.changed': queryClient => invalidate(queryClient, queryKeys.toolCatalog),
	'browserBlocklist.changed': queryClient => invalidate(queryClient, queryKeys.browserBlocklist),
	// 自定义工具的配置可以选模型设置里的供应商，删了供应商它就不能用了。
	'models.changed': queryClient => invalidate(queryClient, queryKeys.models, ['contextUsage'], queryKeys.customTools, ['tools']),
	'group.changed': (queryClient, event) => invalidate(queryClient, queryKeys.group(event.groupId), queryKeys.groups, ['conversations']),
	'message.created': (queryClient, event) => {
		invalidate(queryClient, ...event.memberIds.map(queryKeys.conversations));
		// 发送人最近的结果、接收的真人的未读变了。
		patchMemberOverview(queryClient, event.memberIds);
		const key = refKey(event.conversation);
		void queryClient.invalidateQueries({ predicate: query => query.queryKey[0] === 'messages' && query.queryKey[2] === key });
		for (const listener of messageListeners) listener(event);
	},
	'conversation.read': (queryClient, event) => {
		invalidate(queryClient, queryKeys.conversations(event.memberId));
		patchMemberOverview(queryClient, [event.memberId]);
	},
	'memberSections.changed': queryClient => invalidate(queryClient, queryKeys.memberSections),
	'timeline.viewed': (queryClient, event) => patchMemberOverview(queryClient, [event.memberId]),
	'timeline.appended': (queryClient, event) => {
		void patchTimeline(queryClient, event.memberId);
		invalidate(queryClient, queryKeys.contextUsage(event.memberId));
		// 成员页的时间和最近的结果也跟着变。
		patchMemberOverview(queryClient, [event.memberId]);
		// 运行中的请求次数、token 跟着新内容更新：时间线最后那行「运行中」的统计。运行列表只在运行开始、结束时有事件。
		if (queryClient.getQueryData<IRun[]>(queryKeys.runs(event.memberId))?.some(run => run.status === 'running')) {
			invalidate(queryClient, queryKeys.runs(event.memberId));
		}
	},
	'timeline.updated': (queryClient, event) => {
		void patchTimeline(queryClient, event.memberId, event.itemIds);
		invalidate(queryClient, queryKeys.contextUsage(event.memberId));
	},
	'run.changed': (queryClient, event) => {
		// 运行开始或结束。已经有这次运行的流式内容说明是结束：等时间线刷新完再清掉，没进时间线的（比如被暂停打断）不再显示。
		if (useStreams.getState().streams[event.memberId]?.runId === event.runId) {
			void patchTimeline(queryClient, event.memberId).then(() => clearStream(event.memberId, event.runId));
		}
		invalidate(queryClient, queryKeys.runs(event.memberId), queryKeys.memberStates, queryKeys.contextUsage(event.memberId));
	},
	'approval.changed': queryClient => invalidate(queryClient, queryKeys.approvals, queryKeys.memberStates),
	'task.changed': (queryClient, event) => invalidate(queryClient, queryKeys.tasks(event.memberId)),
	'plan.changed': (queryClient, event) => invalidate(queryClient, queryKeys.plan(event.memberId)),
	'reminder.changed': (queryClient, event) => invalidate(queryClient, queryKeys.reminders(event.memberId)),
	'codeCall.changed': (queryClient, event) => invalidate(queryClient, queryKeys.codeCalls(event.memberId, event.runId, event.callId)),
	'portableGit.changed': queryClient => invalidate(queryClient, queryKeys.portableGit),
	// 沙箱能不能用决定命令工具的说明、参数和自动审批的写法。
	'sandbox.changed': queryClient => invalidate(queryClient, queryKeys.sandbox, queryKeys.toolCatalog, ['tools'], ['contextUsage']),
	'remote.changed': queryClient => invalidate(queryClient, queryKeys.remote),
	'terminal.changed': queryClient => invalidate(queryClient, queryKeys.terminals),
};
