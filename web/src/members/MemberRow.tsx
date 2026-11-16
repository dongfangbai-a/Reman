import clsx from 'clsx';
import { CircleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { IGroup, IMemberFolderState, IMemberState, IMember, MemberOverview, MemberResult } from '../api/types.ts';
import { StepText, useStep } from '../chat/activity.tsx';
import { dayTime, firstLine, listTime } from '../lib/format.ts';
import { usePerspectiveEntry } from '../perspective/notifyHumans.ts';
import { Avatar } from '../ui/Avatar.tsx';
import { AiTag, MemberNote } from '../ui/MemberNote.tsx';
import { useMenuTrigger, type IPoint } from '../ui/PointMenu.tsx';
import { Highlighted } from '../ui/SearchBox.tsx';
import { StatusDot } from '../ui/StatusDot.tsx';

/**
 * 成员列表的一行，样子和对话列表一样：头像带状态圆点；第一行是 AI 标签、名字、备注、时间；第二行是预览，右边是角标。
 * 右键打开菜单，手机上长按。
 */
export function MemberRow({ member, overview, state, pending, folder, notify, words, selected, memberById, groupById, onMenu }: {
	member: IMember;
	overview: MemberOverview | undefined;
	state: IMemberState | undefined;
	/** 要你处理的数：待审批和它的接管请求。 */
	pending: number;
	folder: IMemberFolderState | undefined;
	/** 是要提醒的真人：第二行写它的未读。 */
	notify: boolean;
	words: readonly string[];
	selected: boolean;
	memberById: Map<string, IMember>;
	groupById: Map<string, IGroup>;
	onMenu: (point: IPoint) => void;
}) {
	const step = useStep(member.memberId, state);
	const trigger = useMenuTrigger(onMenu);
	const entry = usePerspectiveEntry();
	const unread = overview?.type === 'human' && notify && overview.unreadCount > 0 ? overview : undefined;
	const note = <MemberNote member={member}><Highlighted text={member.description} words={words} /></MemberNote>;

	let preview: ReactNode;
	let time: number | null = null;
	let badges: ReactNode = null;
	if (overview?.type === 'ai') {
		time = overview.lastActivityAt;
		if (step) preview = <span className={clsx(step.waiting && 'text-attention')}><StepText step={step} /></span>;
		else if (state?.status === 'failed') preview = <span className="text-danger">{firstLine(state.error ?? '因出错停止')}</span>;
		else if (overview.lastResult) preview = resultText(overview.lastResult, memberById, groupById);
		badges = (
			<>
				{pending > 0 && <span className="shrink-0 rounded-full bg-attention px-1.5 text-[11px] font-medium leading-[18px] text-white dark:text-black" title="待处理">{pending > 99 ? '99+' : pending}</span>}
				{overview.hasNewResult && <span className="size-2 shrink-0 rounded-full bg-accent" title="有新的结果" />}
			</>
		);
	} else if (unread) {
		time = unread.lastUnreadAt;
		preview = <span className={clsx(unread.mentionCount > 0 && 'text-danger')}>{unread.unreadCount} 条未读</span>;
	} else {
		preview = note;
	}
	// 第二行写备注时，第一行就不再写。
	const noteInFirstLine = member.type === 'ai' || !!unread;

	return (
		<div className="mx-1.5" {...trigger}>
			<Link
				// 真人进它的视角，打开这个视角上次打开的对话。
				to={member.type === 'ai' ? `/members/${member.memberId}` : entry(member.memberId)}
				className={clsx('flex gap-2.5 rounded-lg px-2.5 py-2', selected ? 'bg-selected' : 'hover:bg-hover')}
			>
				<div className="relative shrink-0">
					<Avatar member={member} size={38} />
					<StatusDot status={state?.status} className={clsx('absolute -bottom-0.5 -right-0.5 ring-2', selected ? 'ring-selected' : 'ring-pane')} />
				</div>
				<div className="min-w-0 flex-1">
					<div className="flex items-baseline gap-2">
						<AiTag member={member} />
						<span className={clsx('truncate', noteInFirstLine && member.description ? 'max-w-full shrink-0' : 'flex-1', unread && 'font-semibold')}>
							<Highlighted text={member.name} words={words} />
						</span>
						{folder && folder.status !== 'ok' && (
							<CircleAlert size={13} className={clsx('shrink-0 self-center', folder.status === 'error' ? 'text-danger' : 'text-warning')} aria-label={folder.status === 'error' ? '配置有误' : '配置存在警告'} />
						)}
						{noteInFirstLine && member.description && (
							<>
								{note}
								<span className="flex-1" />
							</>
						)}
						{time !== null && <span className="shrink-0 text-xs text-fg-3">{listTime(time)}</span>}
					</div>
					<div className="flex min-h-[18px] items-center gap-2">
						<span className="min-w-0 flex-1 truncate text-[13px] text-fg-2">{preview}</span>
						{badges}
					</div>
				</div>
			</Link>
		</div>
	);
}

/**
 * 已删除的 AI 成员：头像、名字（灰色）、备注、删除时间。备注和上面成员第一行里的一样，放不下时先截断备注：
 * 找回已删除的成员时记得的多半是它负责什么，搜索也按备注找。
 */
export function DeletedMemberRow({ member, words, selected, onMenu }: { member: IMember; words: readonly string[]; selected: boolean; onMenu: (point: IPoint) => void }) {
	const trigger = useMenuTrigger(onMenu);
	return (
		<div className="mx-1.5" {...trigger}>
			<Link to={`/members/${member.memberId}`} className={clsx('flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px]', selected ? 'bg-selected' : 'hover:bg-hover')}>
				<Avatar member={member} size={28} className="opacity-60" />
				<div className="flex min-w-0 flex-1 items-baseline gap-2">
					<span className={clsx('truncate text-fg-3', member.description ? 'max-w-full shrink-0' : 'flex-1')}><Highlighted text={member.name} words={words} /></span>
					<MemberNote member={member}><Highlighted text={member.description} words={words} /></MemberNote>
				</div>
				<span className="shrink-0 text-xs text-fg-3">{dayTime(member.deletedAt ?? 0)}</span>
			</Link>
		</div>
	);
}

/** AI 成员最近的结果：「发给 张三：…」「发到 群聊「X」：…」「直接输出：…」。 */
function resultText(result: MemberResult, memberById: Map<string, IMember>, groupById: Map<string, IGroup>): string {
	if (result.kind === 'output') return `直接输出：${result.text}`;
	const target = result.target;
	if (target.kind === 'direct') return `发送给 ${memberById.get(target.memberId)?.name ?? '未知成员'}：${result.text}`;
	return `发送到群聊「${groupById.get(target.groupId)?.name ?? target.groupId}」：${result.text}`;
}
