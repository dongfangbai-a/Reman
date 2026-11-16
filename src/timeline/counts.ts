import { messageText, type TimelineItem } from './timeline.ts';

/**
 * 压缩处理的内容按种类数的条数，给用户在时间线里看：一条摘要代替了什么，一次压缩删掉了什么。
 * 压缩时算好存下，以后不变。种类见运行时设计第 5 部分「压缩」。
 */
export interface IContentCounts {
	/** 之前整理的摘要。 */
	readonly summaries: number;
	/** 收到的消息、用户直接说的话、成员发出的消息（send_message）。 */
	readonly messages: number;
	readonly thinking: number;
	/** 有文字的直接输出。 */
	readonly outputs: number;
	/** 工具调用，调用和结果算一次；服务端工具这类其他输出也算。 */
	readonly calls: number;
	/** 群聊变动、定时、后台任务结果、终端交还、外部事件、变动说明、没放进上下文的内容的说明。 */
	readonly events: number;
}

/** 按种类数这些内容。工具结果不单独算，和它的调用算一次。 */
export function countContent(items: readonly TimelineItem[]): IContentCounts {
	const counts = { summaries: 0, messages: 0, thinking: 0, outputs: 0, calls: 0, events: 0 };
	for (const item of items) {
		const kind = categoryOf(item);
		if (kind) counts[kind]++;
	}
	return counts;
}

/** 把几份统计加在一起。 */
export function addCounts(parts: readonly IContentCounts[]): IContentCounts {
	const total = { summaries: 0, messages: 0, thinking: 0, outputs: 0, calls: 0, events: 0 };
	for (const part of parts) {
		for (const key of Object.keys(total) as (keyof IContentCounts)[]) total[key] += part[key];
	}
	return total;
}

function categoryOf(item: TimelineItem): keyof IContentCounts | undefined {
	switch (item.kind) {
		case 'summary': return 'summaries';
		case 'message':
		case 'user_input': return 'messages';
		case 'model_output': {
			const { output } = item;
			if (output.type === 'reasoning') return 'thinking';
			if (output.type === 'function_call') return output['name'] === 'send_message' ? 'messages' : 'calls';
			// 没有文字的直接输出（模型用它结束一次运行）不显示，也不算。
			if (output.type === 'message') return messageText(output['content']).trim() ? 'outputs' : undefined;
			return 'calls';
		}
		case 'group_event':
		case 'reminder':
		case 'task_result':
		case 'terminal_event':
		case 'external_event':
		case 'change_notice':
		case 'plan':
		case 'omission': return 'events';
		// 工具结果和调用算一次；记忆的修改、删除记录和压缩记录不进上下文，不会被压缩。
		case 'tool_result':
		case 'memory_change':
		case 'pruning':
		case 'optimization': return undefined;
	}
}
