import clsx from 'clsx';
import { CircleCheck, CircleDashed, Contrast, LoaderCircle } from 'lucide-react';
import type { IPlanItem, PlanStatus } from '../api/types.ts';

/**
 * 事项状态的图标：已完成是勾，进行中是半实心的圆，未开始是虚线圆圈。
 * running 是成员正在运行：进行中的换成转圈的图标。不在运行时不转：标着进行中不一定在做，可能在等别人回复，一直转会让人以为它还在做。
 */
export function PlanStatusIcon({ status, running }: { status: PlanStatus; running: boolean }) {
	if (status === 'completed') return <CircleCheck size={14} className="shrink-0 text-success" aria-label="已完成" />;
	if (status === 'in_progress' && running) return <LoaderCircle size={14} className="shrink-0 animate-spin text-accent" aria-label="进行中" />;
	if (status === 'in_progress') return <Contrast size={14} className="shrink-0 text-accent" aria-label="进行中" />;
	return <CircleDashed size={14} className="shrink-0 text-fg-3" aria-label="未开始" />;
}

/** update_plan 参数里的事项。参数不合要求（这次调用出错）时取出能显示的，认不出的状态按未开始画。 */
export function planItemsOf(args: unknown): IPlanItem[] {
	const items = typeof args === 'object' && args !== null && 'items' in args && Array.isArray(args.items) ? args.items as unknown[] : [];
	return items.flatMap(item => {
		if (typeof item !== 'object' || item === null || !('text' in item) || typeof item.text !== 'string') return [];
		const status = 'status' in item && (item.status === 'completed' || item.status === 'in_progress') ? item.status : 'pending';
		return [{ text: item.text, status }];
	});
}

/** 完成数，如「3/7」。 */
export function planProgress(items: readonly IPlanItem[]): string {
	return `${items.filter(item => item.status === 'completed').length}/${items.length}`;
}

/**
 * 计划的事项，顺序照成员写的，不按状态重排；已完成的文字变灰。
 * wrap 为 false 时每项一行，放不下时末尾省略、悬停看全文（概况栏）；为 true 时换行写全（时间线里展开的「更新计划」）。
 * running 是成员正在运行，只有概况栏传：时间线里的是当时写下的计划，不转。
 */
export function PlanItems({ items, wrap, running = false }: { items: readonly IPlanItem[]; wrap: boolean; running?: boolean }) {
	return (
		<ul className="space-y-1">
			{items.map((item, index) => (
				<li key={index} className="flex gap-2 text-[13px] leading-5">
					<span className="flex h-5 shrink-0 items-center"><PlanStatusIcon status={item.status} running={running} /></span>
					<span title={wrap ? undefined : item.text} className={clsx('min-w-0', wrap ? 'whitespace-pre-wrap break-words' : 'truncate', item.status === 'completed' && 'text-fg-3')}>
						{item.text}
					</span>
				</li>
			))}
		</ul>
	);
}
