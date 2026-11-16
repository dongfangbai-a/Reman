import * as Popover from '@radix-ui/react-popover';
import { MessageSquarePlus } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { conversationPath } from '../api/keys.ts';
import { useMembers } from '../api/queries.ts';
import { usePerspective } from '../perspective/perspective.tsx';
import { Avatar } from '../ui/Avatar.tsx';
import { IconButton } from '../ui/Button.tsx';
import { MemberNote } from '../ui/MemberNote.tsx';
import { Highlighted, keywords, matchesAll } from '../ui/SearchBox.tsx';

/** 新建私聊：选一个成员，打开空的对话，发出第一条消息后才出现在列表里。 */
export function NewDirectButton() {
	const perspective = usePerspective();
	const members = useMembers();
	const navigate = useNavigate();
	const [open, setOpen] = useState(false);
	const [filter, setFilter] = useState('');
	const words = keywords(filter);
	const candidates = (members.data ?? [])
		.filter(member => !member.deleted && member.memberId !== perspective.memberId)
		.filter(member => matchesAll(`${member.name} ${member.description}`, words))
		.sort((left, right) => (left.type === right.type ? left.name.localeCompare(right.name, 'zh-CN') : left.type === 'ai' ? -1 : 1));

	return (
		<Popover.Root open={open} onOpenChange={next => {
			setOpen(next);
			setFilter('');
		}}>
			<Popover.Trigger asChild>
				<IconButton label="发起私聊"><MessageSquarePlus size={18} /></IconButton>
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content align="start" sideOffset={6} className="z-50 w-64 rounded-lg border border-line bg-raised p-1 shadow-lg">
					<input
						autoFocus
						value={filter}
						onChange={event => setFilter(event.target.value)}
						placeholder="搜索成员"
						className="mb-1 h-8 w-full rounded-md border border-line bg-page px-2 text-[13px] outline-none focus:border-accent"
					/>
					<div className="max-h-80 overflow-y-auto">
						{candidates.length === 0 && <div className="px-2 py-3 text-center text-[13px] text-fg-3">暂无可私聊的成员</div>}
						{candidates.map(member => (
							<button
								key={member.memberId}
								type="button"
								onClick={() => {
									setOpen(false);
									navigate(conversationPath(perspective.memberId, { kind: 'direct', memberId: member.memberId }));
								}}
								className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-hover"
							>
								<Avatar member={member} size={22} />
								<span className="flex min-w-0 flex-1 items-baseline gap-1.5">
									<span className="shrink-0"><Highlighted text={member.name} words={words} /></span>
									<MemberNote member={member}><Highlighted text={member.description} words={words} /></MemberNote>
								</span>
								<span className="text-xs text-fg-3">{member.type === 'ai' ? 'AI' : '真人'}</span>
							</button>
						))}
					</div>
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}
