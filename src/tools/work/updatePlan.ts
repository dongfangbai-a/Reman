import { MAX_PLAN_ITEM_LENGTH, MAX_PLAN_ITEMS, PLAN_STATUSES, readPlanItems, type Plans } from '../../plans/plans.ts';
import type { ITool } from '../tools.ts';

export const UPDATE_PLAN_TOOL_NAME = 'update_plan';

/**
 * 更新自己的计划：每次传完整的清单，整份替换，全部完成时清空。总是可用，不审批。
 * 直接调用时记下这次调用的条目，压缩后据此判断计划原文还在不在上下文里；在脚本里调用的参数可能是算出来的，不记。
 */
export function createUpdatePlanTool(plans: Plans): ITool {
	return {
		name: UPDATE_PLAN_TOOL_NAME,
		label: '更新计划',
		description: [
			'更新你的计划：列出要做的事项及各自的状态。',
			'任务需要多个步骤，或同时有几项任务（包括其他成员追加的）时使用；一步即可完成的事不必使用。',
			'每次传入完整的清单，替换原有的计划。',
			'开始做某项时将其标为 in_progress，完成后随即标为 completed，不要等到最后一并更新。通常同一时间只有一项进行中。所有事项均标为 completed 后，计划即自动清空。',
			'每项写一件要做的事，不写过程、结果、路径或命令；进展和结果写在输出或消息中。开始一批新的工作时，删除已完成的旧事项。',
			'任务取消时，删除相应的事项；剩余事项全部取消时，传入空列表清空计划。',
			`最多 ${MAX_PLAN_ITEMS} 项（含已完成的），每项最多 ${MAX_PLAN_ITEM_LENGTH} 字。用户能看到你的计划。可以与其他工具调用一同发出。`,
		].join('\n'),
		parameters: {
			type: 'object',
			properties: {
				items: {
					type: 'array',
					description: '完整的计划，按要做的顺序排列',
					maxItems: MAX_PLAN_ITEMS,
					items: {
						type: 'object',
						properties: {
							text: { type: 'string', description: `要做的事，最多 ${MAX_PLAN_ITEM_LENGTH} 字` },
							status: { type: 'string', enum: [...PLAN_STATUSES], description: 'pending 未开始；in_progress 进行中；completed 已完成' },
						},
						required: ['text', 'status'],
						additionalProperties: false,
					},
				},
			},
			required: ['items'],
			additionalProperties: false,
		},
		execute(context, args) {
			const items = readPlanItems(args['items']);
			plans.update(context.memberId, items, context.call && !context.inScript ? context.call.itemId : null);
			if (items.length === 0) return '计划已清空。';
			return items.every(item => item.status === 'completed') ? '全部事项已完成，计划已清空。' : '计划已更新。';
		},
	};
}
