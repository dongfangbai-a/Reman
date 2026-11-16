import { useQueryClient } from '@tanstack/react-query';
import { Suspense, useEffect, useRef } from 'react';
import { matchPath, Navigate, Outlet, useLocation, useMatch, useNavigate } from 'react-router';
import { api } from '../api/client.ts';
import { queryKeys } from '../api/keys.ts';
import { useMembers } from '../api/queries.ts';
import { useTerminals } from '../api/system.ts';
import type { IMemberSection } from '../api/types.ts';
import { useSearchFocus } from '../chat/searchFocus.ts';
import { isPhone, useIsPhone } from '../lib/media.ts';
import { MemberList } from '../members/MemberList.tsx';
import { MemberSettingsDialog } from '../members/MemberSettingsDialog.tsx';
import { NewHumanDialog, SectionNameDialog } from '../members/NewDialogs.tsx';
import { useInboxNotifications, useFailureNotifications, useMessageNotifications } from '../notifications.ts';
import { useNotifyUnread, useTrackUnreadJump } from '../perspective/notifyHumans.ts';
import { PerspectiveProvider } from '../perspective/perspective.tsx';
import { PerspectiveList } from '../perspective/PerspectiveList.tsx';
import { SettingsList } from '../settings/SettingsList.tsx';
import { usePreferences } from '../stores.ts';
import { CenteredMessage } from '../ui/CenteredMessage.tsx';
import { ErrorBoundary } from '../ui/ErrorBoundary.tsx';
import { useUnseenTerminals } from '../workbench/tabs.ts';
import { ConnectionBanner } from './ConnectionBanner.tsx';
import { FunctionArea, FunctionPanel, type WideKind } from './FunctionArea.tsx';
import { IconBar } from './IconBar.tsx';
import { PanelToggles, togglesSpace, togglesWidth } from './PanelToggles.tsx';
import { CENTER_MIN_WIDTH, fitPanes, ICON_BAR_WIDTH, LIST_WIDTH, type Page, pageOf, useWindowWidth, WIDE_WIDTH } from './panes.ts';
import { ResizeHandle } from './ResizeHandle.tsx';
import { openMemberDialog, useMemberDialog } from './uiState.ts';

/**
 * 整体布局：图标栏、列表栏、中间、右侧功能区，右上角是功能区的开关。视角页的地址里有视角成员，这里给整页提供视角。
 * 手机上图标栏在底部，列表和内容一次只显示一个，功能区各自整屏。
 */
export function Shell() {
	const { pathname } = useLocation();
	const page = pageOf(pathname);
	const match = useMatch('/as/:perspectiveId/*');
	const members = useMembers();
	const perspectiveId = match?.params.perspectiveId;
	const perspective = perspectiveId ? members.data?.find(member => member.memberId === perspectiveId && !member.purged) : undefined;
	useEffect(() => {
		if (perspective) usePreferences.getState().set({ perspectiveId: perspective.memberId });
	}, [perspective?.memberId]);
	useRememberLocation(page, pathname, perspective?.memberId, match?.params['*'] ?? '');
	useTrackUnreadJump(page === 'perspective' ? perspective?.memberId : undefined);
	useUnreadTitle();
	useInboxNotifications();
	useMessageNotifications();
	useFailureNotifications();
	useSearchShortcut(page);
	useTrackTerminals();
	const panesPage = perspective || page !== 'perspective' ? page : 'members';
	useRevealCenterOnNavigate(panesPage);

	if (perspectiveId && members.isSuccess && !perspective) return <Navigate to="/as" replace />;
	// 全面屏横屏时刘海那一侧不压内容；没有刘海时这两个值是 0。
	const content = (
		<div className="flex h-full flex-col overflow-hidden pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]">
			<ConnectionBanner />
			<Panes page={panesPage} pathname={pathname} />
			<MemberDialogs />
		</div>
	);
	return perspective ? <PerspectiveProvider perspective={perspective}>{content}</PerspectiveProvider> : content;
}

function Panes({ page, pathname }: { page: Page; pathname: string }) {
	const phone = useIsPhone();
	const windowWidth = useWindowWidth();
	const listWidth = usePreferences(state => state.listWidth);
	const listCollapsed = usePreferences(state => state.listCollapsed);
	const wideWidth = usePreferences(state => state.wideWidth);
	const overviewWidth = usePreferences(state => state.overviewWidth);
	const workbenchOpen = usePreferences(state => state.workbenchOpen);
	const timelineOpen = usePreferences(state => state.timelineOpen);
	const overviewOpen = usePreferences(state => state.overviewOpen);
	const workbenchMaximized = usePreferences(state => state.workbenchMaximized);
	const set = usePreferences(state => state.set);
	const listPane = useRef<HTMLDivElement>(null);
	const wide = wideOf(page, workbenchOpen, timelineOpen);
	const toggles = togglesWidth(page);

	if (phone) {
		const panel = overviewOpen ? 'overview' : wide;
		return (
			<div className="flex min-h-0 flex-1 flex-col-reverse">
				<IconBar page={page} />
				<div className="relative min-h-0 flex-1 bg-page" style={togglesSpace(toggles)}>
					{isListHome(pathname) ? <div className="flex h-full"><ListContent page={page} /></div> : <Center pathname={pathname} />}
					{panel && <div className="absolute inset-0 z-20 flex flex-col bg-page"><FunctionPanel kind={panel} page={page} /></div>}
					<PanelToggles page={page} />
				</div>
			</div>
		);
	}

	const maximized = wide === 'workbench' && workbenchMaximized;
	const layout = fitPanes(
		windowWidth,
		{ list: listCollapsed ? 0 : listWidth, wide: wide && !maximized ? wideWidth : 0, overview: overviewOpen ? overviewWidth : 0 },
		maximized ? WIDE_WIDTH.min : CENTER_MIN_WIDTH,
	);
	const functionShown = !!wide || layout.overview > 0;
	const docked = layout.docked || maximized;
	// 列表栏最宽：中间留够最窄宽度，占栏的功能区也算上。
	const listMax = Math.min(LIST_WIDTH.max, windowWidth - ICON_BAR_WIDTH - (maximized ? WIDE_WIDTH.min : CENTER_MIN_WIDTH) - (docked ? layout.wide + layout.overview : 0));
	return (
		<div className="relative flex min-h-0 flex-1">
			<IconBar page={page} />
			{layout.list > 0 && (
				<>
					<div ref={listPane} style={{ width: layout.list, ...togglesSpace(0) }} className="flex min-h-0 shrink-0">
						<ListContent page={page} />
					</div>
					<ResizeHandle
						pane={listPane}
						width={layout.list}
						min={LIST_WIDTH.min}
						max={listMax}
						defaultWidth={LIST_WIDTH.default}
						grow="right"
						label="调整列表栏宽度"
						onResize={width => set({ listWidth: width })}
					/>
				</>
			)}
			{!maximized && (
				<main className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-page" style={togglesSpace(functionShown && docked ? 0 : toggles)}>
					<Center pathname={pathname} />
				</main>
			)}
			<FunctionArea page={page} layout={layout} wide={wide} maximized={maximized} windowWidth={windowWidth} toggles={toggles} />
			<PanelToggles page={page} />
		</div>
	);
}

/** 宽的那一栏放什么：视角页开着时间线时是时间线，否则开着工作台时是工作台。 */
function wideOf(page: Page, workbenchOpen: boolean, timelineOpen: boolean): WideKind | undefined {
	return page === 'perspective' && timelineOpen ? 'timeline' : workbenchOpen ? 'workbench' : undefined;
}

/**
 * 功能区是不是盖在中间上：手机上开着就是整屏盖着；电脑上按常态（不算最大化）的宽度放不下中间的最窄宽度时，从右边滑出盖着。
 * 读的是现在的设置和窗口宽度，和 Panes 的算法一样。
 */
function coversCenter(page: Page): boolean {
	const { workbenchOpen, timelineOpen, overviewOpen, listCollapsed, listWidth, wideWidth, overviewWidth } = usePreferences.getState();
	const wide = wideOf(page, workbenchOpen, timelineOpen);
	if (!wide && !overviewOpen) return false;
	if (isPhone()) return true;
	return !fitPanes(window.innerWidth, { list: listCollapsed ? 0 : listWidth, wide: wide ? wideWidth : 0, overview: overviewOpen ? overviewWidth : 0 }).docked;
}

function Center({ pathname }: { pathname: string }) {
	return (
		// 换页面后重新渲染，一个页面出错不影响去别的页面。
		<ErrorBoundary key={pathname}>
			<Suspense fallback={<CenteredMessage title="正在加载…" />}>
				<Outlet />
			</Suspense>
		</ErrorBoundary>
	);
}

function ListContent({ page }: { page: Page }) {
	if (page === 'members') return <MemberList />;
	if (page === 'perspective') return <PerspectiveList />;
	return <SettingsList />;
}

/** 手机上只显示列表的地址：点开一项才进入内容。 */
function isListHome(pathname: string): boolean {
	return pathname === '/' || pathname === '/settings' || !!matchPath('/as/:perspectiveId', pathname);
}

/** 各页都能打开的成员弹窗：成员设置、新建 AI 成员、新建真人、新建分组。 */
function MemberDialogs() {
	const dialog = useMemberDialog(state => state.dialog);
	const members = useMembers();
	const queryClient = useQueryClient();
	const close = (open: boolean) => {
		if (!open) openMemberDialog(undefined);
	};
	if (!dialog) return null;
	switch (dialog.kind) {
		case 'settings': {
			const member = members.data?.find(item => item.memberId === dialog.memberId);
			return member ? <MemberSettingsDialog key={member.memberId} member={member} open onOpenChange={close} /> : null;
		}
		case 'newAi':
			return <MemberSettingsDialog open onOpenChange={close} />;
		case 'newHuman':
			return <NewHumanDialog open onOpenChange={close} />;
		case 'newSection':
			return (
				<SectionNameDialog
					open
					onOpenChange={close}
					title="新建分组"
					submitLabel="新建"
					onSubmit={async name => {
						const { section } = await api<{ section: IMemberSection }>('POST', '/v1/member-sections', { name });
						if (dialog.addMemberId) await api('PUT', `/v1/member-sections/${section.sectionId}`, { memberIds: [dialog.addMemberId] });
						await queryClient.invalidateQueries({ queryKey: queryKeys.memberSections });
					}}
				/>
			);
	}
}

/** Ctrl+K（Mac 上 ⌘K）聚焦列表栏的搜索框：成员页搜成员，视角页搜对话和消息；设置页里去成员页搜。 */
function useSearchShortcut(page: Page): void {
	const navigate = useNavigate();
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey || event.key.toLowerCase() !== 'k') return;
			// 终端里的 Ctrl+K 留给终端。
			if (event.target instanceof Element && event.target.closest('.xterm')) return;
			event.preventDefault();
			usePreferences.getState().set({ listCollapsed: false });
			if (page === 'settings') navigate('/');
			useSearchFocus.getState().request();
		};
		window.addEventListener('keydown', onKeyDown);
		return () => window.removeEventListener('keydown', onKeyDown);
	}, [page, navigate]);
}

/** 标签页标题带上要提醒的真人的未读加起来。 */
function useUnreadTitle(): void {
	const unread = useNotifyUnread();
	useEffect(() => {
		document.title = unread > 0 ? `(${unread}) Reman` : 'Reman';
	}, [unread]);
}

/**
 * 点了要在中间显示的东西（成员、对话、设置页这类）时让中间露出来，不然中间被藏着、盖着，看上去就是点了没反应：
 * - 功能区盖在中间上（窄窗口里从右边滑出、手机上整屏）时，几栏一起收起，等于用右上角的开关关掉。跳转前后的页面有一边盖着就算：
 *   视角页的时间线盖着中间，切到成员页时不显示，但不关掉的话回来还盖着。
 * - 工作台最大化时恢复常态；恢复后放不下、要盖在中间上时，按上一条收起。
 * - 各栏占一栏、中间露着时不动。
 * 看的是有没有跳转（location.key 每次跳转都变），不是地址变没变：点现在开着的那个也算。
 * 页面加载时自己做的跳转（重定向）不算：那时使用者还没在页面上点过、按过键，刷新后保持原样。
 */
function useRevealCenterOnNavigate(page: Page): void {
	const { key } = useLocation();
	const previous = useRef({ key, page });
	useEffect(() => {
		const from = previous.current;
		previous.current = { key, page };
		if (from.key === key) return;
		if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
		const { workbenchMaximized, set } = usePreferences.getState();
		if (coversCenter(from.page) || coversCenter(page)) set({ workbenchOpen: false, timelineOpen: false, overviewOpen: false, workbenchMaximized: false });
		else if (workbenchMaximized) set({ workbenchMaximized: false });
	}, [key, page]);
}

/**
 * 记下每个页面上次的位置，从图标栏切回来时回到这里（见 IconBar）：成员页记地址，只记首页和 AI 成员的时间线（真人的会跳到视角页）；
 * 视角页每个视角记打开的对话，回到这个视角的首页时去掉。
 */
function useRememberLocation(page: Page, pathname: string, perspectiveId: string | undefined, rest: string): void {
	const members = useMembers();
	const memberId = /^\/members\/([^/]+)$/.exec(pathname)?.[1];
	const memberType = memberId ? members.data?.find(member => member.memberId === memberId)?.type : undefined;
	useEffect(() => {
		if (page !== 'members' || (memberId ? memberType !== 'ai' : pathname !== '/')) return;
		usePreferences.getState().set({ membersPath: pathname });
	}, [page, pathname, memberId, memberType]);
	useEffect(() => {
		if (!perspectiveId) return;
		const { perspectiveConversations: remembered, set } = usePreferences.getState();
		const conversation = /^(direct|group)\/[^/]+$/.test(rest) ? rest : undefined;
		if (remembered[perspectiveId] === conversation) return;
		const next = { ...remembered };
		if (conversation) next[perspectiveId] = conversation;
		else delete next[perspectiveId];
		set({ perspectiveConversations: next });
	}, [perspectiveId, rest]);
}

/** 记下 AI 新开、还没看过的终端：打开页面时已有的都算看过。 */
function useTrackTerminals(): void {
	const terminals = useTerminals();
	useEffect(() => {
		if (!terminals.data) return;
		const { known, unseen } = useUnseenTerminals.getState();
		const ids = new Set(terminals.data.map(terminal => terminal.terminalId));
		if (!known) {
			useUnseenTerminals.setState({ known: ids });
			return;
		}
		const fresh = terminals.data.filter(terminal => !known.has(terminal.terminalId) && terminal.createdBy !== null).map(terminal => terminal.terminalId);
		// 已经没有了的终端不再算没看过。
		const nextUnseen = new Set([...unseen, ...fresh].filter(id => ids.has(id)));
		useUnseenTerminals.setState({ known: new Set([...known, ...ids]), unseen: nextUnseen });
	}, [terminals.data]);
}
