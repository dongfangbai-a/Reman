import * as Popover from '@radix-ui/react-popover';
import clsx from 'clsx';
import { Check, ChevronDown, MessagesSquare, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useMemberStates } from '../api/member.ts';
import { useGroup, useMemberOverview, useMembers } from '../api/queries.ts';
import type { IMember } from '../api/types.ts';
import { ConversationList } from '../chat/ConversationList.tsx';
import { NewDirectButton } from '../chat/NewDirect.tsx';
import { CollapseListButton } from '../layout/CollapseListButton.tsx';
import { HEADER_RIGHT } from '../layout/PanelToggles.tsx';
import { Avatar } from '../ui/Avatar.tsx';
import { IconButton } from '../ui/Button.tsx';
import { MemberNote } from '../ui/MemberNote.tsx';
import { keywords, matchesAll } from '../ui/SearchBox.tsx';
import { SelfName } from '../ui/SelfName.tsx';
import { StatusDot } from '../ui/StatusDot.tsx';
import { NewGroupDialog } from './NewGroupDialog.tsx';
import { usePerspectiveEntry, useUnreadJump } from './notifyHumans.ts';
import { usePerspective } from './perspective.tsx';

/** 视角页的列表栏：第一行是视角切换、新建私聊和群聊（真人视角才有），下面是这个成员的对话。 */
export function PerspectiveList() {
	const perspective = usePerspective();
	const [newGroup, setNewGroup] = useState(false);
	return (
		<aside className="flex min-h-0 w-full flex-1 flex-col border-r border-line bg-pane">
			<header className={clsx('flex h-12 shrink-0 items-center gap-0.5 border-b border-line pl-2', HEADER_RIGHT)}>
				<PerspectiveSwitcher />
				<JumpBackButton />
				{perspective.type === 'human' && <NewDirectButton />}
				{perspective.type === 'human' && <IconButton label="新建群聊" onClick={() => setNewGroup(true)}><MessagesSquare size={17} /></IconButton>}
				<CollapseListButton />
			</header>
			<ConversationList key={perspective.memberId} />
			{perspective.type === 'human' && <NewGroupDialog open={newGroup} onOpenChange={setNewGroup} />}
		</aside>
	);
}

/**
 * 点「视角」跳去看未读以后，回到跳之前的视角和对话：返回箭头加原来视角的名字，悬停写全。点了就去掉；换到别的视角时也去掉（useTrackUnreadJump）。
 */
function JumpBackButton() {
	const perspective = usePerspective();
	const jump = useUnreadJump(state => state.jump);
	const members = useMembers();
	const navigate = useNavigate();
	const active = jump !== undefined && jump.perspectiveId === perspective.memberId;
	const conversation = active ? /\/(direct|group)\/([^/]+)$/.exec(jump.back.path) : null;
	const group = useGroup(conversation?.[1] === 'group' ? conversation[2] : undefined);
	const back = active ? members.data?.find(member => member.memberId === jump.back.perspectiveId) : undefined;
	if (!jump || !back) return null;
	const peer = conversation?.[1] === 'direct' ? members.data?.find(member => member.memberId === conversation[2])?.name : undefined;
	const where = !conversation ? '' : conversation[1] === 'direct' ? `，与 ${peer ?? '未知成员'} 的私聊` : `，群聊「${group.data?.name ?? conversation[2]}」`;
	return (
		<button
			type="button"
			title={`返回 ${back.name} 的视角${where}`}
			onClick={() => {
				useUnreadJump.setState({ jump: undefined, arrived: false });
				navigate(jump.back.path);
			}}
			className="flex h-7 min-w-0 max-w-28 shrink items-center gap-1 rounded-md px-1.5 text-xs text-fg-2 hover:bg-hover hover:text-fg"
		>
			<Undo2 size={14} className="shrink-0" />
			<span className="truncate">{back.name}</span>
		</button>
	);
}

/** 当前视角：点开选别的成员。真人在前，写它的未读数；AI 在后，标「只读」；已删除的 AI 排在最后，名字灰色。 */
function PerspectiveSwitcher() {
	const perspective = usePerspective();
	const members = useMembers();
	const overview = useMemberOverview();
	const states = useMemberStates();
	const navigate = useNavigate();
	const entry = usePerspectiveEntry();
	const [open, setOpen] = useState(false);
	const [search, setSearch] = useState('');
	const words = keywords(search);
	const matched = (members.data ?? []).filter(member => !member.purged && matchesAll(`${member.name} ${member.description}`, words));
	const byName = (left: IMember, right: IMember) => left.name.localeCompare(right.name, 'zh-CN');
	const humans = matched.filter(member => member.type === 'human').sort((left, right) => left.createdAt - right.createdAt);
	const ais = matched.filter(member => member.type === 'ai' && !member.deleted).sort(byName);
	const deleted = matched.filter(member => member.type === 'ai' && member.deleted).sort(byName);

	const choose = (member: IMember) => {
		setOpen(false);
		// 打开那个视角上次打开的对话：去看完别的视角的未读再换回来，对话还在原处。
		if (member.memberId !== perspective.memberId) navigate(entry(member.memberId));
	};
	const item = (member: IMember) => {
		const info = overview.data?.get(member.memberId);
		const unread = info?.type === 'human' ? info.unreadCount : 0;
		return (
			<button
				key={member.memberId}
				type="button"
				onClick={() => choose(member)}
				className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-hover"
			>
				<span className="relative shrink-0">
					<Avatar member={member} size={22} className={clsx(member.deleted && 'opacity-60')} />
					{!member.deleted && <StatusDot status={states.data?.get(member.memberId)?.status} className="absolute -bottom-0.5 -right-0.5 size-2 ring-2 ring-raised" />}
				</span>
				<span className={clsx('shrink-0 truncate', member.deleted && 'text-fg-3', member.description ? 'max-w-[60%]' : 'flex-1')}>{member.name}</span>
				<MemberNote member={member} />
				{member.description && <span className="flex-1" />}
				{member.type === 'ai' && <span className="shrink-0 text-xs text-fg-3">只读</span>}
				{unread > 0 && <span className="shrink-0 rounded-full bg-accent px-1.5 text-[11px] font-medium leading-[18px] text-on-accent">{unread > 99 ? '99+' : unread}</span>}
				{member.memberId === perspective.memberId && <Check size={14} className="shrink-0 text-accent" />}
			</button>
		);
	};

	return (
		<Popover.Root open={open} onOpenChange={next => {
			setOpen(next);
			setSearch('');
		}}>
			<Popover.Trigger asChild>
				<button type="button" title="切换视角" className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-hover">
					<Avatar member={perspective} size={24} />
					<span className="min-w-0 truncate"><SelfName name={perspective.name} /></span>
					{perspective.type === 'ai' && <span className="shrink-0 text-xs text-fg-3">只读</span>}
					<ChevronDown size={14} className="shrink-0 text-fg-3" />
				</button>
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content align="start" sideOffset={6} className="z-50 w-72 rounded-lg border border-line bg-raised p-1 shadow-lg">
					<input
						autoFocus
						value={search}
						onChange={event => setSearch(event.target.value)}
						placeholder="搜索成员"
						className="mb-1 h-8 w-full rounded-md border border-line bg-page px-2 text-[13px] outline-none focus:border-accent"
					/>
					<div className="max-h-96 overflow-y-auto">
						{matched.length === 0 && <div className="px-2 py-3 text-center text-[13px] text-fg-3">无匹配的成员</div>}
						{humans.map(item)}
						{humans.length > 0 && ais.length + deleted.length > 0 && <div className="my-1 h-px bg-line" />}
						{ais.map(item)}
						{deleted.length > 0 && <div className="px-2 pb-0.5 pt-2 text-xs text-fg-3">已删除</div>}
						{deleted.map(item)}
					</div>
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}
