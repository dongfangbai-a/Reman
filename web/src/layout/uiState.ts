import { create } from 'zustand';
import { useOptionalPerspective } from '../perspective/perspective.tsx';
import { usePreferences } from '../stores.ts';

/** 成员相关的弹窗，各页都能打开：成员设置、新建 AI 成员、新建真人、新建分组（可以顺便把一个成员加进去）。 */
export type MemberDialog =
	| { readonly kind: 'settings'; readonly memberId: string }
	| { readonly kind: 'newAi' }
	| { readonly kind: 'newHuman' }
	| { readonly kind: 'newSection'; readonly addMemberId?: string };

export const useMemberDialog = create<{ dialog: MemberDialog | undefined }>(() => ({ dialog: undefined }));

export function openMemberDialog(dialog: MemberDialog | undefined): void {
	useMemberDialog.setState({ dialog });
}

/**
 * 功能区要知道的，只在内存里：
 * - center：成员页中间正在看的成员，概况栏把它的待处理排在前面、显示它的计划；
 * - conversationTimeline：视角页里时间线一栏该显示的成员，由打开的对话决定。
 */
export const useFocus = create<{ center: string | undefined; conversationTimeline: string | undefined }>(() => ({ center: undefined, conversationTimeline: undefined }));

/**
 * 视角页里时间线一栏显示的成员：打开的对话决定显示谁（私聊的 AI 对方、群聊里点过的成员）；没有时，AI 视角显示它自己的。
 * 不在视角页时是 undefined。时间线一栏关着时也照样算，用的地方自己看开没开。
 */
export function useTimelineColumnMember(): string | undefined {
	const perspective = useOptionalPerspective();
	const conversationTimeline = useFocus(state => state.conversationTimeline);
	return conversationTimeline ?? (perspective?.type === 'ai' ? perspective.memberId : undefined);
}

/** 打开时间线一栏（视角页），换掉工作台。 */
export function openTimelineColumn(): void {
	usePreferences.getState().set({ timelineOpen: true, workbenchOpen: false, workbenchMaximized: false });
}
