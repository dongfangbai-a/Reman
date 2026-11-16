import * as Popover from '@radix-ui/react-popover';
import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';
import { useMemberStates } from '../api/member.ts';
import type { IMemberState, IMember } from '../api/types.ts';
import { elapsedText } from '../lib/format.ts';
import { useNow } from '../lib/useNow.ts';
import { Avatar } from '../ui/Avatar.tsx';
import { MemberNote } from '../ui/MemberNote.tsx';
import { isRunning, RUNNING, StepText, useSteps, type IStep } from './activity.tsx';

/** 一行里最多叠几个头像。 */
const MAX_AVATARS = 4;
/** 一行里写的成员换人至少隔这么久，免得一直闪。 */
const HOLD_MS = 4000;

interface IRow {
	readonly member: IMember;
	readonly state: IMemberState;
	readonly waiting: boolean;
}

/**
 * 运行状态行：这个对话里有 AI 成员在运行时，显示在消息列表和输入框之间。
 * 平时一行只写一个成员在做什么（在等审批的优先），点开看每个运行中的成员；点成员打开它的时间线。
 */
export function ActivityBar({ memberIds, memberById, onOpenTimeline }: {
	memberIds: readonly string[];
	memberById: Map<string, IMember>;
	onOpenTimeline: (memberId: string) => void;
}) {
	const states = useMemberStates();
	const [open, setOpen] = useState(false);
	const rows: IRow[] = [];
	for (const memberId of memberIds) {
		const state = states.data?.get(memberId);
		const member = memberById.get(memberId);
		if (!member || member.type !== 'ai' || !isRunning(state)) continue;
		rows.push({ member, state, waiting: state.status === 'waiting_approval' });
	}
	// 在等审批的排前面，其余按这一步开始的时间，新的在前。
	rows.sort((a, b) => Number(b.waiting) - Number(a.waiting) || (b.state.activity?.since ?? 0) - (a.state.activity?.since ?? 0));
	const featured = useFeatured(rows);
	const steps = useSteps(rows.map(row => ({ memberId: row.member.memberId, state: row.state })));
	const now = useNow(open && rows.length > 0);

	useEffect(() => {
		if (rows.length === 0) setOpen(false);
	}, [rows.length === 0]);

	if (rows.length === 0) return null;
	const shown = rows.find(row => row.member.memberId === featured) ?? rows[0]!;
	const shownStep = steps.get(shown.member.memberId) ?? RUNNING;
	const others = rows.length - 1;

	return (
		<Popover.Root open={open} onOpenChange={setOpen}>
			<div className="shrink-0 px-3 pb-1 md:px-4">
				<Popover.Trigger asChild>
					<button
						type="button"
						title="查看正在运行的成员"
						className="flex h-8 max-w-full items-center gap-2 rounded-md px-1.5 text-left text-[13px] text-fg-2 hover:bg-hover"
					>
						<span className="flex shrink-0 -space-x-1.5">
							{rows.slice(0, MAX_AVATARS).map(row => <Avatar key={row.member.memberId} member={row.member} size={20} className="rounded-full ring-2 ring-page" />)}
							{rows.length > MAX_AVATARS && (
								<span className="flex size-5 items-center justify-center rounded-full bg-selected text-[10px] text-fg-2 ring-2 ring-page">+{rows.length - MAX_AVATARS}</span>
							)}
						</span>
						<span className={clsx('min-w-0 truncate', shownStep.waiting && 'font-medium text-attention')}>
							{shown.member.name} <StepText step={shownStep} />
						</span>
						{others > 0 && <span className="shrink-0 text-fg-3">· 另有 {others} 个正在运行</span>}
					</button>
				</Popover.Trigger>
			</div>
			<Popover.Portal>
				<Popover.Content
					side="top"
					align="start"
					sideOffset={4}
					collisionPadding={8}
					className="z-50 max-h-[22rem] w-[min(26rem,calc(100vw-1.5rem))] overflow-y-auto rounded-lg border border-line bg-raised p-1 shadow-lg"
				>
					{rows.map(row => (
						<button
							key={row.member.memberId}
							type="button"
							title={`查看 ${row.member.name} 的时间线`}
							onClick={() => {
								setOpen(false);
								onOpenTimeline(row.member.memberId);
							}}
							className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left hover:bg-hover"
						>
							<Avatar member={row.member} size={28} className="rounded-full" />
							<div className="min-w-0 flex-1">
								<div className="flex items-baseline gap-2">
									<span className="shrink-0 truncate text-[13px] font-medium">{row.member.name}</span>
									<MemberNote member={row.member} />
									{row.state.activity && <span className="shrink-0 text-xs text-fg-3">已运行 {elapsedText(now - row.state.activity.runStartedAt)}</span>}
								</div>
								<RowStep step={steps.get(row.member.memberId) ?? RUNNING} />
							</div>
							{row.waiting && <span className="shrink-0 rounded-full bg-selected px-2 py-0.5 text-xs text-attention">前往处理</span>}
						</button>
					))}
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}

/** 一行里写的成员：最前面的那个，但换人至少隔 HOLD_MS；有成员开始等审批时立即换。 */
function useFeatured(rows: readonly IRow[]): string | undefined {
	const [featured, setFeatured] = useState<string>();
	const switchedAt = useRef(0);
	const best = rows[0];
	const current = rows.find(row => row.member.memberId === featured);
	const bestId = best?.member.memberId;
	const urgent = !!best?.waiting && !current?.waiting;
	useEffect(() => {
		if (!bestId || bestId === featured) return;
		const wait = current && !urgent ? HOLD_MS - (Date.now() - switchedAt.current) : 0;
		const timer = window.setTimeout(() => {
			switchedAt.current = Date.now();
			setFeatured(bestId);
		}, Math.max(0, wait));
		return () => window.clearTimeout(timer);
	}, [bestId, featured, !!current, urgent]);
	return current ? featured : bestId;
}

function RowStep({ step }: { step: IStep }) {
	return <div className={clsx('truncate text-xs', step.waiting ? 'text-attention' : 'text-fg-2')}><StepText step={step} /></div>;
}
