// 接口里用到、而运行时其他模块没有的类型。只放类型，前端直接引用。
import type { IMessage } from '../messages/messages.ts';
import type { IMemberActivity } from '../runs/runs.ts';
import type { TimelineItem } from '../timeline/timeline.ts';

/** 时间线条目；消息条目带上消息内容。 */
export type TimelineEntry = Exclude<TimelineItem, { kind: 'message' }> | (Extract<TimelineItem, { kind: 'message' }> & { readonly message: IMessage });

export type MemberStatus = 'idle' | 'running' | 'waiting_approval' | 'paused' | 'failed' | 'interrupted';

/**
 * AI 成员的状态。failed 是最近一次运行出错停止，interrupted 是运行停在了工具结果上（如运行时退出时中断），error 是原因，
 * 两种都可以重试；正在运行时 activity 是在做什么。
 */
export interface IMemberState {
	readonly memberId: string;
	readonly status: MemberStatus;
	readonly error: string | null;
	readonly activity: IMemberActivity | null;
}
