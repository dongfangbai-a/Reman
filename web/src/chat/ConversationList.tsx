import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { conversationKey, conversationPath } from '../api/keys.ts';
import { useMemberStates } from '../api/member.ts';
import { useConversations, useMembers } from '../api/queries.ts';
import type { IConversationSummary, IMember } from '../api/types.ts';
import { listTime } from '../lib/format.ts';
import { usePerspective } from '../perspective/perspective.tsx';
import { draftKey, usePreferences } from '../stores.ts';
import { Avatar, GroupAvatar } from '../ui/Avatar.tsx';
import { CopyMenuItems, groupReference, memberReference } from '../ui/CopyMenuItems.tsx';
import { AiTag, MemberNote } from '../ui/MemberNote.tsx';
import { PointMenu, useMenuTrigger, type IPoint } from '../ui/PointMenu.tsx';
import { keywords, SearchBox } from '../ui/SearchBox.tsx';
import { SelfName } from '../ui/SelfName.tsx';
import { StatusDot } from '../ui/StatusDot.tsx';
import { messagePreview } from './preview.ts';
import { useSearchFocus } from './searchFocus.ts';
import { SearchResults } from './SearchResults.tsx';

/** 对话列表：视角成员私聊过的人和参与过的群聊，最近有消息的在前；上面是搜索框。 */
export function ConversationList() {
	const perspective = usePerspective();
	const conversations = useConversations(perspective.memberId);
	const members = useMembers();
	const params = useParams();
	const memberById = new Map((members.data ?? []).map(member => [member.memberId, member]));
	const [search, setSearch] = useState('');
	const [menu, setMenu] = useState<{ readonly point: IPoint; readonly item: IConversationSummary }>();
	const words = keywords(search);
	const input = useRef<HTMLInputElement>(null);
	const focusRequested = useSearchFocus(state => state.requested);
	useEffect(() => {
		if (!focusRequested) return;
		input.current?.focus();
		input.current?.select();
		useSearchFocus.getState().done();
	}, [focusRequested]);

	const renderItem = (item: IConversationSummary) => {
		const id = item.target.kind === 'direct' ? item.target.memberId : item.target.groupId;
		const selected = params.kind === item.target.kind && params.targetId === id;
		return <ConversationItem key={`${item.target.kind}:${id}`} item={item} selected={selected} memberById={memberById} onMenu={point => setMenu({ point, item })} />;
	};

	return (
		<>
			<div className="shrink-0 px-3 pt-2">
				<SearchBox ref={input} value={search} onChange={setSearch} placeholder="搜索对话和消息" />
			</div>
			{words.length > 0
				? <SearchResults key={perspective.memberId} words={words} conversations={conversations.data ?? []} memberById={memberById} renderConversation={renderItem} />
				: (
					<div className="min-h-0 flex-1 overflow-y-auto py-1">
						{conversations.isError && <div className="px-4 py-3 text-[13px] text-danger">加载失败：{conversations.error.message}</div>}
						{conversations.data?.length === 0 && (
							<div className="px-4 py-6 text-center text-[13px] text-fg-3">{perspective.type === 'human' ? '暂无对话，可点击上方按钮发起私聊' : '暂无对话'}</div>
						)}
						{conversations.data?.map(renderItem)}
					</div>
				)}
			<PointMenu point={menu?.point} onClose={() => setMenu(undefined)}>
				{menu && (menu.item.target.kind === 'direct'
					? <CopyMenuItems reference={memberReference({ name: memberById.get(menu.item.target.memberId)?.name ?? menu.item.name, memberId: menu.item.target.memberId })} id={menu.item.target.memberId} />
					: <CopyMenuItems group reference={groupReference({ name: menu.item.name, groupId: menu.item.target.groupId })} id={menu.item.target.groupId} />)}
			</PointMenu>
		</>
	);
}

/** 对话列表的一项；右键（手机上长按）复制对方或群聊的名字和 ID。 */
function ConversationItem({ item, selected, memberById, onMenu }: { item: IConversationSummary; selected: boolean; memberById: Map<string, IMember>; onMenu: (point: IPoint) => void }) {
	const perspective = usePerspective();
	const trigger = useMenuTrigger(onMenu);
	const states = useMemberStates();
	const draft = usePreferences(state => state.drafts[draftKey(perspective.memberId, conversationKey(perspective.memberId, item.target))]);
	const last = item.lastMessage;
	const peer = item.target.kind === 'direct' ? memberById.get(item.target.memberId) : undefined;
	let preview;
	if (item.mentionCount > 0) {
		preview = <><span className="text-danger">[有人@<SelfName name={perspective.name} />]</span> {last && messagePreview(last, memberById, item.target.kind === 'group')}</>;
	} else if (draft?.text.trim() && !selected) {
		preview = <><span className="text-accent">[草稿]</span> {draft.text}</>;
	} else {
		preview = last ? messagePreview(last, memberById, item.target.kind === 'group') : '暂无消息';
	}
	return (
		<Link
			to={conversationPath(perspective.memberId, item.target)}
			className={clsx('mx-1.5 flex gap-2.5 rounded-lg px-2.5 py-2', selected ? 'bg-selected' : 'hover:bg-hover')}
			{...trigger}
		>
			{item.target.kind === 'direct'
				? (
					<div className="relative shrink-0">
						<Avatar member={memberById.get(item.target.memberId)} size={38} />
						<StatusDot status={states.data?.get(item.target.memberId)?.status} className={clsx('absolute -bottom-0.5 -right-0.5 ring-2', selected ? 'ring-selected' : 'ring-pane')} />
					</div>
				)
				: <GroupAvatar groupId={item.target.groupId} size={38} />}
			<div className="min-w-0 flex-1">
				<div className="flex items-baseline gap-2">
					<AiTag member={peer} />
					<span className={clsx('truncate', peer?.description ? 'max-w-full shrink-0' : 'flex-1', item.unreadCount > 0 && 'font-semibold', item.readonly && 'text-fg-3 line-through')}>{item.name}</span>
					{peer?.description && (
						<>
							<MemberNote member={peer} />
							<span className="flex-1" />
						</>
					)}
					{last && <span className="shrink-0 text-xs text-fg-3">{listTime(last.sentAt)}</span>}
				</div>
				<div className="flex items-center gap-2">
					<span className="flex-1 truncate text-[13px] text-fg-2">{preview}</span>
					{item.unreadCount > 0 && (
						<span className="shrink-0 rounded-full bg-accent px-1.5 text-[11px] font-medium leading-[18px] text-on-accent">
							{item.unreadCount > 99 ? '99+' : item.unreadCount}
						</span>
					)}
				</div>
			</div>
		</Link>
	);
}
