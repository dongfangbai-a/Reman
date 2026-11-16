import clsx from 'clsx';
import { Inbox, PanelRight, ScrollText } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import { useInbox } from '../inbox/inbox.ts';
import { useIsPhone } from '../lib/media.ts';
import { usePreferences } from '../stores.ts';
import { openTerminal, useUnseenTerminals } from '../workbench/tabs.ts';
import type { Page } from './panes.ts';
import { openTimelineColumn } from './uiState.ts';

const BUTTON = 28;
const GAP = 2;
const EDGE = 8;

/** 右上角这组开关占的宽度：最右边那一栏的顶部一行在右边让出这么多。 */
export function togglesWidth(page: Page): number {
	const count = page === 'perspective' ? 3 : 2;
	return count * BUTTON + (count - 1) * GAP + EDGE;
}

/** 最右边那一栏用 --toggles 告诉自己的顶部一行让出多少；别的栏是 0。 */
export function togglesSpace(width: number): CSSProperties {
	return { '--toggles': `${width}px` } as CSSProperties;
}

/** 顶部一行右边的留白：让出开关，再留 8px。 */
export const HEADER_RIGHT = 'pr-[calc(var(--toggles,0px)_+_0.5rem)]';

/** 窗口右上角管功能区的开关：成员页、设置页是工作台、概况；视角页多一个时间线，和工作台共用宽的那一栏。 */
export function PanelToggles({ page }: { page: Page }) {
	const workbenchOpen = usePreferences(state => state.workbenchOpen);
	const timelineOpen = usePreferences(state => state.timelineOpen);
	const overviewOpen = usePreferences(state => state.overviewOpen);
	const set = usePreferences(state => state.set);
	// 角标只算待处理：计划不用你处理。
	const pending = useInbox().items.length;
	const unseen = useUnseenTerminals(state => state.unseen.size > 0);
	const phone = useIsPhone();
	const timelineShown = page === 'perspective' && timelineOpen;
	const workbenchShown = workbenchOpen && !timelineShown;
	// 手机上一次只开一个，各自整屏。
	const others = phone ? { overviewOpen: false } : {};
	return (
		<div className="absolute right-0 top-0 z-30 flex h-12 items-center gap-0.5 pr-2">
			{page === 'perspective' && (
				<Toggle label="时间线" pressed={timelineShown} onClick={() => timelineShown ? set({ timelineOpen: false }) : (openTimelineColumn(), set(others))}>
					<ScrollText size={16} />
				</Toggle>
			)}
			<Toggle label="工作台" pressed={workbenchShown} onClick={() => workbenchShown ? set({ workbenchOpen: false, workbenchMaximized: false }) : (openTerminal(), set(others))}>
				<PanelRight size={16} />
				{unseen && <span className="absolute right-1 top-1 size-1.5 rounded-full bg-accent" />}
			</Toggle>
			<Toggle label="概况" pressed={overviewOpen} onClick={() => set(overviewOpen ? { overviewOpen: false } : { overviewOpen: true, ...(phone ? { workbenchOpen: false, timelineOpen: false } : {}) })}>
				<Inbox size={16} />
				{pending > 0 && (
					<span className="absolute -right-1 -top-1 min-w-4 rounded-full bg-attention px-1 text-center text-[10px] font-medium leading-4 text-white dark:text-black">{pending > 99 ? '99+' : pending}</span>
				)}
			</Toggle>
		</div>
	);
}

function Toggle({ label, pressed, onClick, children }: { label: string; pressed: boolean; onClick: () => void; children: ReactNode }) {
	return (
		<button
			type="button"
			aria-label={label}
			title={label}
			aria-pressed={pressed}
			onClick={onClick}
			className={clsx('relative flex size-7 items-center justify-center rounded-md transition-colors', pressed ? 'bg-selected text-fg' : 'text-fg-2 hover:bg-hover hover:text-fg')}
		>
			{children}
		</button>
	);
}
