import { randomUUID } from 'node:crypto';
import type { IMemberActivity } from '../runs/runs.ts';

/** 推送给前端的通知。只说明「什么变了」，前端需要细节时再查询。 */
export type RuntimeEvent =
	| { readonly type: 'member.changed'; readonly memberId: string }
	| { readonly type: 'memberFolders.changed' }
	| { readonly type: 'skills.changed' }
	| { readonly type: 'mcp.changed' }
	| { readonly type: 'customTools.changed' }
	| { readonly type: 'external.changed' }
	| { readonly type: 'group.changed'; readonly groupId: string }
	| { readonly type: 'message.created'; readonly messageId: number; readonly conversation: ConversationRef; readonly memberIds: readonly string[] }
	| { readonly type: 'timeline.appended'; readonly memberId: string; readonly itemIds: readonly number[] }
	| { readonly type: 'timeline.updated'; readonly memberId: string; readonly itemIds: readonly number[] }
	| { readonly type: 'conversation.read'; readonly memberId: string; readonly conversation: ConversationRef }
	| { readonly type: 'memberSections.changed' }
	| { readonly type: 'timeline.viewed'; readonly memberId: string }
	| { readonly type: 'plan.changed'; readonly memberId: string }
	| { readonly type: 'run.changed'; readonly memberId: string; readonly runId: number }
	| { readonly type: 'tools.changed'; readonly memberId: string }
	| { readonly type: 'toolDefaults.changed' }
	| { readonly type: 'browserBlocklist.changed' }
	| { readonly type: 'approval.changed'; readonly memberId: string; readonly approvalId: number }
	| { readonly type: 'task.changed'; readonly memberId: string; readonly taskId: string }
	| { readonly type: 'reminder.changed'; readonly memberId: string }
	| { readonly type: 'portableGit.changed' }
	| { readonly type: 'sandbox.changed' }
	| { readonly type: 'remote.changed' }
	| { readonly type: 'models.changed' }
	| { readonly type: 'terminal.changed'; readonly terminalId: string }
	| { readonly type: 'codeCall.changed'; readonly memberId: string; readonly runId: number; readonly callId: string; readonly callIndex: number };

/** 模型流式输出的增量：只推送给当前连着的前端，不编号、不补发（事件流连上时发一次到目前为止的，见 EventHub.current）；完整内容在响应结束后进入时间线。 */
export interface IRunDeltaEvent {
	readonly type: 'run.delta';
	readonly memberId: string;
	readonly runId: number;
	/** 所属的模型请求。这次请求的输出进入时间线后，时间线条目的 requestId 和它相同。 */
	readonly requestId: number;
	/** 这次请求的第几次尝试，从 1 开始。自动重试时模型从头输出，换了就从头接。 */
	readonly attempt: number;
	readonly kind: 'text' | 'reasoning';
	readonly delta: string;
}

/** 正在运行的成员换了一步。和模型增量一样只推送给当前连着的前端；activity 为 null 是运行结束了。 */
export interface IMemberActivityEvent {
	readonly type: 'member.activity';
	readonly memberId: string;
	readonly activity: IMemberActivity | null;
}

/** PortableGit 的下载进度：和模型增量一样只推送给当前连着的前端。 */
export interface IPortableGitProgressEvent {
	readonly type: 'portableGit.progress';
	readonly receivedBytes: number;
	readonly totalBytes: number;
}

/** 终端的原始输出。seq 是这个终端里的序号，前端拿屏幕快照后丢掉序号不大于快照的增量。 */
export interface ITerminalOutputEvent {
	readonly type: 'terminal.output';
	readonly terminalId: string;
	readonly seq: number;
	readonly data: string;
}

/** 执行中的 shell 调用有新输出，每个调用每秒最多一次。只说有新输出，要看时再取。 */
export interface ICallOutputEvent {
	readonly type: 'call.output';
	readonly memberId: string;
	readonly runId: number;
	readonly callId: string;
}

export type DeltaEvent = IRunDeltaEvent | IMemberActivityEvent | IPortableGitProgressEvent | ITerminalOutputEvent | ICallOutputEvent;

export type ConversationRef =
	| { readonly kind: 'direct'; readonly memberIds: readonly [string, string] }
	| { readonly kind: 'group'; readonly groupId: string };

export interface IPublishedEvent {
	readonly revision: number;
	readonly event: RuntimeEvent;
}

/** 推送给监听者的内容：有编号的事件，或者没有编号的增量。 */
export type Broadcast = IPublishedEvent | { readonly revision: undefined; readonly event: DeltaEvent };

const BUFFER_SIZE = 2000;

/** 一个成员正在流式输出的这次请求、这次尝试到目前为止的内容。 */
interface IStreamSoFar {
	readonly runId: number;
	readonly requestId: number;
	readonly attempt: number;
	text: string;
	reasoning: string;
}

/**
 * 事件中心。事务内产生的事件先暂存，提交后才发布，回滚则丢弃。
 * 每个进程有自己的 epoch：前端发现 epoch 变了（运行时重启过）就重新拉取状态。
 */
export class EventHub {
	readonly epoch = randomUUID();
	private revision = 0;
	private readonly buffer: IPublishedEvent[] = [];
	private readonly listeners = new Set<(item: Broadcast) => void>();
	private pending: RuntimeEvent[] | undefined;
	/** 流式输出和成员在做的事只推增量，这里记着每个成员现在的，事件流连上时先发一遍（见 current），断线期间的补得回来。运行结束时清掉。 */
	private readonly activities = new Map<string, IMemberActivityEvent>();
	private readonly streams = new Map<string, IStreamSoFar>();

	get currentRevision(): number {
		return this.revision;
	}

	emit(event: RuntimeEvent): void {
		if (this.pending) {
			this.pending.push(event);
		} else {
			this.publish(event);
		}
	}

	/** 由数据库事务调用：开始暂存。 */
	beginBatch(): void {
		this.pending = [];
	}

	endBatch(commit: boolean): void {
		const pending = this.pending ?? [];
		this.pending = undefined;
		if (commit) {
			for (const event of pending) this.publish(event);
		}
	}

	/** 返回 revision 之后的事件；如果已经不在缓冲区里，返回 undefined，前端需要重新拉取。 */
	since(revision: number): readonly IPublishedEvent[] | undefined {
		if (revision >= this.revision) return [];
		const oldest = this.buffer[0]?.revision ?? this.revision + 1;
		if (revision + 1 < oldest) return undefined;
		return this.buffer.filter(item => item.revision > revision);
	}

	/** 发送增量。不进事务、不占编号。 */
	delta(event: DeltaEvent): void {
		this.remember(event);
		for (const listener of this.listeners) listener({ revision: undefined, event });
	}

	/**
	 * 现在每个正在运行的成员在做的事，和正在流式输出的内容（每种一条，delta 是这次尝试到目前为止的全部），写成增量事件。
	 * 事件流连上时先发这些；前端重连时先清掉已有的流式内容再接，不会缺一截。
	 */
	current(): DeltaEvent[] {
		const streams = [...this.streams].flatMap(([memberId, stream]) => (['reasoning', 'text'] as const)
			.filter(kind => stream[kind] !== '')
			.map((kind): IRunDeltaEvent => ({ type: 'run.delta', memberId, runId: stream.runId, requestId: stream.requestId, attempt: stream.attempt, kind, delta: stream[kind] })));
		return [...this.activities.values(), ...streams];
	}

	subscribe(listener: (item: Broadcast) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private remember(event: DeltaEvent): void {
		if (event.type === 'member.activity') {
			if (event.activity) {
				this.activities.set(event.memberId, event);
			} else {
				this.activities.delete(event.memberId);
				this.streams.delete(event.memberId);
			}
		} else if (event.type === 'run.delta') {
			const current = this.streams.get(event.memberId);
			const stream = current && current.requestId === event.requestId && current.attempt === event.attempt
				? current
				: { runId: event.runId, requestId: event.requestId, attempt: event.attempt, text: '', reasoning: '' };
			stream[event.kind] += event.delta;
			this.streams.set(event.memberId, stream);
		}
	}

	private publish(event: RuntimeEvent): void {
		const published = { revision: ++this.revision, event };
		this.buffer.push(published);
		if (this.buffer.length > BUFFER_SIZE) this.buffer.shift();
		for (const listener of this.listeners) listener(published);
	}
}
