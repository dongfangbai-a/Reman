import { ALL_MEMBERS_NAME } from '../common/names.ts';
import { describeLocal, formatDuration, parseDateTime } from '../common/time.ts';
import type { Groups } from '../groups/groups.ts';
import type { Members } from '../members/members.ts';
import { formatSize, type IAttachment } from '../messages/attachments.ts';
import type { IMessage } from '../messages/messages.ts';
import type { IReminderFired } from '../reminders/reminders.ts';
import type { IExternalEventItem, IGroupEvent, ITaskResult, ITerminalEvent, IUserInput } from '../timeline/timeline.ts';

/** 收到的消息在上下文里的内容：文字，图片附件紧跟在说明它的那一行后面。 */
export type MessagePart = { readonly type: 'text'; readonly text: string } | { readonly type: 'image'; readonly resourceId: string };

/** 把消息和群聊变动写成给模型看的文字。上下文和查历史用同一套说法。 */
export class Describer {
	private readonly members: Members;
	private readonly groups: Groups;

	constructor(members: Members, groups: Groups) {
		this.members = members;
		this.groups = groups;
	}

	/** 收到的消息：开头一行说明来源，下面是正文（代发的外部事件先列出 meta），最后每个附件一行。 */
	receivedMessage(viewerMemberId: string, message: IMessage): string {
		return this.withAttachments(this.receivedHead(viewerMemberId, message), messageBody(message), message.attachments).text;
	}

	/** 收到的消息放进上下文的内容：和 receivedMessage 的文字一样，另外带上图片。 */
	receivedMessageParts(viewerMemberId: string, message: IMessage): MessagePart[] {
		return this.withAttachments(this.receivedHead(viewerMemberId, message), messageBody(message), message.attachments).parts;
	}

	/** 路由投给成员的外部事件：第一行写来源，接着每个 meta 一行，空一行后是正文。 */
	externalEvent(event: IExternalEventItem): string {
		return `外部来源「${event.source}」：\n${externalBody(event.meta, event.text)}`;
	}

	/** 用户在时间线里直接说的话：只有正文，没有来源说明；附件和消息一样每个一行。 */
	userInput(input: IUserInput): string {
		return this.withAttachments(undefined, input.text, input.attachments).text;
	}

	/** 用户直接说的话放进上下文的内容：和 userInput 的文字一样，另外带上图片。 */
	userInputParts(input: IUserInput): MessagePart[] {
		return this.withAttachments(undefined, input.text, input.attachments).parts;
	}

	/** 自己发出的消息。 */
	sentMessage(viewerMemberId: string, message: IMessage): string {
		let head: string;
		if (message.conversation.kind === 'direct') {
			const peer = message.conversation.memberIds.find(memberId => memberId !== viewerMemberId)!;
			head = `你私聊 ${this.member(peer)}`;
		} else {
			const mentions = this.mentions(viewerMemberId, message);
			head = `你在${this.group(message.conversation.groupId)}中发送的消息${mentions ? `，点名了${mentions}` : ''}`;
		}
		return this.withAttachments(head, message.text, message.attachments).text;
	}

	message(viewerMemberId: string, message: IMessage): string {
		return message.senderMemberId === viewerMemberId ? this.sentMessage(viewerMemberId, message) : this.receivedMessage(viewerMemberId, message);
	}

	groupEvent(event: IGroupEvent): string {
		const actor = event.actorMemberId === null ? '用户' : this.member(event.actorMemberId);
		const group = `群聊「${event.groupName}」(${event.groupId})`;
		switch (event.type) {
			case 'added': return `${actor}将你加入了${group}`;
			case 'removed': return `${actor}将你移出了${group}`;
			case 'dissolved': return `${actor}解散了${group}`;
			case 'restored': return `${group}已恢复`;
			// 写明以后会怎样，和通讯录开头对关注的说明一致。
			case 'watched': return `${actor}为你关注了${group}，此后该群的每条新消息都会提醒你处理`;
			case 'unwatched': return `${actor}取消了你对${group}的关注，此后该群只有点名你的消息会提醒你`;
		}
	}

	taskResult(task: ITaskResult): string {
		const head = `后台任务 ${task.taskId}（工具 ${task.toolName}）`;
		// 还在跑的任务写在第一行、不接在输出后面：接在后面会被当成这个任务的输出。全部列出，不截断。
		const remaining = task.remainingTasks?.length
			? `（仍有 ${task.remainingTasks.length} 个后台任务未结束：${task.remainingTasks.map(other => `${other.taskId}（${other.toolName}）`).join('、')}）`
			: '';
		switch (task.status) {
			case 'completed': return `${head}已完成${remaining}：\n${task.output}`;
			case 'failed': return `${head}执行出错${remaining}：\n${task.output}`;
			case 'cancelled':
			case 'interrupted': {
				const how = task.status === 'interrupted' ? '因运行时退出而中断' : task.cancelledOnDelete ? '因你被删除而取消' : task.cancelledByMember ? '已被你取消' : '已被用户取消';
				const before = task.status === 'interrupted' ? '中断前' : '取消前';
				if (task.stoppedOutput === 'kept') return `${head}${how}${remaining}，${before}的输出：\n${task.output}`;
				if (task.stoppedOutput === 'lost') return `${head}${how}${remaining}，输出未保存。`;
				return `${head}${how}${remaining}，${before}无输出。`;
			}
		}
	}

	/** 定时到了：标明是系统提示，写明原定时间、以后还来不来，然后是成员自己记下的事。 */
	reminder(fired: IReminderFired): string {
		const local = parseDateTime(fired.time);
		const late = formatDuration(fired.lateMs);
		return [
			`系统提示：定时 ${fired.reminderId} 已到时间`,
			`原定时间：${local ? describeLocal(local, local.year) : fired.time}（${fired.timeZone}）${late ? `，延迟 ${late}` : ''}`,
			fired.repeat ? `重复：${fired.repeat}，下次时间 ${fired.next}` : '一次性定时，已结束',
			'你创建定时时记录的事项：',
			fired.note,
		].join('\n');
	}

	terminalEvent(event: ITerminalEvent): string {
		switch (event.event) {
			case 'released':
				if (event.request !== null) return `你曾请求用户接管终端 ${event.terminalId}：${event.request}。用户已交还终端，你可以继续操作。`;
				if (event.waiting) return `你此前使用终端 ${event.terminalId} 时用户正在操作，现在用户已交还终端，你可以继续操作。`;
				return `用户曾接管终端 ${event.terminalId}，现已交还给你。`;
			case 'declined':
				return `你曾请求用户接管终端 ${event.terminalId}${event.request === null ? '' : `：${event.request}`}。用户没有接管，你可以继续操作。`;
			case 'closed':
			case 'exited': {
				// 成员还在等用户交还，终端却没了：写明它在等什么、现在怎样了。
				const before = event.request !== null ? `你曾请求用户接管终端 ${event.terminalId}：${event.request}。` : `你此前使用终端 ${event.terminalId} 时用户正在操作。`;
				if (event.event === 'exited') return `${before}该终端中的程序现已退出，退出码 ${event.exitCode}。`;
				return `${before}该终端现已被${event.closedBy === 'user' ? '用户' : `成员 ${this.member(event.closedBy!)} `}关闭。`;
			}
		}
	}

	/**
	 * 收到的消息的说明行：只写每条不一样、要用到的，即哪个私聊或群聊、谁发的、点名了谁，和回复要用的 ID。
	 * 如「群聊「讨论组」(G_…) 张三(M_…) 点名了你」「张三(M_…) 私聊你」。
	 */
	private receivedHead(viewerMemberId: string, message: IMessage): string {
		const sender = this.member(message.senderMemberId);
		const forwarded = message.external ? `转发外部来源「${message.external.source}」` : undefined;
		if (message.conversation.kind === 'direct') return forwarded ? `${sender} 私聊你，${forwarded}` : `${sender} 私聊你`;
		const head = `${this.group(message.conversation.groupId)} ${sender}${forwarded ? ` ${forwarded}` : ''}`;
		const mentions = this.mentions(viewerMemberId, message);
		return mentions ? `${head}${forwarded ? '，' : ' '}点名了${mentions}` : head;
	}

	/**
	 * 说明行、正文，然后每个附件一行写文件名、大小和本地路径；图片放在它那一行后面。
	 * 没有说明行时（用户直接说的话）从正文开始，没有正文时直接是附件。
	 */
	private withAttachments(head: string | undefined, text: string, attachments: readonly IAttachment[]): { text: string; parts: MessagePart[] } {
		const lines = head === undefined ? (text ? [text] : []) : [text ? `${head}：\n${text}` : `${head}：`];
		if (attachments.length > 0 && lines.length > 0) lines.push('');
		const parts: MessagePart[] = [];
		let pending = [...lines];
		attachments.forEach((attachment, index) => {
			const line = attachmentLine(attachment, index);
			lines.push(line);
			pending.push(line);
			if (attachment.kind === 'image') {
				parts.push({ type: 'text', text: pending.join('\n') }, { type: 'image', resourceId: attachment.resourceId });
				pending = [];
			}
		});
		if (pending.length > 0) parts.push({ type: 'text', text: pending.join('\n') });
		return { text: lines.join('\n'), parts };
	}

	member(memberId: string): string {
		return `${this.members.name(memberId) ?? '未知成员'}(${memberId})`;
	}

	private group(groupId: string): string {
		return `群聊「${this.groups.name(groupId)}」(${groupId})`;
	}

	/** 点名了谁：自己写「你」，排在最前面；点名了所有人写「所有人」；没有点名时是空的。 */
	private mentions(viewerMemberId: string, message: IMessage): string {
		if (message.mentionAll) return ALL_MEMBERS_NAME;
		const others = message.mentionedMemberIds.filter(memberId => memberId !== viewerMemberId).map(memberId => this.member(memberId));
		const names = message.mentionedMemberIds.includes(viewerMemberId) ? ['你', ...others] : others;
		return names.join('、');
	}
}

/** 消息的正文；真人成员代发的外部事件先列出 meta。 */
function messageBody(message: IMessage): string {
	return message.external ? externalBody(message.external.meta, message.text) : message.text;
}

/** 附件那一行：文件名、是不是图片、大小和本地路径。index 从 0 算。 */
function attachmentLine(attachment: IAttachment, index: number): string {
	return `附件 ${index + 1}：${attachment.name}（${attachment.kind === 'image' ? '图片，' : ''}${formatSize(attachment.size)}），路径 ${attachment.path}`;
}

/** 查历史匹配用的正文：正文后面每个附件一行，和给模型看的写法一样，不含来源说明。按文件名、「图片」也能找到。 */
export function searchText(text: string, attachments: readonly IAttachment[]): string {
	return [text, ...attachments.map(attachmentLine)].filter(Boolean).join('\n');
}

/** 外部事件的内容：每个 meta 一行，空一行后是正文。 */
export function externalBody(meta: Readonly<Record<string, string>>, text: string): string {
	const lines = Object.entries(meta).map(([key, value]) => `${key}: ${value}`);
	return lines.length > 0 ? `${lines.join('\n')}\n\n${text}` : text;
}
