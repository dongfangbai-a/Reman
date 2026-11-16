import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';
import { api } from './api/client.ts';
import { onMessageCreated } from './api/events.ts';
import { conversationKey, conversationPath, queryKeys, refKey, refTarget } from './api/keys.ts';
import { useMemberStates } from './api/member.ts';
import { useMembers } from './api/queries.ts';
import type { IConversationSummary, IGroup, IMessage, MemberStatus } from './api/types.ts';
import { messagePreview } from './chat/preview.ts';
import { useInbox } from './inbox/inbox.ts';
import { notifyHumanIds } from './perspective/notifyHumans.ts';
import { usePreferences } from './stores.ts';
import { approvalSubject, useToolLabel } from './timeline/approvalText.ts';
import { openTerminal } from './workbench/tabs.ts';

/** 系统通知都只在页面不在前台、浏览器允许通知时发。 */
function canNotify(): boolean {
	return document.visibilityState !== 'visible' && 'Notification' in window && Notification.permission === 'granted';
}

/** 发系统通知，点击时回到页面并执行 open。同一个 tag 的新通知替换旧的。 */
function notify(title: string, body: string, tag: string, open: () => void): void {
	const notification = new Notification(title, { body, tag });
	notification.onclick = () => {
		window.focus();
		open();
		notification.close();
	};
}

/** 浏览器只允许在用户点击时请求通知权限，所以在打开通知时请求。返回是否允许了。 */
export async function requestNotificationPermission(): Promise<boolean> {
	const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
	return permission === 'granted';
}

/**
 * 打开了待处理通知时，有新的审批或接管请求就发系统通知：审批点击打开那个成员的时间线并展开概况栏，
 * 接管请求点击打开工作台、切到那个终端。
 */
export function useInboxNotifications(): void {
	const enabled = usePreferences(state => state.inboxNotifications);
	const inbox = useInbox();
	const members = useMembers();
	const label = useToolLabel();
	const navigate = useNavigate();
	const seen = useRef<Set<string> | undefined>(undefined);
	const keys = inbox.items.map(item => item.key).join(' ');

	useEffect(() => {
		if (inbox.isPending) return;
		const known = seen.current;
		seen.current = new Set(inbox.items.map(item => item.key));
		// 第一次加载到的是已经在等的，不通知。
		if (!known || !enabled || !canNotify()) return;
		for (const item of inbox.items) {
			if (known.has(item.key)) continue;
			const name = members.data?.find(member => member.memberId === item.memberId)?.name ?? '成员';
			if (item.kind === 'approval') {
				const subject = approvalSubject(item.approval.toolName, item.approval.arguments);
				notify(`${name} 等待你审批`, `${label(item.approval.toolName)}${subject && `：${subject}`}`, item.key, () => {
					usePreferences.getState().set({ overviewOpen: true });
					navigate(`/members/${item.memberId}`);
				});
			} else {
				notify(`${name} 请你接管终端 ${item.terminalId}`, item.request, item.key, () => openTerminal(item.terminalId));
			}
		}
	}, [keys, inbox.isPending, enabled, members.data, label, navigate]);
}

/**
 * 按设置给要提醒的真人收到的消息发系统通知，它自己发的不提醒。「私聊和 @」是发给它的私聊和 @ 它的群消息。
 * 点击用这个真人的视角打开对话并跳到那条消息；同一个对话的新通知替换旧的。
 */
export function useMessageNotifications(): void {
	const mode = usePreferences(state => state.messageNotifications);
	const chosen = usePreferences(state => state.notifyHumans);
	const members = useMembers();
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const latest = useRef({ mode, chosen, members: members.data, navigate });
	latest.current = { mode, chosen, members: members.data, navigate };

	useEffect(() => onMessageCreated(event => {
		const { mode, chosen, members } = latest.current;
		if (mode === 'off' || !canNotify()) return;
		const humans = notifyHumanIds(members ?? [], chosen);
		const receivers = event.memberIds.filter(memberId => humans.has(memberId));
		if (receivers.length === 0) return;
		void api<{ message: IMessage }>('GET', `/v1/messages/${event.messageId}`).then(({ message }) => {
			const group = message.conversation.kind === 'group';
			const mentions = (memberId: string) => message.mentionAll || message.mentionedMemberIds.includes(memberId);
			// 收到这条消息的要提醒的真人里，按设置该提醒的第一个；点名了谁优先提醒谁。
			const candidates = receivers.filter(memberId => memberId !== message.senderMemberId && (mode === 'all' || !group || mentions(memberId)));
			const human = candidates.find(mentions) ?? candidates[0];
			if (!human) return;
			const memberById = new Map((latest.current.members ?? []).map(member => [member.memberId, member]));
			const sender = memberById.get(message.senderMemberId)?.name ?? '未知成员';
			const key = refKey(message.conversation);
			const title = group ? groupName(queryClient, message, human) ?? '群聊' : sender;
			const preview = messagePreview(message, memberById, false);
			const body = group ? `${mentions(human) ? `[有人@${memberById.get(human)?.name ?? ''}] ` : ''}${sender}：${preview}` : preview;
			const path = conversationPath(human, refTarget(message.conversation, human), message.messageId);
			notify(title, body, `message-${human}-${key}`, () => latest.current.navigate(path));
		}, () => undefined);
	}), [queryClient]);
}

/** 群名：先找这个真人的对话列表，再找群聊列表。 */
function groupName(queryClient: QueryClient, message: IMessage, human: string): string | undefined {
	if (message.conversation.kind !== 'group') return undefined;
	const { groupId } = message.conversation;
	const key = refKey(message.conversation);
	return queryClient.getQueryData<IConversationSummary[]>(queryKeys.conversations(human))?.find(item => conversationKey(human, item.target) === key)?.name
		?? queryClient.getQueryData<IGroup[]>(queryKeys.groups)?.find(item => item.groupId === groupId)?.name;
}

/** 打开了出错通知时，AI 成员出错停止就发系统通知，点击打开它的时间线。 */
export function useFailureNotifications(): void {
	const enabled = usePreferences(state => state.failureNotifications);
	const states = useMemberStates();
	const members = useMembers();
	const navigate = useNavigate();
	const previous = useRef<Map<string, MemberStatus> | undefined>(undefined);

	useEffect(() => {
		if (!states.data) return;
		const known = previous.current;
		previous.current = new Map([...states.data.values()].map(state => [state.memberId, state.status]));
		// 第一次加载到的是已经出错的成员，不通知。
		if (!known || !enabled || !canNotify()) return;
		for (const state of states.data.values()) {
			if (state.status !== 'failed' || known.get(state.memberId) === 'failed') continue;
			const name = members.data?.find(member => member.memberId === state.memberId)?.name ?? '成员';
			notify(`${name} 因出错停止`, state.error ?? '', `failed-${state.memberId}`, () => navigate(`/members/${state.memberId}`));
		}
	}, [states.data, enabled, members.data, navigate]);
}
