import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ChevronRight, LoaderCircle } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { api } from '../api/client.ts';
import { useEventLog, useExternal, useGroups } from '../api/directory.ts';
import { queryKeys } from '../api/keys.ts';
import { useMembers } from '../api/queries.ts';
import type { EventLogEntry, IDeliveryLog, IExternalRoute, IExternalSource, IMcpSnapshot, PlacedEntry } from '../api/types.ts';
import { errorMessage } from '../lib/errors.ts';
import { fullTime, shortTime } from '../lib/format.ts';
import { BackLink } from '../ui/BackLink.tsx';
import { Button } from '../ui/Button.tsx';
import { CopyablePath } from '../ui/CopyablePath.tsx';
import { MetaList } from '../ui/ExternalMeta.tsx';
import { Select } from '../ui/Select.tsx';
import { Switch } from '../ui/Switch.tsx';
import { SettingsPage } from './SettingsPage.tsx';

type EventEntry = Extract<EventLogEntry, { type: 'event' }> & { readonly offset: number };

/** 事件：来源的状态和开关、路由、事件日志。路由不在这里改。 */
export function ExternalSettings() {
	const external = useExternal();
	const data = external.data;
	return (
		<SettingsPage>
			<BackLink to="/settings" label="设置" />
			<h1 className="mb-1 text-xl font-semibold">事件</h1>
			<div className="text-[13px] text-fg-2">外部的消息和通知经由路由投递给 AI 成员。路由可由配置了「编写事件路由」技能的成员编写。</div>
			{data && <div className="mb-5"><CopyablePath path={data.routesDirectory} /></div>}
			{external.isPending && <div className="text-center text-[13px] text-fg-3">正在加载…</div>}
			{external.isError && <div className="text-[13px] text-danger">加载失败：{external.error.message}</div>}
			{data && (
				<div className="flex flex-col gap-5">
					<section className="rounded-xl border border-line bg-raised">
						<h2 className="px-4 pt-4 pb-2 font-semibold">来源</h2>
						<div className="divide-y divide-line border-t border-line">
							{data.sources.map(source => <SourceRow key={source.name} source={source} />)}
							<div className="px-4 py-2.5 text-xs text-fg-3">
								来源即 MCP 服务器，可在「<Link to="/settings/mcp" className="text-accent hover:underline">MCP</Link>」中添加。
							</div>
						</div>
					</section>
					<section className="rounded-xl border border-line bg-raised">
						<h2 className="px-4 pt-4 pb-2 font-semibold">路由</h2>
						<div className="divide-y divide-line border-t border-line">
							{data.routes.length === 0 && <div className="px-4 py-3 text-[13px] text-fg-3">暂无路由，未经路由投递的事件将被丢弃</div>}
							{data.routes.map(route => <RouteRow key={route.name} route={route} />)}
						</div>
					</section>
					<EventLog sources={data.sources.map(source => source.name)} />
				</div>
			)}
		</SettingsPage>
	);
}

function SourceRow({ source }: { source: IExternalSource }) {
	const queryClient = useQueryClient();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const toggle = async (enabled: boolean) => {
		setError(undefined);
		setBusy(true);
		try {
			queryClient.setQueryData(queryKeys.mcp, await api<IMcpSnapshot>('PUT', `/v1/mcp/servers/${encodeURIComponent(source.name)}/disabled`, { disabled: !enabled }));
			void queryClient.invalidateQueries({ queryKey: queryKeys.external });
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="px-4 py-2.5">
			<div className="flex items-center gap-3">
				<span className="min-w-0 truncate font-mono text-[13px] font-medium">{source.name}</span>
				<SourceStatus source={source} />
				{source.warning && <span className="shrink-0 text-xs text-warning">有警告</span>}
				{source.status !== 'missing' && (
					<span className="ml-auto flex">
						<Switch checked={source.status !== 'disabled'} label={`启用 ${source.name}`} disabled={busy} onChange={enabled => void toggle(enabled)} />
					</span>
				)}
			</div>
			{source.warning && (
				<div className="mt-1 truncate text-xs text-fg-3" title={source.warning.text}>
					<span className="tabular-nums">{shortTime(localTime(source.warning.time))}</span> · {source.warning.text}
				</div>
			)}
			{source.status === 'failed' && source.error && (
				<pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md bg-page px-3 py-2 font-mono text-xs text-danger">{source.error}</pre>
			)}
			{error && <div className="mt-1 text-[13px] text-danger">{error}</div>}
		</div>
	);
}

function SourceStatus({ source }: { source: IExternalSource }) {
	const [dot, text, danger] = {
		connected: ['bg-success', '已连接', false],
		connecting: ['bg-warning', '正在连接', false],
		disabled: ['bg-fg-3', '已停用', false],
		failed: ['bg-danger', '连接失败', true],
		missing: ['bg-danger', '该来源不存在', true],
		not_channel: ['bg-danger', '不是事件来源', true],
	}[source.status] as [string, string, boolean];
	return (
		<span className={clsx('flex shrink-0 items-center gap-1 text-xs', danger ? 'text-danger' : source.status === 'connected' ? 'text-fg-2' : 'text-fg-3')}>
			<span className={clsx('size-2 rounded-full', dot)} />{text}
		</span>
	);
}

function RouteRow({ route }: { route: IExternalRoute }) {
	const [open, setOpen] = useState(false);
	const run = route.lastRun;
	return (
		<div>
			<button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)} className="flex w-full items-center gap-2 px-4 py-2.5 text-left hover:bg-hover/60">
				<ChevronRight size={13} className={clsx('shrink-0 text-fg-3 transition-transform', open && 'rotate-90')} />
				<span className="min-w-0 truncate font-mono text-[13px] font-medium">{route.name}</span>
				<span className="flex min-w-0 flex-1 flex-wrap gap-1">
					{route.sources.map(source => <span key={source} className="tag font-mono">{source}</span>)}
				</span>
				<span className={clsx('shrink-0 text-xs', run?.error ? 'text-danger' : 'text-fg-3')} title={run ? run.time : undefined}>
					{run ? `${run.error ? '出错' : '正常'} · ${shortTime(localTime(run.time))}` : '最近未执行'}
				</span>
			</button>
			{route.problem && <div className="px-4 pb-2.5 pl-9 text-[13px] text-danger">{route.problem}</div>}
			{open && (
				<div className="flex flex-col gap-2 px-4 pb-3 pl-9">
					<pre className="max-h-96 overflow-auto rounded-md bg-code px-3 py-2 font-mono text-xs">{route.code}</pre>
					{run?.error && <pre className="overflow-auto whitespace-pre-wrap break-words rounded-md bg-page px-3 py-2 font-mono text-xs text-danger">{run.error}</pre>}
				</div>
			)}
		</div>
	);
}

/** 事件日志：选日期和来源，新的在前，每次 100 条。 */
function EventLog({ sources }: { sources: readonly string[] }) {
	const [date, setDate] = useState('');
	const [source, setSource] = useState('');
	const log = useEventLog(date, source);
	const first = log.data?.pages[0];
	const entries = log.data?.pages.flatMap(page => page.entries) ?? [];
	return (
		<section className="rounded-xl border border-line bg-raised">
			<div className="flex flex-wrap items-center gap-2 px-4 pt-4 pb-3">
				<h2 className="flex-1 font-semibold">事件日志</h2>
				{first && first.dates.length > 0 && (
					<Select label="日期" size="sm" value={date || first.date || ''} onChange={setDate} options={first.dates.map(day => ({ value: day, label: day }))} />
				)}
				<Select label="来源" size="sm" value={source} onChange={setSource} options={[{ value: '', label: '全部来源' }, ...sources.map(name => ({ value: name, label: name }))]} />
			</div>
			<div className="divide-y divide-line border-t border-line">
				{log.isPending && <div className="px-4 py-3 text-center text-[13px] text-fg-3">正在加载…</div>}
				{log.isError && <div className="px-4 py-3 text-[13px] text-danger">加载失败：{log.error.message}</div>}
				{log.data && entries.length === 0 && <div className="px-4 py-3 text-[13px] text-fg-3">{first?.dates.length ? '当天没有该来源的日志' : '暂无日志'}</div>}
				{entries.map(entry => entry.type === 'event' ? <EventRow key={entry.offset} entry={entry} />
					: entry.type === 'warning' ? <WarningRow key={entry.offset} entry={entry} />
					: <OtherRow key={entry.offset} entry={entry} />)}
				{log.hasNextPage && (
					<div className="flex justify-center py-2">
						<Button variant="ghost" className="text-fg-2" disabled={log.isFetchingNextPage} onClick={() => void log.fetchNextPage()}>
							{log.isFetchingNextPage && <LoaderCircle size={13} className="animate-spin" />}加载更早的日志
						</Button>
					</div>
				)}
			</div>
		</section>
	);
}

/** 一个事件：时间、来源、正文开头、投递结果；点开看详情、正文、每条路由的结果和每个投递。 */
function EventRow({ entry }: { entry: EventEntry }) {
	const [open, setOpen] = useState(false);
	const names = useNames();
	const errors = entry.routes.filter(route => route.error).length + entry.deliveries.filter(delivery => delivery.error).length;
	return (
		<div>
			<button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)} className="flex w-full items-baseline gap-2 px-4 py-2 text-left text-[13px] hover:bg-hover/60">
				<ChevronRight size={13} className={clsx('shrink-0 self-center text-fg-3 transition-transform', open && 'rotate-90')} />
				<LogTime time={entry.time} />
				<span className="shrink-0 font-mono text-xs text-fg-2">{entry.source}</span>
				<span className="min-w-0 flex-1 truncate">{entry.content}</span>
				<span className="max-w-[45%] shrink-0 truncate text-xs">
					{entry.deliveries.length > 0
						? <span className="text-fg-2">{entry.deliveries.map(delivery => deliveryTarget(delivery, names)).join('、')}</span>
						: <span className="text-fg-3">已丢弃</span>}
					{errors > 0 && <span className="text-danger"> · {errors} 个出错</span>}
				</span>
			</button>
			{open && (
				<div className="flex flex-col gap-3 px-4 pb-3 pl-9 text-[13px]">
					{Object.keys(entry.meta).length > 0 && <Part title="详情"><MetaList meta={entry.meta} /></Part>}
					<Part title="正文"><div className="max-h-96 overflow-auto whitespace-pre-wrap break-words">{entry.content}</div></Part>
					{entry.routes.length > 0 && (
						<Part title="路由">
							<div className="flex flex-col gap-1.5">
								{entry.routes.map(route => (
									<div key={route.route}>
										<div className="font-mono text-xs">{route.route}</div>
										{route.error && <pre className="mt-0.5 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-danger">{route.error}</pre>}
										{route.logs.length > 0 && <pre className="mt-0.5 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md bg-code px-2 py-1.5 font-mono text-xs">{route.logs.join('\n')}</pre>}
									</div>
								))}
							</div>
						</Part>
					)}
					{entry.deliveries.length > 0 && (
						<Part title="投递">
							<div className="flex flex-col gap-1.5">
								{entry.deliveries.map((delivery, index) => (
									<div key={index}>
										<div>{deliveryHead(delivery, names)}<span className="text-xs text-fg-3"> · 路由 {delivery.routes.join('、')}</span></div>
										{delivery.text !== undefined && <div className="mt-0.5 max-h-60 overflow-auto whitespace-pre-wrap break-words border-l-2 border-line pl-2 text-fg-2">{delivery.text}</div>}
										{delivery.error && <div className="mt-0.5 text-danger">未能投递：{delivery.error}</div>}
									</div>
								))}
							</div>
						</Part>
					)}
				</div>
			)}
		</div>
	);
}

/** 来源的警告：一行橙字，放不下的截断，悬停看全文。 */
function WarningRow({ entry }: { entry: Extract<PlacedEntry, { type: 'warning' }> }) {
	return (
		<div className="flex items-baseline gap-2 px-4 py-2 pl-9 text-xs text-fg-3">
			<LogTime time={entry.time} />
			<span className="shrink-0 font-mono">{entry.source}</span>
			<span className="min-w-0 truncate text-warning" title={entry.text}>{entry.text}</span>
		</div>
	);
}

/** 重复推送、格式不对、来源连上、断开、连接失败：一行灰字，失败的原因标红。 */
function OtherRow({ entry }: { entry: Exclude<PlacedEntry, { type: 'event' | 'warning' }> }) {
	let text: string;
	let error: string | null = null;
	switch (entry.type) {
		case 'duplicate':
			text = `重复推送，已收到过 ${entry.event_id}`;
			break;
		case 'invalid':
			text = '推送的格式有误';
			error = entry.error;
			break;
		case 'connected':
			text = '已连接';
			break;
		case 'disconnected':
			text = '已断开';
			error = entry.error;
			break;
		case 'failed':
			text = '连接失败';
			error = entry.error;
			break;
	}
	return (
		<div className="flex items-baseline gap-2 px-4 py-2 pl-9 text-xs text-fg-3">
			<LogTime time={entry.time} />
			<span className="shrink-0 font-mono">{entry.source}</span>
			<span className="min-w-0 break-words">{text}{error && <span className="text-danger">：{error}</span>}</span>
		</div>
	);
}

function Part({ title, children }: { title: string; children: ReactNode }) {
	return (
		<div>
			<div className="mb-1 text-xs text-fg-3">{title}</div>
			{children}
		</div>
	);
}

function LogTime({ time }: { time: string }) {
	return <span title={fullTime(localTime(time))} className="shrink-0 text-xs tabular-nums text-fg-3">{time.slice(11)}</span>;
}

/** 日志里的时间是运行时所在机器的本地时间，如 2026-11-02 10:23:45。 */
function localTime(time: string): number {
	return new Date(time.replace(' ', 'T')).getTime();
}

interface INames {
	member(memberId: string): string;
	group(groupId: string): string;
}

/** 成员和群聊的名字，找不到时用 ID。 */
function useNames(): INames {
	const members = useMembers();
	const groups = useGroups();
	return {
		member: memberId => members.data?.find(member => member.memberId === memberId)?.name ?? memberId,
		group: groupId => groups.data?.find(group => group.groupId === groupId)?.name ?? groupId,
	};
}

/** 投给谁，如「投给 沈安」「转发到 CI通知」。 */
function deliveryTarget(delivery: IDeliveryLog, names: INames): string {
	return delivery.from === undefined ? `投递给 ${names.member(delivery.to)}` : `转发到 ${names.group(delivery.to)}`;
}

/** 一个投递的完整说明：投给谁、是否唤醒、谁代发、点名了谁。 */
function deliveryHead(delivery: IDeliveryLog, names: INames): string {
	if (delivery.from === undefined) return `投递给 ${names.member(delivery.to)} · ${delivery.wake ? '唤醒' : '不唤醒'}`;
	const mentions = delivery.mentions === 'all' ? ' · 点名所有人'
		: delivery.mentions && delivery.mentions.length > 0 ? ` · 点名 ${delivery.mentions.map(memberId => names.member(memberId)).join('、')}` : '';
	return `${names.member(delivery.from)} 转发到群聊「${names.group(delivery.to)}」${mentions}`;
}
