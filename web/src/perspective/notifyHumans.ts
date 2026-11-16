import { useEffect, useMemo } from 'react';
import { create } from 'zustand';
import { conversationPath } from '../api/keys.ts';
import { useConversations, useMemberOverview, useMembers } from '../api/queries.ts';
import type { IConversationSummary, IMember } from '../api/types.ts';
import { useIsPhone } from '../lib/media.ts';
import { usePreferences } from '../stores.ts';

/** 第一个真人：第一次打开时建的，就是使用者自己。 */
export function firstHuman(members: readonly IMember[]): IMember | undefined {
	return members.filter(member => member.type === 'human').reduce<IMember | undefined>((first, member) => !first || member.createdAt < first.createdAt ? member : first, undefined);
}

/** 要提醒的真人：设置里勾的；没选过时只有第一个真人。 */
export function notifyHumanIds(members: readonly IMember[], chosen: readonly string[] | undefined): ReadonlySet<string> {
	if (chosen) return new Set(chosen.filter(id => members.some(member => member.memberId === id && member.type === 'human')));
	const first = firstHuman(members);
	return new Set(first ? [first.memberId] : []);
}

export function useNotifyHumans(): ReadonlySet<string> {
	const members = useMembers();
	const chosen = usePreferences(state => state.notifyHumans);
	return useMemo(() => notifyHumanIds(members.data ?? [], chosen), [members.data, chosen]);
}

/** 要提醒的真人的未读加起来：图标栏「视角」上的角标、标签页标题里的数字。 */
export function useNotifyUnread(): number {
	const notify = useNotifyHumans();
	const overview = useMemberOverview();
	let unread = 0;
	for (const memberId of notify) {
		const item = overview.data?.get(memberId);
		if (item?.type === 'human') unread += item.unreadCount;
	}
	return unread;
}

/** 有未读的要提醒的真人，最近一条未读最新的在前。 */
export function useUnreadHumans(): readonly string[] {
	const notify = useNotifyHumans();
	const overview = useMemberOverview();
	return useMemo(() => {
		const humans: { memberId: string; at: number }[] = [];
		for (const memberId of notify) {
			const item = overview.data?.get(memberId);
			if (item?.type === 'human' && item.unreadCount > 0) humans.push({ memberId, at: item.lastUnreadAt ?? 0 });
		}
		return humans.sort((left, right) => right.at - left.at).map(human => human.memberId);
	}, [notify, overview.data]);
}

/**
 * 进某个视角的地址：打开这个视角上次打开的对话，没有时是它的首页。
 * 手机上列表和内容一次只显示一个，进视角就是进它的对话列表。
 */
export function usePerspectiveEntry(): (perspectiveId: string) => string {
	const phone = useIsPhone();
	const remembered = usePreferences(state => state.perspectiveConversations);
	return perspectiveId => {
		const conversation = phone ? undefined : remembered[perspectiveId];
		return conversation ? `/as/${perspectiveId}/${conversation}` : `/as/${perspectiveId}`;
	};
}

/** 点「视角」跳去看未读之前在哪：跳到的视角，和原来的视角、地址。视角页列表栏顶部据此显示返回按钮；只在这次打开网页期间有。 */
export interface IUnreadJump {
	readonly perspectiveId: string;
	readonly back: { readonly perspectiveId: string; readonly path: string };
}

export const useUnreadJump = create<{ jump: IUnreadJump | undefined; arrived: boolean }>(() => ({ jump: undefined, arrived: false }));

/**
 * 跳过去以后，换到别的视角时去掉返回记录。点「视角」时地址还没换，先等到了跳去的视角（arrived），再看有没有换到别的视角；去成员页、设置页不算。
 * 在 Shell 里调用：手机上看对话时列表栏不在，也要跟着视角变。
 */
export function useTrackUnreadJump(perspectiveId: string | undefined): void {
	const jump = useUnreadJump(state => state.jump);
	const arrived = useUnreadJump(state => state.arrived);
	useEffect(() => {
		if (!jump || !perspectiveId) return;
		if (perspectiveId === jump.perspectiveId) {
			if (!arrived) useUnreadJump.setState({ arrived: true });
		} else if (arrived) {
			useUnreadJump.setState({ jump: undefined, arrived: false });
		}
	}, [jump, arrived, perspectiveId]);
}

/**
 * 从图标栏进视角页：去哪个视角由未读决定，打开哪个对话由上次的位置决定。
 * 上次用的视角（第一次用第一个真人）本来就是有未读的要提醒的真人、或者没有未读时，回到它上次打开的对话；
 * 未读在别的真人那里时，切到那个真人的视角（几个都有时用最近一条未读最新的），直接打开它最新一条未读所在的对话。
 * jump 是跳去看未读时的记录，点下去时记下，给返回按钮用；不跳时是 undefined。
 */
export function usePerspectiveTarget(): { path: string; jump: IUnreadJump | undefined } {
	const members = useMembers();
	const last = usePreferences(state => state.perspectiveId);
	const unread = useUnreadHumans();
	const entry = usePerspectiveEntry();
	const phone = useIsPhone();
	const list = members.data ?? [];
	const member = list.find(item => item.memberId === last && !item.purged) ?? firstHuman(list);
	const target = unread.length > 0 && !(member && unread.includes(member.memberId)) ? unread[0] : undefined;
	const conversations = useConversations(target && !phone ? target : undefined);
	if (target) {
		const latest = latestUnread(conversations.data ?? []);
		return {
			path: latest ? conversationPath(target, latest.target) : entry(target),
			jump: member ? { perspectiveId: target, back: { perspectiveId: member.memberId, path: entry(member.memberId) } } : undefined,
		};
	}
	return { path: member ? entry(member.memberId) : '/', jump: undefined };
}

/** 最新一条未读所在的对话。 */
function latestUnread(conversations: readonly IConversationSummary[]): IConversationSummary | undefined {
	return conversations
		.filter(conversation => conversation.unreadCount > 0)
		.reduce<IConversationSummary | undefined>((latest, conversation) => !latest || (conversation.lastMessage?.sentAt ?? 0) > (latest.lastMessage?.sentAt ?? 0) ? conversation : latest, undefined);
}
