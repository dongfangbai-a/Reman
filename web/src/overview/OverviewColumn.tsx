import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ChevronRight, SquareTerminal } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { api } from '../api/client.ts';
import { useReminders } from '../api/directory.ts';
import { queryKeys } from '../api/keys.ts';
import { useMemberStates, usePlan } from '../api/member.ts';
import { useMembers } from '../api/queries.ts';
import type { IMember, IPlan, IReminder } from '../api/types.ts';
import { useInbox } from '../inbox/inbox.ts';
import { HEADER_RIGHT } from '../layout/PanelToggles.tsx';
import type { Page } from '../layout/panes.ts';
import { useFocus, useTimelineColumnMember } from '../layout/uiState.ts';
import { errorMessage } from '../lib/errors.ts';
import { fullTime, shortTime } from '../lib/format.ts';
import { useIsPhone } from '../lib/media.ts';
import { timeZoneName } from '../lib/reminder.ts';
import { usePreferences, type OverviewSection } from '../stores.ts';
import { ApprovalCard } from '../timeline/ApprovalCard.tsx';
import { Avatar } from '../ui/Avatar.tsx';
import { Button } from '../ui/Button.tsx';
import { ConfirmDialog } from '../ui/Dialog.tsx';
import { openTerminal } from '../workbench/tabs.ts';
import { PlanItems, planProgress } from './PlanItems.tsx';

/**
 * 概况栏：顶部一行写「概况」，下面依次是待处理、当前成员的计划和定时，各有一行小标题。
 * 当前成员是成员页中间正在看的那个、视角页时间线一栏正在显示的那个；没有当前成员、或者它是真人时只有待处理。
 * 待处理是要你处理的事，等你审批的调用和成员请你接管终端，按时间排，当前成员的排在前面；它不能收起，计划和定时可以。
 * 各部分各自滚动：待处理优先，计划和定时合起来最多占这一栏的一半；待处理没有内容时只占小标题和一行文字，
 * 计划和定时可以用到剩下的全部高度。
 */
export function OverviewColumn({ page }: { page: Page }) {
	const inbox = useInbox();
	const members = useMembers();
	const center = useFocus(state => state.center);
	const timelineMember = useTimelineColumnMember();
	const timelineOpen = usePreferences(state => state.timelineOpen);
	const set = usePreferences(state => state.set);
	const phone = useIsPhone();
	const focus = page === 'members' ? center : page === 'perspective' && timelineOpen ? timelineMember : undefined;
	const queryClient = useQueryClient();
	const [declining, setDeclining] = useState<string>();
	const [declineError, setDeclineError] = useState<string>();
	// 不用接管：撤掉这条请求，成员收到消息后继续。
	const decline = async (terminalId: string, memberId: string) => {
		setDeclining(`${terminalId}:${memberId}`);
		setDeclineError(undefined);
		try {
			await api('POST', `/v1/terminals/${terminalId}/decline`, { memberId });
			await queryClient.invalidateQueries({ queryKey: queryKeys.terminals });
		} catch (caught) {
			setDeclineError(errorMessage(caught));
		} finally {
			setDeclining(undefined);
		}
	};
	const memberById = new Map((members.data ?? []).map(member => [member.memberId, member]));
	const focused = focus === undefined ? undefined : memberById.get(focus);
	const planMember = focused?.type === 'ai' && !focused.purged ? focused : undefined;
	// 当前成员的提到前面，其余按时间。
	const list = [...inbox.items].sort((left, right) => Number(right.memberId === focus) - Number(left.memberId === focus));
	// 加载中、出错、没有时，小标题下面都只有一行。
	const oneLine = list.length === 0;
	return (
		<div className="flex h-full min-h-0 flex-col">
			<header className={clsx('flex h-12 shrink-0 items-center border-b border-line pl-4 font-semibold', HEADER_RIGHT)}>概况</header>
			<section className={clsx('flex flex-col', oneLine ? 'shrink-0' : planMember ? 'min-h-0 flex-[0_1_auto]' : 'min-h-0 flex-1')}>
				<SectionTitle title="待处理">{list.length > 0 && <span className="text-xs text-fg-3">{list.length}</span>}</SectionTitle>
				<div className="min-h-0 space-y-3 overflow-y-auto px-3 pb-3">
					{inbox.isPending && <div className="px-1 text-[13px] text-fg-3">正在加载…</div>}
					{inbox.error && <div className="px-1 text-[13px] text-danger">加载失败：{inbox.error.message}</div>}
					{declineError && <div className="px-1 text-[13px] text-danger">操作失败：{declineError}</div>}
					{!inbox.isPending && !inbox.error && list.length === 0 && (
						// 下面有计划时只占一行，和小标题、计划的文字对齐；只有待处理时居中。
						<div className={clsx('text-[13px] text-fg-3', planMember ? 'px-1' : 'py-8 text-center')}>暂无待处理的事项</div>
					)}
					{list.map(item => {
						const member = memberById.get(item.memberId);
						return (
							<div key={item.key}>
								<div className="mb-1 flex items-center gap-1.5 text-[13px]">
									<Avatar member={member} size={18} />
									<Link to={`/members/${item.memberId}`} className="min-w-0 truncate font-medium hover:text-accent hover:underline">{member?.name ?? '未知成员'}</Link>
									<span className="shrink-0 text-xs text-fg-3">{shortTime(item.at)}</span>
								</div>
								{item.kind === 'approval' ? <ApprovalCard approval={item.approval} /> : (
									<div className="space-y-2 rounded-lg border border-line bg-raised px-3 py-2.5 text-[13px]">
										<div>请你接管终端 <span className="font-mono text-xs">{item.terminalId}</span>：{item.request}</div>
										{/* 两个动作分在两端：打开终端是主路径，不用接管低频，离远些免得点错。在终端里打字就自动接管。 */}
										<div className="flex items-center justify-between gap-2">
											<Button onClick={() => {
													openTerminal(item.terminalId);
													if (phone) set({ overviewOpen: false });
												}}>
												<SquareTerminal size={14} />打开终端
											</Button>
											<button
												type="button" disabled={declining === item.key}
												className="rounded px-1.5 py-1 text-xs text-fg-3 hover:text-fg-2 hover:underline underline-offset-2"
												onClick={() => void decline(item.terminalId, item.memberId)}
											>不用接管</button>
										</div>
									</div>
								)}
							</div>
						);
					})}
				</div>
			</section>
			{planMember && (
				// 计划和定时合起来最多占这一栏的一半，各自滚动；待处理没有内容时可以用到剩下的全部高度。
				<div className={clsx('flex flex-col', oneLine ? 'min-h-0 flex-[0_1_auto]' : 'max-h-[50%] shrink-0')}>
					<PlanSection member={planMember} />
					<RemindersSection member={planMember} />
				</div>
			)}
		</div>
	);
}

/** 待处理的小标题；children 写在标题后面（数字）。 */
function SectionTitle({ title, children }: { title: string; children?: ReactNode }) {
	return (
		<div className="flex h-9 shrink-0 items-center gap-2 pl-4 pr-3 text-[13px]">
			<span className="min-w-0 truncate font-semibold">{title}</span>
			{children}
		</div>
	);
}

/** 悬停时出现的文字链接：清空计划、取消定时。外面一层悬停时出现（各自加上 group-hover），没有悬停的设备上一直显示。 */
const REVEAL_LINK = 'shrink-0 rounded-sm text-xs text-accent opacity-0 hover:underline focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-accent [@media(hover:none)]:opacity-100';

/**
 * 计划、定时这样可以收起的一栏：点小标题收起或展开，收起后只剩小标题，右边的概况照旧，空出来的高度给待处理。
 * 收起的状态记在浏览器里，不分成员。action 是小标题最右边悬停时出现的操作。
 */
function FoldSection({ section, title, summary, action, children }: {
	section: OverviewSection;
	title: string;
	summary?: ReactNode;
	action?: ReactNode;
	children: ReactNode;
}) {
	const collapsed = usePreferences(state => state.overviewCollapsed.includes(section));
	const set = usePreferences(state => state.set);
	const toggle = () => {
		const current = usePreferences.getState().overviewCollapsed;
		set({ overviewCollapsed: collapsed ? current.filter(item => item !== section) : [...current, section] });
	};
	return (
		<section className={clsx('flex flex-col border-t border-line', collapsed ? 'shrink-0' : 'min-h-0 flex-[0_1_auto]')}>
			{/* 箭头放在左边的空白里，标题和待处理的小标题左对齐。 */}
			<div className="group flex h-9 shrink-0 items-center gap-2 pl-1 pr-3 text-[13px]">
				<button
					type="button"
					aria-expanded={!collapsed}
					onClick={toggle}
					className="flex h-full min-w-0 flex-1 items-center rounded-sm text-left focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-accent"
				>
					<ChevronRight size={12} className={clsx('shrink-0 text-fg-3 transition-transform', !collapsed && 'rotate-90')} />
					<span className="min-w-0 truncate font-semibold">{title}</span>
					{summary && <span className="ml-auto shrink-0 pl-2 text-xs text-fg-3">{summary}</span>}
				</button>
				{action}
			</div>
			{!collapsed && <div className="min-h-0 overflow-y-auto px-4 pb-3">{children}</div>}
		</section>
	);
}

/** 加载中、出错时写一行字，加载好了时是 children。 */
function Loaded({ query, children }: { query: { isPending: boolean; error: Error | null }; children: ReactNode }) {
	if (query.isPending) return <div className="text-[13px] text-fg-3">正在加载…</div>;
	if (query.error) return <div className="text-[13px] text-danger">加载失败：{query.error.message}</div>;
	return children;
}

/**
 * 当前成员的计划：计划由成员自己维护，要调整直接对它说；成员忘了更新时，可以在这里清空，成员会收到说明。
 * 成员更新计划时随事件流的 plan.changed 更新。成员正在运行时，进行中的事项图标转动；等待审批、空闲时不转。
 */
function PlanSection({ member }: { member: IMember }) {
	const queryClient = useQueryClient();
	const plan = usePlan(member.memberId);
	const running = useMemberStates().data?.get(member.memberId)?.status === 'running';
	const [confirming, setConfirming] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const items = plan.data?.items ?? [];
	const updatedAt = plan.data?.updatedAt;
	const clear = async () => {
		setBusy(true);
		setError(undefined);
		try {
			queryClient.setQueryData(queryKeys.plan(member.memberId), await api<IPlan>('DELETE', `/v1/members/${member.memberId}/plan`));
			setConfirming(false);
		} catch (caught) {
			setError(`清空失败：${errorMessage(caught)}`);
		} finally {
			setBusy(false);
		}
	};
	return (
		<FoldSection
			section="plan"
			title={`计划 · ${member.name}`}
			summary={items.length > 0 && updatedAt != null && <>{planProgress(items)} · <span title={fullTime(updatedAt)}>{shortTime(updatedAt)}</span></>}
			action={items.length > 0 && <button type="button" className={clsx(REVEAL_LINK, 'group-hover:opacity-100')} onClick={() => setConfirming(true)}>清空</button>}
		>
			<Loaded query={plan}>
				{items.length === 0 ? <div className="text-[13px] text-fg-3">暂无计划</div> : <PlanItems items={items} wrap={false} running={running} />}
			</Loaded>
			<ConfirmDialog
				open={confirming}
				onOpenChange={open => {
					setConfirming(open);
					setError(undefined);
				}}
				title="清空计划"
				detail={`清空 ${member.name} 当前的计划。${member.name} 会收到一条说明，得知计划已被清空，但不会因此开始运行。`}
				confirmLabel="清空"
				onConfirm={() => void clear()}
				busy={busy}
				error={error}
			/>
		</FoldSection>
	);
}

/**
 * 当前成员的定时，按下一次的时间排。定时只能通过跟成员说来建和改，这里只看和取消；取消后成员会收到说明。
 * 每个定时两行：要做的事，下面一行灰字是时间。定时新建、修改、取消、触发时随事件流的 reminder.changed 更新。
 */
function RemindersSection({ member }: { member: IMember }) {
	const reminders = useReminders(member.memberId);
	const [cancelling, setCancelling] = useState<IReminder>();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const list = reminders.data?.reminders ?? [];
	const first = list[0];
	const cancel = async () => {
		setBusy(true);
		setError(undefined);
		try {
			await api('DELETE', `/v1/reminders/${cancelling!.reminderId}`);
			setCancelling(undefined);
		} catch (caught) {
			setError(`取消失败：${errorMessage(caught)}`);
		} finally {
			setBusy(false);
		}
	};
	return (
		<FoldSection
			section="reminders"
			title={`定时 · ${member.name}`}
			summary={first && <>{list.length} 个 · 下次 <span title={fullTime(first.nextAt)}>{shortTime(first.nextAt)}</span></>}
		>
			<Loaded query={reminders}>
				{list.length === 0 ? <div className="text-[13px] text-fg-3">暂无定时</div> : (
					<ul className="space-y-2">
						{list.map(reminder => (
							<li key={reminder.reminderId} className="group/reminder text-[13px] leading-5">
								<div className="flex items-baseline gap-2">
									<span className="min-w-0 flex-1 truncate" title={reminder.note}>{reminder.note}</span>
									<button type="button" className={clsx(REVEAL_LINK, 'group-hover/reminder:opacity-100')} onClick={() => setCancelling(reminder)}>取消</button>
								</div>
								<div className="truncate text-xs text-fg-3">{reminderTime(reminder, reminders.data!.timeZone)}</div>
							</li>
						))}
					</ul>
				)}
			</Loaded>
			<ConfirmDialog
				open={cancelling !== undefined}
				onOpenChange={open => {
					if (!open) setCancelling(undefined);
					setError(undefined);
				}}
				title="取消定时"
				detail={cancelling && <>
					<p>{cancelling.when}：{cancelling.note}</p>
					<p className="mt-2">取消后不再提醒 {member.name}。{member.name} 会收到一条说明，得知定时已被取消，但不会因此开始运行。</p>
				</>}
				confirmLabel="取消定时"
				cancelLabel="保留"
				onConfirm={() => void cancel()}
				busy={busy}
				error={error}
			/>
		</FoldSection>
	);
}

/**
 * 定时的时间：「11 月 2 日 周一 06:00」「每天 06:00 · 下次 11 月 3 日 周二」。
 * 定时的时区和运行时所在机器的时区不同时，标出时区名，如「06:00（北美中部时间）」。
 */
function reminderTime(reminder: IReminder, timeZone: string): string {
	const zone = reminder.timeZone === timeZone ? '' : `（${timeZoneName(reminder.timeZone)}）`;
	const next = reminder.repeat === 'none' ? '' : ` · 下次 ${reminder.next.replace(/ \d{2}:\d{2}(?::\d{2})?$/, '')}`;
	return `${reminder.when}${zone}${next}`;
}
