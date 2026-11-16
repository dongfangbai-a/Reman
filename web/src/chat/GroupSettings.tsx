import { useQueryClient } from '@tanstack/react-query';
import { UserPlus } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api/client.ts';
import { queryKeys } from '../api/keys.ts';
import { useMemberStates } from '../api/member.ts';
import { useMembers } from '../api/queries.ts';
import type { IGroup, IGroupMember, IMember } from '../api/types.ts';
import { errorMessage } from '../lib/errors.ts';
import { fullTime } from '../lib/format.ts';
import { MemberPicker } from '../members/MemberPicker.tsx';
import { usePerspective } from '../perspective/perspective.tsx';
import { Avatar, GroupAvatar } from '../ui/Avatar.tsx';
import { Button } from '../ui/Button.tsx';
import { ConfirmDialog, Dialog } from '../ui/Dialog.tsx';
import { SelfName } from '../ui/SelfName.tsx';
import { STATUS_LABELS, StatusDot } from '../ui/StatusDot.tsx';
import { Switch } from '../ui/Switch.tsx';

/**
 * 群聊设置的内容。加人、移出、解散以视角成员的身份去做，只有它是创建者时能做；AI 视角只读，不替 AI 操作。
 * 关注是成员自己的设置，不按视角，任何 AI 成员的都能改（群聊解散后不能改）。
 */
export function GroupDetail({ group }: { group: IGroup }) {
	const perspective = usePerspective();
	const members = useMembers();
	const queryClient = useQueryClient();
	const [dialog, setDialog] = useState<'add' | 'dissolve'>();
	const [error, setError] = useState<string>();
	const [busy, setBusy] = useState(false);
	const memberById = new Map((members.data ?? []).map(member => [member.memberId, member]));
	const owner = memberById.get(group.ownerMemberId);
	const editable = !group.dissolved;
	const manage = editable && perspective.type === 'human' && group.ownerMemberId === perspective.memberId;

	const act = async (method: 'POST' | 'PUT', path: string, body: object, after?: () => void) => {
		setBusy(true);
		setError(undefined);
		try {
			await api(method, `/v1/groups/${group.groupId}${path}`, body);
			await queryClient.invalidateQueries({ queryKey: queryKeys.group(group.groupId) });
			after?.();
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	};
	const requester = { requesterMemberId: perspective.memberId };

	const memberships = [...group.members].sort((left, right) => Number(right.memberId === group.ownerMemberId) - Number(left.memberId === group.ownerMemberId) || left.joinedAt - right.joinedAt);
	const addCandidates = (members.data ?? []).filter(member => !member.deleted && !group.members.some(membership => membership.memberId === member.memberId));
	const ownerName = owner?.memberId === perspective.memberId ? <SelfName name={owner.name} /> : owner?.name ?? '未知成员';

	return (
		<div>
			<div className="flex items-center gap-4">
				<GroupAvatar groupId={group.groupId} size={56} />
				<div className="min-w-0 flex-1">
					<h1 className="truncate text-xl font-semibold">{group.name}</h1>
					<div className="text-[13px] text-fg-3">创建者 {ownerName} · 创建于 {fullTime(group.createdAt).slice(0, 16)} · {group.members.length} 人</div>
				</div>
			</div>
			{group.dissolved && <div className="mt-4 rounded-xl bg-hover px-4 py-3 text-[13px] text-fg-2">该群聊已解散，仅可查看。</div>}
			{editable && !manage && (
				<div className="mt-4 text-[13px] text-fg-3">
					{perspective.type === 'ai'
						? <>正以 <SelfName name={perspective.name} /> 的视角查看，无法代其添加成员、移出成员或解散群聊。</>
						: <>仅创建者 {owner?.name ?? ''} 可以添加成员、移出成员和解散群聊。</>}
				</div>
			)}

			<section className="mt-6 rounded-xl border border-line bg-raised">
				<div className="flex items-center justify-between border-b border-line px-5 py-3">
					<h2 className="font-semibold">成员</h2>
					{manage && <Button onClick={() => setDialog('add')}><UserPlus size={14} />添加成员</Button>}
				</div>
				<div className="divide-y divide-line">
					{memberships.map(membership => (
						<MemberRow
							key={membership.memberId}
							membership={membership}
							member={memberById.get(membership.memberId)}
							self={membership.memberId === perspective.memberId}
							isOwner={membership.memberId === group.ownerMemberId}
							canRemove={manage && membership.memberId !== group.ownerMemberId}
							canWatch={editable}
							busy={busy}
							onRemove={() => void act('POST', '/members', { ...requester, remove: [membership.memberId] })}
							onWatch={watching => void act('PUT', `/members/${membership.memberId}/watching`, { watching })}
						/>
					))}
				</div>
			</section>
			{error && <div className="mt-2 text-[13px] text-danger">操作失败：{error}</div>}
			{manage && (
				<div className="mt-6 flex justify-end">
					<Button className="text-danger" onClick={() => setDialog('dissolve')}>解散群聊</Button>
				</div>
			)}

			{dialog === 'add' && (
				<AddMembersDialog
					open
					onOpenChange={open => setDialog(open ? 'add' : undefined)}
					candidates={addCandidates}
					busy={busy}
					error={dialog === 'add' ? error : undefined}
					onAdd={add => void act('POST', '/members', { ...requester, add }, () => setDialog(undefined))}
				/>
			)}
			<ConfirmDialog
				open={dialog === 'dissolve'}
				onOpenChange={open => setDialog(open ? 'dissolve' : undefined)}
				title={`解散「${group.name}」？`}
				detail="解散后，所有成员均无法再在该群中发送消息，聊天记录将保留。"
				confirmLabel="解散"
				busy={busy}
				error={dialog === 'dissolve' ? error : undefined}
				onConfirm={() => void act('POST', '/dissolve', requester, () => setDialog(undefined))}
			/>
		</div>
	);
}

function MemberRow({ membership, member, self, isOwner, canRemove, canWatch, busy, onRemove, onWatch }: {
	membership: IGroupMember;
	member: IMember | undefined;
	/** 视角成员自己。 */
	self: boolean;
	isOwner: boolean;
	canRemove: boolean;
	canWatch: boolean;
	busy: boolean;
	onRemove: () => void;
	onWatch: (watching: boolean) => void;
}) {
	const states = useMemberStates();
	const status = member?.type === 'ai' ? states.data?.get(membership.memberId)?.status : undefined;
	return (
		<div className="flex items-center gap-3 px-5 py-2.5">
			<div className="relative shrink-0">
				<Avatar member={member} size={32} />
				<StatusDot status={status} className="absolute -bottom-0.5 -right-0.5 size-2 ring-2 ring-raised" />
			</div>
			<div className="min-w-0 flex-1">
				<Link to={member?.type === 'ai' ? `/members/${membership.memberId}` : `/as/${membership.memberId}`} className="truncate text-[13px] font-medium hover:text-accent hover:underline">
					{self && member ? <SelfName name={member.name} /> : member?.name ?? '未知成员'}
				</Link>
				<div className="text-xs text-fg-3">
					{member?.type === 'ai' ? 'AI' : '真人'}{isOwner && ' · 创建者'}{status && status !== 'idle' && ` · ${STATUS_LABELS[status]}`}
				</div>
			</div>
			{member?.type === 'ai' && (
				<label className="flex items-center gap-2 text-xs text-fg-2" title="关注后，群中任何成员发言都会唤醒该成员，无需点名">
					关注
					<Switch checked={membership.watching} label={`${member.name} 关注该群聊`} disabled={!canWatch || busy} onChange={onWatch} />
				</label>
			)}
			{canRemove && <Button disabled={busy} onClick={onRemove}>移出</Button>}
		</div>
	);
}

function AddMembersDialog({ open, onOpenChange, candidates, busy, error, onAdd }: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	candidates: readonly IMember[];
	busy: boolean;
	error: string | undefined;
	onAdd: (memberIds: string[]) => void;
}) {
	const [selected, setSelected] = useState<string[]>([]);
	return (
		<Dialog open={open} onOpenChange={onOpenChange} title="添加成员" width="w-[460px]">
			<MemberPicker candidates={candidates} selected={selected} onChange={setSelected} />
			{error && <div className="mt-3 text-[13px] text-danger">{error}</div>}
			<div className="mt-4 flex justify-end">
				<Button variant="primary" disabled={busy || selected.length === 0} onClick={() => onAdd(selected)}>添加 {selected.length > 0 ? `${selected.length} 人` : ''}</Button>
			</div>
		</Dialog>
	);
}
