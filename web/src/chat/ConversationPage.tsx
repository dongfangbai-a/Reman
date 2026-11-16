import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Settings } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Navigate, useParams } from 'react-router';
import { api } from '../api/client.ts';
import { conversationKey, queryKeys, sameTarget } from '../api/keys.ts';
import { useMemberStates } from '../api/member.ts';
import { useConversations, useGroup, useMembers } from '../api/queries.ts';
import type { ConversationTarget, IGroup, IMemberState, IMember, MemberStatus } from '../api/types.ts';
import { HEADER_RIGHT } from '../layout/PanelToggles.tsx';
import { openMemberDialog, openTimelineColumn, useFocus } from '../layout/uiState.ts';
import { errorMessage } from '../lib/errors.ts';
import { usePerspective } from '../perspective/perspective.tsx';
import { draftKey } from '../stores.ts';
import { Avatar, GroupAvatar } from '../ui/Avatar.tsx';
import { BackButton } from '../ui/BackLink.tsx';
import { IconButton } from '../ui/Button.tsx';
import { AiTag, MemberNote } from '../ui/MemberNote.tsx';
import { SelfName } from '../ui/SelfName.tsx';
import { StatusDot } from '../ui/StatusDot.tsx';
import { ActivityBar } from './ActivityBar.tsx';
import { Composer, DropHint, useFileDrop, type IComposerHandle, type IOutgoing } from './Composer.tsx';
import { DirectoryPill } from './DirectoryPill.tsx';
import { GroupSettingsDialog } from './GroupSettingsDialog.tsx';
import { MessageList, type IPendingMessage } from './MessageList.tsx';
import { ModelPill } from './ModelPill.tsx';

/** 视角页中间的私聊或群聊：顶部、消息列表、输入框。 */
export function ConversationPage() {
	const { perspectiveId, kind, targetId } = useParams();
	if (!targetId || (kind !== 'direct' && kind !== 'group')) return <Navigate to={`/as/${perspectiveId}`} replace />;
	const target: ConversationTarget = kind === 'direct' ? { kind, memberId: targetId } : { kind, groupId: targetId };
	return <Conversation key={`${kind}:${targetId}`} target={target} />;
}

function Conversation({ target }: { target: ConversationTarget }) {
	const perspective = usePerspective();
	const queryClient = useQueryClient();
	const members = useMembers();
	const group = useGroup(target.kind === 'group' ? target.groupId : undefined);
	const conversations = useConversations(perspective.memberId);
	const composer = useRef<IComposerHandle>(null);
	const [pending, setPending] = useState<readonly IPendingMessage[]>([]);
	const states = useMemberStates();
	/** 在这个对话里点过的成员（群聊的头像、运行状态行），右边的时间线显示它。 */
	const [picked, setPicked] = useState<string>();
	const [groupSettings, setGroupSettings] = useState(false);

	// 成员表和打开时间线的回调不跟着渲染变：消息列表里的每条消息据此跳过重画。
	const memberById = useMemo(() => new Map((members.data ?? []).map(member => [member.memberId, member])), [members.data]);
	const key = conversationKey(perspective.memberId, target);
	const summary = conversations.data?.find(item => sameTarget(item.target, target));
	const peer = target.kind === 'direct' ? memberById.get(target.memberId) : undefined;
	const readonlyReason = perspective.type !== 'human'
		? <>正以 <SelfName name={perspective.name} /> 的视角查看，无法发送消息</>
		: blockedReason(perspective, target, peer, group.data);

	const deliver = async (message: IPendingMessage) => {
		setPending(list => list.map(item => item.localId === message.localId ? { ...item, error: undefined } : item));
		try {
			await api('POST', '/v1/messages', {
				senderMemberId: perspective.memberId,
				target,
				text: message.outgoing.text,
				mentions: message.outgoing.mentions,
				attachments: message.outgoing.attachments.map(item => item.attachmentId),
			});
			await queryClient.invalidateQueries({ queryKey: queryKeys.messages(perspective.memberId, key) });
			setPending(list => list.filter(item => item.localId !== message.localId));
		} catch (error) {
			setPending(list => list.map(item => item.localId === message.localId ? { ...item, error: errorMessage(error) } : item));
		}
	};
	const send = (outgoing: IOutgoing) => {
		const message: IPendingMessage = { localId: crypto.randomUUID(), outgoing, sentAt: Date.now(), error: undefined };
		setPending(list => [...list, message]);
		void deliver(message);
	};
	const restore = (message: IPendingMessage) => {
		setPending(list => list.filter(item => item.localId !== message.localId));
		composer.current?.restore(message.outgoing);
	};

	const aiPeer = peer?.type === 'ai';
	// 右边时间线一栏显示谁：点过的成员；私聊时对方是 AI 就是对方，对方是真人而视角是 AI 时是这个 AI 自己；群聊没点过时，AI 视角显示自己的。
	const timelineMemberId = picked ?? (aiPeer ? peer.memberId : perspective.type === 'ai' ? perspective.memberId : undefined);
	useEffect(() => {
		useFocus.setState({ conversationTimeline: timelineMemberId });
		return () => useFocus.setState({ conversationTimeline: undefined });
	}, [timelineMemberId]);
	const openTimeline = useCallback((memberId: string) => {
		setPicked(memberId);
		openTimelineColumn();
	}, []);
	const openSettings = () => {
		if (peer) openMemberDialog({ kind: 'settings', memberId: peer.memberId });
		else setGroupSettings(true);
	};

	const settingsLabel = target.kind === 'direct' ? '成员设置' : '群聊设置';
	const title = target.kind === 'direct' ? peer?.name ?? summary?.name ?? '' : group.data?.name ?? summary?.name ?? '';
	const mentionCandidates = target.kind === 'group'
		? (group.data?.members ?? []).map(membership => memberById.get(membership.memberId)).filter((member): member is IMember => !!member && member.memberId !== perspective.memberId)
		: undefined;
	const drop = useFileDrop(files => composer.current?.addFiles(files), readonlyReason === undefined);

	return (
		<div className="relative flex h-full min-w-0 flex-col" {...drop.handlers}>
			{target.kind === 'group' && <GroupSettingsDialog groupId={target.groupId} open={groupSettings} onOpenChange={setGroupSettings} />}
			<header className={clsx('@container flex h-12 shrink-0 items-center gap-2.5 border-b border-line pl-4 md:pl-5', HEADER_RIGHT)}>
				<BackButton to={`/as/${perspective.memberId}`} />
				{target.kind === 'direct'
					? (
						<div className="relative shrink-0">
							<Avatar member={peer} size={26} />
							<StatusDot status={states.data?.get(target.memberId)?.status} className="absolute -bottom-0.5 -right-0.5 size-2 ring-2 ring-page" />
						</div>
					)
					: <GroupAvatar groupId={target.groupId} size={26} />}
				<AiTag member={peer} />
				<span className={clsx('truncate font-semibold', target.kind === 'direct' && 'shrink-0')}>{title}</span>
				<MemberNote member={peer} className="text-[13px]" />
				{aiPeer && !peer.deleted && <span className="flex min-w-0 @max-[30rem]:hidden"><ModelPill member={peer} onOpenSettings={openSettings} /></span>}
				{aiPeer && !peer.deleted && <DirectoryPill member={peer} onOpenSettings={openSettings} />}
				{group.data && <span className="shrink-0 text-[13px] text-fg-3">{group.data.members.length} 人</span>}
				{group.data && <GroupStatusSummary memberIds={group.data.members.map(membership => membership.memberId)} states={states.data} />}
				<div className="flex-1" />
				{(peer || group.data) && <IconButton label={settingsLabel} onClick={openSettings}><Settings size={17} /></IconButton>}
			</header>
			<MessageList
				target={target}
				memberById={memberById}
				pending={pending}
				onRetry={message => void deliver(message)}
				onRestore={restore}
				onOpenTimeline={openTimeline}
			/>
			<ActivityBar
				memberIds={target.kind === 'direct' ? [target.memberId, perspective.memberId] : (group.data?.members ?? []).map(membership => membership.memberId)}
				memberById={memberById}
				onOpenTimeline={openTimeline}
			/>
			{readonlyReason === undefined
				? (
					<Composer
						key={key}
						ref={composer}
						draftKey={draftKey(perspective.memberId, key)}
						placeholder={`发送给 ${title}`}
						mentionCandidates={mentionCandidates}
						className="center-column px-5 pb-4 pt-1"
						onSend={send}
					/>
				)
				: <div className="border-t border-line px-5 py-3 text-center text-[13px] text-fg-3">{readonlyReason}</div>}
			{drop.dragging && <DropHint />}
		</div>
	);
}

const SUMMARY_ORDER: readonly [MemberStatus, string][] = [['running', '运行中'], ['waiting_approval', '等待审批'], ['failed', '出错'], ['interrupted', '已中断'], ['paused', '已暂停']];

/** 群聊顶部的成员状态汇总，如「2 人运行中 · 1 人出错」。 */
function GroupStatusSummary({ memberIds, states }: { memberIds: readonly string[]; states: Map<string, IMemberState> | undefined }) {
	const counts = new Map<MemberStatus, number>();
	for (const memberId of memberIds) {
		const status = states?.get(memberId)?.status;
		if (status) counts.set(status, (counts.get(status) ?? 0) + 1);
	}
	const parts = SUMMARY_ORDER.filter(([status]) => counts.get(status)).map(([status, label]) => (
		<span key={status} className={clsx('flex items-center gap-1', status === 'failed' && 'text-danger')}>
			<StatusDot status={status} className="size-2" />{counts.get(status)} 人{label}
		</span>
	));
	if (parts.length === 0) return null;
	return <span className="flex items-center gap-2 text-xs text-fg-3 @max-[30rem]:hidden">{parts}</span>;
}

/** 真人视角不能在这个对话里发消息的原因；能发时为 undefined。 */
function blockedReason(perspective: IMember, target: ConversationTarget, peer: IMember | undefined, group: IGroup | undefined): ReactNode {
	if (target.kind === 'direct') {
		if (target.memberId === perspective.memberId) return '无法与自己私聊';
		if (!peer) return undefined;
		return peer.deleted ? `${peer.name} 已被删除，仅可查看` : undefined;
	}
	if (!group) return undefined;
	if (group.dissolved) return '群聊已解散，仅可查看';
	if (!group.members.some(membership => membership.memberId === perspective.memberId)) return <><SelfName name={perspective.name} /> 已不在该群聊中，仅可查看</>;
	return undefined;
}
