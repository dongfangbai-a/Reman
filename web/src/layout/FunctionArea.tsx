import clsx from 'clsx';
import { lazy, Suspense, useRef } from 'react';
import { OverviewColumn } from '../overview/OverviewColumn.tsx';
import { usePreferences } from '../stores.ts';
import { defaultTerminalPanelWidth } from '../terminals/font.ts';
import { TimelineView } from '../timeline/TimelineView.tsx';
import { CenteredMessage } from '../ui/CenteredMessage.tsx';
import { ErrorBoundary, loadCode } from '../ui/ErrorBoundary.tsx';
import { HEADER_RIGHT, togglesSpace } from './PanelToggles.tsx';
import { CENTER_MIN_WIDTH, ICON_BAR_WIDTH, type IPaneLayout, OVERLAY_RATIO, OVERVIEW_WIDTH, type Page, WIDE_WIDTH } from './panes.ts';
import { ResizeHandle } from './ResizeHandle.tsx';
import { useTimelineColumnMember } from './uiState.ts';

// 工作台带着 xterm，用到时再加载。
const Workbench = lazy(() => loadCode(() => import('../workbench/Workbench.tsx')).then(module => ({ default: module.Workbench })));

/** 宽的那一栏放什么：工作台，视角页里也可以是时间线。 */
export type WideKind = 'workbench' | 'timeline';

/**
 * 右侧功能区：宽的那一栏和概况栏。放得下时各占一栏，放不下中间的最窄宽度时从右边滑出、盖在中间上。
 * 工作台最大化时中间隐藏，工作台占满中间和它自己那一栏。toggles 是右上角开关占的宽度，最右边那一栏的顶部一行让出来。
 */
export function FunctionArea({ page, layout, wide, maximized, windowWidth, toggles }: {
	page: Page;
	layout: IPaneLayout;
	wide: WideKind | undefined;
	maximized: boolean;
	windowWidth: number;
	toggles: number;
}) {
	const set = usePreferences(state => state.set);
	const widePane = useRef<HTMLDivElement>(null);
	const overviewPane = useRef<HTMLDivElement>(null);
	const overviewShown = layout.overview > 0;
	if (!wide && !overviewShown) return null;
	const docked = layout.docked || maximized;
	// 功能区加起来最多能多宽：占栏时是中间留够最窄宽度后剩下的（最大化时中间隐藏，给工作台留最窄宽度），盖在中间上时是窗口的 OVERLAY_RATIO。
	const room = docked ? windowWidth - ICON_BAR_WIDTH - layout.list - (maximized ? WIDE_WIDTH.min : CENTER_MIN_WIDTH) : Math.floor(windowWidth * OVERLAY_RATIO);
	// 只挤分隔线移过去那一边的栏：拉宽概况栏，room 里空着的用完后挤工作台（最大化时没有可挤的）；拉宽工作台到中间最窄就停，不挤另一边的概况栏。
	const wideShown = !!wide && !maximized;
	const closeWide = () => set(wide === 'timeline' ? { timelineOpen: false } : { workbenchOpen: false, workbenchMaximized: false });
	const content = (
		<>
			{wideShown && (
				<ResizeHandle
					pane={widePane}
					width={layout.wide}
					min={WIDE_WIDTH.min}
					max={room - layout.overview}
					defaultWidth={defaultTerminalPanelWidth()}
					grow="left"
					label={wide === 'workbench' ? '调整工作台宽度' : '调整时间线宽度'}
					// 概况栏被挤窄时，拖窄这一栏让出的宽度会先还给它，拖的线松手就跳回去；把它现在显示的宽度一起记下，让出的宽度给中间。
					onResize={width => set({ wideWidth: width, ...(overviewShown ? { overviewWidth: layout.overview } : {}) })}
					onCollapse={closeWide}
				/>
			)}
			{wide && (
				<div
					ref={widePane}
					style={{ ...(maximized ? {} : { width: layout.wide }), ...togglesSpace(overviewShown ? 0 : toggles) }}
					className={clsx('flex min-h-0 min-w-0 flex-col border-l border-line bg-page', maximized ? 'flex-1' : 'shrink-0')}
				>
					<FunctionPanel kind={wide} />
				</div>
			)}
			{overviewShown && (
				<ResizeHandle
					pane={overviewPane}
					width={layout.overview}
					min={OVERVIEW_WIDTH.min}
					max={OVERVIEW_WIDTH.max}
					room={room}
					yielding={wideShown ? { pane: widePane, width: layout.wide, min: WIDE_WIDTH.min } : undefined}
					defaultWidth={OVERVIEW_WIDTH.default}
					grow="left"
					label="调整概况栏宽度"
					onResize={(width, wideWidth) => set({ overviewWidth: width, ...(wideWidth === undefined ? {} : { wideWidth }) })}
					onCollapse={() => set({ overviewOpen: false })}
				/>
			)}
			{overviewShown && (
				<div ref={overviewPane} style={{ width: layout.overview, ...togglesSpace(toggles) }} className="flex min-h-0 shrink-0 flex-col border-l border-line bg-pane">
					<FunctionPanel kind="overview" page={page} />
				</div>
			)}
		</>
	);
	if (docked) return content;
	return <div className="absolute inset-y-0 right-0 z-20 flex bg-page shadow-xl">{content}</div>;
}

/** 功能区的一栏的内容；手机上整屏显示。 */
export function FunctionPanel({ kind, page }: { kind: WideKind | 'overview'; page?: Page }) {
	return (
		<ErrorBoundary>
			<Suspense fallback={<CenteredMessage title="正在加载…" />}>
				{kind === 'workbench' && <Workbench />}
				{kind === 'timeline' && <TimelineColumn />}
				{kind === 'overview' && <OverviewColumn page={page ?? 'members'} />}
			</Suspense>
		</ErrorBoundary>
	);
}

/** 视角页右边的时间线，显示谁见 useTimelineColumnMember。 */
function TimelineColumn() {
	const memberId = useTimelineColumnMember();
	if (!memberId) {
		return (
			<div className="flex h-full flex-col">
				<header className={clsx('flex h-12 shrink-0 items-center border-b border-line pl-4 font-semibold', HEADER_RIGHT)}>时间线</header>
				<div className="min-h-0 flex-1">
					<CenteredMessage title="暂无可显示的时间线" detail="与 AI 成员私聊时显示该成员的时间线；在群聊中点击成员头像，可显示该成员的时间线。" />
				</div>
			</div>
		);
	}
	return <TimelineView key={memberId} memberId={memberId} mode="column" />;
}
