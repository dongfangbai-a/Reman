import clsx from 'clsx';
import { Monitor, Moon, Sun } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useMembers } from '../api/queries.ts';
import { requestNotificationPermission } from '../notifications.ts';
import { useNotifyHumans } from '../perspective/notifyHumans.ts';
import { usePreferences, type MessageNotifications, type Theme } from '../stores.ts';
import { Avatar } from '../ui/Avatar.tsx';
import { BackLink } from '../ui/BackLink.tsx';
import { CheckMark } from '../ui/Checkbox.tsx';
import { Switch } from '../ui/Switch.tsx';
import { SettingsPage } from './SettingsPage.tsx';

const THEMES: { value: Theme; label: string; icon: typeof Sun }[] = [
	{ value: 'system', label: '跟随系统', icon: Monitor },
	{ value: 'light', label: '浅色', icon: Sun },
	{ value: 'dark', label: '深色', icon: Moon },
];

/** 外观和通知。 */
export function GeneralSettings() {
	const theme = usePreferences(state => state.theme);
	const set = usePreferences(state => state.set);
	return (
		<SettingsPage>
			<BackLink to="/settings" label="设置" />
			<h1 className="mb-6 text-xl font-semibold">外观和通知</h1>
			<section className="rounded-xl border border-line bg-raised p-5">
				<h2 className="mb-1 font-semibold">外观</h2>
				<div className="mb-4 text-[13px] text-fg-2">仅影响当前浏览器。</div>
				<div className="flex gap-2" role="radiogroup" aria-label="外观">
					{THEMES.map(({ value, label, icon: Icon }) => (
						<button
							key={value}
							type="button"
							role="radio"
							aria-checked={theme === value}
							onClick={() => set({ theme: value })}
							className={clsx(
								'flex w-28 flex-col items-center gap-2 rounded-lg border px-3 py-3 text-[13px] transition-colors',
								theme === value ? 'border-accent bg-accent-soft text-accent' : 'border-line hover:bg-hover',
							)}
						>
							<Icon size={20} />
							{label}
						</button>
					))}
				</div>
			</section>
			<Notifications />
		</SettingsPage>
	);
}

const MESSAGE_MODES: { value: MessageNotifications; label: string }[] = [
	{ value: 'off', label: '关闭' },
	{ value: 'mentions', label: '私聊和 @' },
	{ value: 'all', label: '全部' },
];

/**
 * 系统通知，都只在页面不在前台时发。打开任何一种时先拿到浏览器的权限，拿不到就不打开，在底部写原因。
 * 真人消息放第一行，下面多一行真人勾选。真人勾选也管视角页以外的未读和角标，所以真人消息关了也照常显示。
 */
function Notifications() {
	const preferences = usePreferences();
	const set = preferences.set;
	const supported = 'Notification' in window;
	const [notice, setNotice] = useState<string>();
	const enable = async (apply: () => void) => {
		setNotice(undefined);
		if (await requestNotificationPermission()) apply();
		else setNotice('浏览器未允许通知，请先在浏览器的网站设置中允许');
	};
	const problem = !supported ? '当前浏览器不支持系统通知' : notice;
	return (
		<section className="mt-4 rounded-xl border border-line bg-raised p-5">
			<h2 className="mb-1 font-semibold">系统通知</h2>
			<div className="mb-4 text-[13px] text-fg-2">网页不在前台时弹出。</div>
			<div className="divide-y divide-line">
				<div className="pb-3">
					<Row title="真人消息">
						<div className="flex shrink-0 rounded-md border border-line p-0.5" role="radiogroup" aria-label="真人消息通知">
							{MESSAGE_MODES.map(({ value, label }) => (
								<button
									key={value}
									type="button"
									role="radio"
									aria-checked={preferences.messageNotifications === value}
									disabled={!supported}
									onClick={() => value === 'off' ? set({ messageNotifications: 'off' }) : void enable(() => set({ messageNotifications: value }))}
									className={clsx(
										'rounded px-2.5 py-1 text-[13px] disabled:opacity-50',
										preferences.messageNotifications === value ? 'bg-accent-soft text-accent' : 'text-fg-2 hover:bg-hover',
									)}
								>
									{label}
								</button>
							))}
						</div>
					</Row>
					<NotifyHumans />
				</div>
				<Row title="待处理">
					<Switch
						label="待处理通知"
						checked={preferences.inboxNotifications}
						disabled={!supported}
						onChange={checked => checked ? void enable(() => set({ inboxNotifications: true })) : set({ inboxNotifications: false })}
					/>
				</Row>
				<Row title="成员出错">
					<Switch
						label="成员出错通知"
						checked={preferences.failureNotifications}
						disabled={!supported}
						onChange={checked => checked ? void enable(() => set({ failureNotifications: true })) : set({ failureNotifications: false })}
					/>
				</Row>
			</div>
			{problem && <div className="mt-2 text-[13px] text-danger">{problem}</div>}
		</section>
	);
}

/** 要提醒哪些真人：横着排，放不下换行。默认只勾第一个真人，以后新建的真人默认不勾。 */
function NotifyHumans() {
	const members = useMembers();
	const selected = useNotifyHumans();
	const set = usePreferences(state => state.set);
	const humans = (members.data ?? []).filter(member => member.type === 'human').sort((left, right) => left.createdAt - right.createdAt);
	const toggle = (memberId: string) => {
		const next = new Set(selected);
		if (next.has(memberId)) next.delete(memberId);
		else next.add(memberId);
		set({ notifyHumans: humans.map(member => member.memberId).filter(id => next.has(id)) });
	};
	return (
		<div className="-ml-2 mt-2 flex flex-wrap gap-x-1 gap-y-0.5">
			{humans.map(member => (
				<button
					key={member.memberId}
					type="button"
					role="checkbox"
					aria-checked={selected.has(member.memberId)}
					onClick={() => toggle(member.memberId)}
					className="flex min-w-0 max-w-full items-center gap-2 rounded-md px-2 py-1 text-[13px] hover:bg-hover"
				>
					<CheckMark checked={selected.has(member.memberId)} />
					<Avatar member={member} size={20} />
					<span className="truncate">{member.name}</span>
				</button>
			))}
		</div>
	);
}

function Row({ title, children }: { title: string; children: ReactNode }) {
	return (
		<div className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3 first:pt-0 last:pb-0">
			<div className="min-w-24 flex-1 text-[13px] font-medium">{title}</div>
			{children}
		</div>
	);
}
