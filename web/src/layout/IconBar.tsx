import clsx from 'clsx';
import { Eye, Settings, UsersRound } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, useMatch } from 'react-router';
import { useIsPhone } from '../lib/media.ts';
import { useNotifyUnread, usePerspectiveTarget, useUnreadHumans, useUnreadJump } from '../perspective/notifyHumans.ts';
import { usePreferences } from '../stores.ts';
import type { Page } from './panes.ts';

/**
 * 最左边的图标栏：成员、视角，底部是设置。点当前页面的图标展开或收起列表栏，点别的页面的图标切过去并展开列表栏。手机上在屏幕底部横排。
 * 切到别的页面时回到那一页上次的位置（手机上回到列表）。「视角」带角标时点它是去看这些未读：上次的视角不是有未读的要提醒的真人时，
 * 切到那个真人的视角、打开最新一条未读所在的对话，不收起列表栏（见 usePerspectiveTarget）；
 * 跳过去时记下原来在哪，视角页列表栏顶部显示返回按钮。
 */
export function IconBar({ page }: { page: Page }) {
	const phone = useIsPhone();
	const perspective = usePerspectiveTarget();
	const membersPath = usePreferences(state => state.membersPath);
	const unread = useNotifyUnread();
	const unreadHumans = useUnreadHumans();
	const current = useMatch('/as/:perspectiveId/*')?.params.perspectiveId;
	const viewingUnread = current !== undefined && unreadHumans.includes(current);
	const onPerspective = page === 'perspective';
	// 手机上贴底：底部手势条下面留出安全区，不然最后一行被系统条压住。
	return (
		<nav className="flex min-h-14 w-full shrink-0 items-center justify-around border-t border-line bg-rail px-2 pb-[env(safe-area-inset-bottom)] md:h-auto md:w-14 md:flex-col md:justify-start md:gap-1 md:border-r md:border-t-0 md:px-0 md:py-3 md:pb-3">
			<RailLink to={phone ? '/' : membersPath ?? '/'} label="成员" icon={<UsersRound size={20} />} active={page === 'members'} />
			<RailLink
				to={perspective.path}
				label="视角"
				icon={<Eye size={20} />}
				active={onPerspective}
				toggles={onPerspective && (unreadHumans.length === 0 || viewingUnread)}
				badge={unread}
				onNavigate={() => perspective.jump && useUnreadJump.setState({ jump: perspective.jump, arrived: false })}
			/>
			<div className="hidden flex-1 md:block" />
			<RailLink to="/settings" label="设置" icon={<Settings size={20} />} active={page === 'settings'} />
		</nav>
	);
}

/** active 是不是当前页面；toggles 是点它展开或收起列表栏，否则跳到 to 并展开列表栏，默认和 active 一样。onNavigate 在点了要跳到 to 时调用。 */
function RailLink({ to, label, icon, active, toggles = active, badge = 0, onNavigate }: { to: string; label: string; icon: ReactNode; active: boolean; toggles?: boolean; badge?: number; onNavigate?: () => void }) {
	const phone = useIsPhone();
	const set = usePreferences(state => state.set);
	const collapsed = usePreferences(state => state.listCollapsed);
	return (
		<Link
			to={to}
			aria-label={label}
			title={toggles && !phone ? (collapsed ? `${label} · 展开列表` : `${label} · 收起列表`) : label}
			onClick={event => {
				// 手机上回到这一页的列表；电脑上点当前页面展开或收起列表栏，切到别的页面时展开。
				if (phone || !toggles) onNavigate?.();
				if (phone) return;
				if (!toggles) {
					if (collapsed) set({ listCollapsed: false });
					return;
				}
				event.preventDefault();
				set({ listCollapsed: !collapsed });
			}}
			className={clsx(
				'relative flex size-10 items-center justify-center rounded-lg transition-colors',
				active ? 'bg-selected text-fg' : 'text-fg-2 hover:bg-hover hover:text-fg',
			)}
		>
			{icon}
			{badge > 0 && (
				<span className="absolute right-0.5 top-0.5 min-w-4 rounded-full bg-danger px-1 text-center text-[10px] font-medium leading-4 text-white">{badge > 99 ? '99+' : badge}</span>
			)}
		</Link>
	);
}
