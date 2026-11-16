import { invalid } from '../../common/errors.ts';
import type { Groups, IGroup } from '../../groups/groups.ts';
import type { Describer } from '../../runs/describe.ts';
import type { ITool } from '../tools.ts';

const ACTIONS = ['create', 'update_members', 'dissolve', 'watch', 'unwatch'] as const;

/** 创建群聊、调整成员、解散，以及自己关注或取消关注群聊。 */
export function createManageGroupTool(groups: Groups, describer: Describer): ITool {
	const summary = (group: IGroup) => `「${group.name}」(${group.groupId})，成员：${group.members.map(membership => describer.member(membership.memberId)).join('、')}`;
	return {
		name: 'manage_group',
		label: '管理群聊',
		progressive: true,
		description: [
			'创建群聊、调整群聊成员、解散群聊，或关注、取消关注群聊。',
			'- create：创建群聊，你为创建者。须提供 name，add_member_ids 为初始成员。',
			'- update_members：创建者可以加入成员、移出其他成员；其他成员只能将自己移出，remove_member_ids 填写自己的 ID。创建者不能移出自己，如需结束群聊，使用 dissolve。',
			'- dissolve：解散你创建的群聊。',
			'- watch：关注你所在的群聊，此后该群的每条新消息都会提醒你处理。',
			'- unwatch：取消关注，此后该群只有点名你的消息会提醒你。',
			'除 create 外，均须提供 group_id。',
		].join('\n'),
		defaultPolicy: 'ask',
		enabledByDefault: false,
		parameters: {
			type: 'object',
			properties: {
				action: { type: 'string', enum: [...ACTIONS] },
				name: { type: 'string', description: '群聊名称，仅用于 create' },
				group_id: { type: 'string', description: '群聊 ID（G_ 开头）' },
				add_member_ids: { type: 'array', items: { type: 'string' }, description: '要加入的成员 ID' },
				remove_member_ids: { type: 'array', items: { type: 'string' }, description: '要移出的成员 ID' },
			},
			required: ['action'],
			additionalProperties: false,
		},
		execute(context, args) {
			const action = args['action'];
			if (typeof action !== 'string' || !(ACTIONS as readonly string[]).includes(action)) throw invalid(`action 必须是 ${ACTIONS.join('、')} 之一`);
			const add = memberIds(args, 'add_member_ids');
			const remove = memberIds(args, 'remove_member_ids');
			if (action === 'create') {
				const name = args['name'];
				if (typeof name !== 'string') throw invalid('create 须提供 name');
				groups.checkInvites(context.memberId, add);
				return `已创建群聊${summary(groups.create(context.memberId, name, add))}`;
			}
			const groupId = args['group_id'];
			if (typeof groupId !== 'string') throw invalid(`${action} 须提供 group_id`);
			switch (action) {
				case 'update_members':
					if (add.length === 0 && remove.length === 0) throw invalid('update_members 须提供 add_member_ids 或 remove_member_ids');
					if (remove.length === 1 && remove[0] === context.memberId && add.length === 0) {
						const group = groups.updateMembers(context.memberId, groupId, [], remove);
						return `已退出群聊「${group.name}」(${group.groupId})`;
					}
					groups.checkInvites(context.memberId, add, groupId);
					return `已调整成员，群聊${summary(groups.updateMembers(context.memberId, groupId, add, remove))}`;
				case 'dissolve': {
					const group = groups.requireMember(groupId, context.memberId);
					groups.dissolve(context.memberId, groupId);
					return `已解散群聊「${group.name}」(${group.groupId})`;
				}
				default: {
					const group = groups.setWatching(groupId, context.memberId, action === 'watch', 'self');
					return `已${action === 'watch' ? '关注' : '取消关注'}群聊「${group.name}」(${group.groupId})`;
				}
			}
		},
	};
}

function memberIds(args: Record<string, unknown>, key: string): string[] {
	const value = args[key];
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) throw invalid(`${key} 必须是成员 ID 数组`);
	return value;
}
