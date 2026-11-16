import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useMembers } from '../api/queries.ts';
import { useUsage } from '../api/usage.ts';
import type { IUsageGroup, IUsageTotals } from '../api/types.ts';
import { formatPercent, formatTokens } from '../lib/format.ts';
import { BackLink } from '../ui/BackLink.tsx';
import { Choice } from '../ui/Choice.tsx';
import { SettingsPage } from './SettingsPage.tsx';

type UsageRange = '7d' | '30d' | 'all';

const RANGES: readonly { readonly key: UsageRange; readonly label: string; readonly days: number }[] = [
	{ key: '7d', label: '近 7 天', days: 7 },
	{ key: '30d', label: '近 30 天', days: 30 },
	{ key: 'all', label: '全部', days: 0 },
];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 用量：模型服务返回的真实 token，按模型、按成员拆开。
 * 上下文里那根「用了多少」的环是估算（为了决定要不要压缩），这里是按它算钱的数字，两者不是一回事。
 */
export function UsageSettings() {
	const [range, setRange] = useState<UsageRange>('30d');
	// 从今天的零点往前数，切范围时不会因为「现在几点」变了就重新拉一次。
	const since = useMemo(() => {
		const days = RANGES.find(item => item.key === range)?.days ?? 0;
		if (days === 0) return undefined;
		const today = new Date();
		today.setHours(0, 0, 0, 0);
		return today.getTime() - (days - 1) * DAY_MS;
	}, [range]);
	const usage = useUsage('model', since);
	const byMember = useUsage('member', since);
	const members = useMembers();
	const totals = usage.data;

	return (
		<SettingsPage>
			<BackLink to="/settings" label="设置" />
			<h1 className="mb-2 text-xl font-semibold">用量</h1>
			<p className="mb-6 text-[13px] text-fg-2">AI 成员请求模型用掉的 token，按请求开始的时间算进这段时间。</p>
			<div className="space-y-4">
				<section className="rounded-xl border border-line bg-raised p-5">
					<div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
						<h2 className="flex-1 font-semibold">合计</h2>
						<div role="radiogroup" aria-label="时间范围" className="flex gap-2">
							{RANGES.map(item => (
								<Choice key={item.key} checked={range === item.key} onClick={() => setRange(item.key)}>{item.label}</Choice>
							))}
						</div>
					</div>
					{usage.isPending && <div className="text-center text-[13px] text-fg-3">正在加载…</div>}
					{usage.isError && <div className="text-[13px] text-danger">加载失败：{usage.error.message}</div>}
					{totals && <Totals usage={totals} />}
				</section>
				<GroupSection title="按模型" usage={totals} error={usage.isError ? usage.error.message : undefined} empty="这段时间还没有请求。" render={group => <ModelName group={group} />} />
				<GroupSection
					title="按成员"
					usage={byMember.data}
					error={byMember.isError ? byMember.error.message : undefined}
					empty="这段时间还没有请求。"
					render={group => <MemberLink group={group} members={members.data} />}
				/>
			</div>
		</SettingsPage>
	);
}

/** 四个数字：请求次数、输入、其中命中缓存、输出。 */
function Totals({ usage }: { usage: IUsageTotals }) {
	const hit = hitRate(usage);
	return (
		<div className="@container">
			<div className="grid grid-cols-2 gap-x-4 gap-y-3 @[26rem]:grid-cols-4">
				<Stat label="请求" value={String(usage.requests)} />
				<Stat label="输入" value={formatTokens(usage.inputTokens)} />
				<Stat label="其中命中缓存" value={hit} detail={formatTokens(usage.cachedTokens)} />
				<Stat label="输出" value={formatTokens(usage.outputTokens)} />
			</div>
		</div>
	);
}

function Stat({ label, value, detail }: { label: string; value: string; detail?: string }) {
	return (
		<div className="min-w-0">
			<div className="truncate text-xs text-fg-3">{label}</div>
			<div className="mt-0.5 font-semibold tabular-nums" title={detail}>{value}</div>
			{detail && <div className="text-xs tabular-nums text-fg-3">{detail}</div>}
		</div>
	);
}

/** 一张表：标题、每项一行、空和出错的样子。 */
function GroupSection({ title, usage, error, empty, render }: {
	readonly title: string;
	readonly usage: (IUsageTotals & { readonly groups: readonly IUsageGroup[] }) | undefined;
	readonly error: string | undefined;
	readonly empty: string;
	readonly render: (group: IUsageGroup) => ReactNode;
}) {
	return (
		<section className="@container rounded-xl border border-line bg-raised">
			<div className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
				<h2 className="flex-1 font-semibold">{title}</h2>
				<span className="shrink-0 text-xs text-fg-3">请求 · 输入 · 缓存（命中率）· 输出</span>
			</div>
			{error && <div className="border-t border-line px-4 py-3 text-[13px] text-danger">加载失败：{error}</div>}
			{!usage && !error && <div className="border-t border-line px-4 py-6 text-center text-[13px] text-fg-3">正在加载…</div>}
			{usage && usage.groups.length === 0 && !error && <div className="border-t border-line px-4 py-6 text-center text-[13px] text-fg-3">{empty}</div>}
			{/* 窄的时候数字换到下一行、靠右，和列表行、设置行的排法一致。 */}
			{usage?.groups.map(group => (
				<div key={group.key} className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 border-t border-line px-4 py-1.5 text-[13px] @max-[32rem]:h-auto">
					<div className="flex min-w-0 flex-1 items-center gap-2">{render(group)}</div>
					<div className="flex shrink-0 items-center gap-3 tabular-nums text-fg-2 @max-[32rem]:w-full @max-[32rem]:justify-end">
						<span className="w-16 whitespace-nowrap text-right" title={`${group.requests} 次请求`}>{group.requests} 次</span>
						<span className="w-16 text-right" title={`输入 ${group.inputTokens.toLocaleString()} token`}>{formatTokens(group.inputTokens)}</span>
						{/* 缓存那一格后面跟命中率：缓存占输入的比例。 */}
						<span className="w-28 whitespace-nowrap text-right" title={`其中命中缓存 ${group.cachedTokens.toLocaleString()} token，占输入 ${hitRate(group)}`}>
							{formatTokens(group.cachedTokens)}
							{group.inputTokens > 0 && <span className="text-fg-3"> · {hitRate(group)}</span>}
						</span>
						<span className="w-16 text-right" title={`输出 ${group.outputTokens.toLocaleString()} token`}>{formatTokens(group.outputTokens)}</span>
					</div>
				</div>
			))}
		</section>
	);
}

/** 一组数据里缓存占输入的比例。没有输入时是「—」。 */
function hitRate(group: IUsageTotals): string {
	return group.inputTokens > 0 ? formatPercent(group.cachedTokens / group.inputTokens) : '—';
}

function ModelName({ group }: { group: IUsageGroup }) {
	return (
		<>
			<span className="min-w-0 truncate font-mono">{group.model}</span>
			{group.provider && <span className="shrink-0 rounded border border-line px-1.5 py-0.5 text-[11px] text-fg-3">{group.provider}</span>}
		</>
	);
}

function MemberLink({ group, members }: { group: IUsageGroup; members: readonly { readonly memberId: string; readonly name: string }[] | undefined }) {
	const memberId = group.memberId ?? '';
	const name = members?.find(member => member.memberId === memberId)?.name;
	// 成员被彻底删除之后这里还留着它的用量：没有 ID 就没法跳过去，只写名字。
	if (!memberId) return <span className="min-w-0 truncate">{name ?? '—'}</span>;
	return (
		<Link to={`/members/${memberId}`} className="min-w-0 truncate hover:underline">{name ?? memberId}</Link>
	);
}
