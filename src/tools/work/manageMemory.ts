import { invalid } from '../../common/errors.ts';
import { MEMORY_LIMIT, applyMemoryOperation, checkMemoryLimit, memoryLength, type Memories, type MemoryOperation } from '../../members/memory.ts';
import type { ITool } from '../tools.ts';

export const MANAGE_MEMORY_TOOL_NAME = 'manage_memory';

/** 修改自己的长期记忆。总是可用；改了不刷新上下文开头的快照。 */
export function createManageMemoryTool(memories: Memories): ITool {
	return {
		name: MANAGE_MEMORY_TOOL_NAME,
		label: '管理记忆',
		description: [
			'修改你的记忆。记忆始终位于开头的「# 你的记忆」一节，不会像较早的内容那样被整理为摘要；修改后，该节需要一段时间才会更新。',
			`用于记录后续仍需要的事实、偏好、约定和分工。记忆最多 ${MEMORY_LIMIT} 字。`,
		].join('\n'),
		parameters: {
			type: 'object',
			properties: {
				action: { type: 'string', enum: ['add', 'replace'], description: 'add 在末尾添加；replace 将 old_text 替换为 new_text' },
				text: { type: 'string', description: 'add 时必填：要添加的内容' },
				old_text: { type: 'string', description: 'replace 时必填：记忆中要替换的原文，须与原文完全一致且只出现一次' },
				new_text: { type: 'string', description: 'replace 时必填：替换后的内容，空字符串表示删除' },
			},
			required: ['action'],
			additionalProperties: false,
		},
		execute(context, args) {
			const operation = readOperation(args);
			const current = memories.read(context.memberId);
			const next = applyMemoryOperation(current, operation);
			checkMemoryLimit(current, next);
			memories.write(context.memberId, next, false);
			const done = operation.op === 'add' ? '已添加' : operation.newText ? '已修改' : '已删除';
			return `${done}。${memoryLength(next)}`;
		},
	};
}

function readOperation(args: Record<string, unknown>): MemoryOperation {
	if (args['action'] === 'add') {
		if (typeof args['text'] !== 'string') throw invalid('add 须提供 text');
		return { op: 'add', text: args['text'] };
	}
	if (args['action'] === 'replace') {
		if (typeof args['old_text'] !== 'string') throw invalid('replace 须提供 old_text');
		if (typeof args['new_text'] !== 'string') throw invalid('replace 须提供 new_text，删除时传空字符串');
		return { op: 'replace', oldText: args['old_text'], newText: args['new_text'] };
	}
	throw invalid('action 只能是 add 或 replace');
}
