import { invalid } from '../../common/errors.ts';
import type { Members } from '../../members/members.ts';
import { MAX_ATTACHMENTS, type Attachments } from '../../messages/attachments.ts';
import type { ConversationTarget, Messages } from '../../messages/messages.ts';
import { resolveToolPath } from '../paths.ts';
import type { DataProtection } from '../protection.ts';
import type { ITool } from '../tools.ts';

/** 给私聊对象或群聊发消息。成员发出的每条消息都经过这里。 */
export function createSendMessageTool(messages: Messages, attachments: Attachments, members: Members, protection: DataProtection): ITool {
	return {
		name: 'send_message',
		label: '发送消息',
		description: '向一名成员发送私聊消息，或在群聊中发送消息。',
		parameters: {
			type: 'object',
			properties: {
				target: { type: 'string', description: '私聊对象的成员 ID（M_ 开头），或群聊 ID（G_ 开头）' },
				text: { type: 'string', description: '消息内容；带有附件时可以为空' },
				mentions: {
					type: 'array',
					items: { type: 'string' },
					description: '仅用于群聊：要点名的成员 ID；写 ["all"] 表示点名所有人。正文中写名字不算点名；未被点名且未关注该群的成员不会收到提醒',
				},
				attachments: {
					type: 'array',
					items: { type: 'string' },
					description: `作为附件发送的文件路径，相对路径以工作目录为基准；最多 ${MAX_ATTACHMENTS} 个`,
				},
			},
			required: ['target', 'text'],
			additionalProperties: false,
		},
		// 附件会复制一份，副本谁都能读：发令牌、密钥这类敏感文件和读它们一样要审批。
		protectedReasons: (context, args) => protection.readReasons(attachmentPaths(context.workingDirectory, args['attachments'])),
		execute(context, args) {
			const { target, text, mentions } = args;
			if (typeof target !== 'string') throw invalid('缺少 target');
			if (typeof text !== 'string') throw invalid('缺少 text');
			if (mentions !== undefined && (!Array.isArray(mentions) || !mentions.every(item => typeof item === 'string'))) {
				throw invalid('mentions 必须是字符串数组');
			}
			const paths = attachmentPaths(context.workingDirectory, args['attachments']);
			const mentionList = (mentions ?? []) as string[];
			const conversation = parseTarget(target, 'target');
			const attachmentIds = paths.map(path => attachments.importFile(path).attachmentId);
			const message = messages.send(context.memberId, conversation, text, mentionList.includes('all') ? 'all' : mentionList, attachmentIds, null, context.call?.itemId ?? null);
			const withAttachments = attachmentIds.length > 0 ? `，附件 ${attachmentIds.length} 个` : '';
			// 发给谁在调用的参数里已经有了，不再写一遍。
			if (conversation.kind === 'direct') return `已发送${withAttachments}`;
			// 写明点名了谁（按模型给的顺序）：漏了点名时模型能从结果里看出来，自己补发。
			const mentioned = message.mentionAll ? '点名了所有人'
				: message.mentionedMemberIds.length > 0 ? `点名了${[...new Set(mentionList)].map(memberId => members.require(memberId).name).join('、')}`
					: '未点名';
			return `已发送${withAttachments}，${mentioned}`;
		},
	};
}

/** 附件的绝对路径，相对路径从工作目录算起；参数不对时报错。 */
function attachmentPaths(workingDirectory: string, value: unknown): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || !value.every(item => typeof item === 'string' && item.trim())) throw invalid('attachments 必须是文件路径数组');
	if (value.length > MAX_ATTACHMENTS) throw invalid(`一条消息最多 ${MAX_ATTACHMENTS} 个附件`);
	return value.map(path => resolveToolPath(workingDirectory, path as string));
}

/** 成员 ID 是私聊，群聊 ID 是群聊；都不是时报错，name 是参数名。 */
export function parseTarget(value: unknown, name: string): ConversationTarget {
	if (typeof value === 'string' && value.startsWith('M_')) return { kind: 'direct', memberId: value };
	if (typeof value === 'string' && value.startsWith('G_')) return { kind: 'group', groupId: value };
	throw invalid(`${name} 必须是成员 ID（M_ 开头）或群聊 ID（G_ 开头）`);
}
