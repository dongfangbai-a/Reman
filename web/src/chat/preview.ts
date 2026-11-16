import type { IMessage, IMember } from '../api/types.ts';

/** 列表里一条消息的一行预览：群聊前面带发送者，附件写成 [图片]、[文件]。 */
export function messagePreview(message: IMessage, memberById: Map<string, IMember>, withSender: boolean): string {
	const text = message.text.replace(/\s+/g, ' ').trim();
	const files = message.attachments.map(attachment => attachment.kind === 'image' ? '[图片]' : `[文件] ${attachment.name}`).join(' ');
	const body = [text, files].filter(Boolean).join(' ');
	if (!withSender) return body;
	return `${memberById.get(message.senderMemberId)?.name ?? '未知成员'}：${body}`;
}
