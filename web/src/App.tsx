import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router';
import { subscribeEvents } from './api/events.ts';
import { useMembers } from './api/queries.ts';
import { connect, type ConnectResult } from './api/session.ts';
import { ConversationPage } from './chat/ConversationPage.tsx';
import { Shell } from './layout/Shell.tsx';
import { useIsPhone } from './lib/media.ts';
import { CreateFirstHuman } from './members/CreateFirstHuman.tsx';
import { MembersHome } from './members/MembersHome.tsx';
import { MemberTimelinePage } from './members/MemberTimelinePage.tsx';
import { usePerspectiveTarget } from './perspective/notifyHumans.ts';
import { PerspectiveHome } from './perspective/PerspectiveHome.tsx';
import { BrowserSettings } from './settings/BrowserSettings.tsx';
import { RemoteSettings } from './settings/RemoteSettings.tsx';
import { ExternalSettings } from './settings/ExternalSettings.tsx';
import { GeneralSettings } from './settings/GeneralSettings.tsx';
import { CustomToolsSettings } from './settings/CustomToolsSettings.tsx';
import { McpSettings } from './settings/McpSettings.tsx';
import { ModelsSettings } from './settings/ModelsSettings.tsx';
import { UsageSettings } from './settings/UsageSettings.tsx';
import { ShellSettings } from './settings/ShellSettings.tsx';
import { SkillEditor } from './settings/SkillEditor.tsx';
import { SkillImport } from './settings/SkillImport.tsx';
import { SkillPage } from './settings/SkillPage.tsx';
import { SkillsSettings } from './settings/SkillsSettings.tsx';
import { ToolDefaultsSettings } from './settings/ToolDefaultsSettings.tsx';
import { usePreferences } from './stores.ts';
import { CenteredMessage } from './ui/CenteredMessage.tsx';

export function App() {
	useThemeClass();
	const [state, setState] = useState<ConnectResult | 'checking'>('checking');
	const retry = () => {
		setState('checking');
		void connect().then(setState);
	};
	useEffect(retry, []);

	if (state === 'checking') return <CenteredMessage title="正在连接运行时…" />;
	if (state === 'unauthorized') {
		return <CenteredMessage title="请使用带令牌的链接打开" detail="请使用运行时启动时输出的链接打开此页面。打开一次后，当前浏览器会记住登录状态。" />;
	}
	if (state === 'offline') return <CenteredMessage title="无法连接运行时" detail="确认运行时正在运行后重试。" action={{ label: '重试', onClick: retry }} />;
	return <Connected />;
}

function Connected() {
	const queryClient = useQueryClient();
	useEffect(() => subscribeEvents(queryClient), [queryClient]);
	const members = useMembers();

	if (members.isPending) return <CenteredMessage title="正在加载…" />;
	if (members.isError) return <CenteredMessage title="加载成员失败" detail={members.error.message} action={{ label: '重试', onClick: () => void members.refetch() }} />;
	// 还没有真人成员时，先建一个代表使用者自己。
	if (!members.data.some(member => member.type === 'human')) return <CreateFirstHuman />;

	return (
		<Routes>
			<Route element={<Shell />}>
				<Route index element={<MembersHome />} />
				<Route path="members/:memberId" element={<MemberTimelinePage />} />
				<Route path="as" element={<PerspectiveRedirect />} />
				<Route path="as/:perspectiveId" element={<PerspectiveHome />} />
				<Route path="as/:perspectiveId/:kind/:targetId" element={<ConversationPage />} />
				<Route path="settings" element={<SettingsHome />} />
				<Route path="settings/models" element={<ModelsSettings />} />
				<Route path="settings/usage" element={<UsageSettings />} />
				<Route path="settings/tools" element={<ToolDefaultsSettings />} />
				<Route path="settings/skills" element={<SkillsSettings />} />
				<Route path="settings/skills/new" element={<SkillEditor />} />
				<Route path="settings/skills/import" element={<SkillImport />} />
				<Route path="settings/skills/:name" element={<SkillPage />} />
				<Route path="settings/skills/:name/edit" element={<SkillEditor />} />
				<Route path="settings/custom-tools" element={<CustomToolsSettings />} />
				<Route path="settings/mcp" element={<McpSettings />} />
				<Route path="settings/external" element={<ExternalSettings />} />
				<Route path="settings/browser" element={<BrowserSettings />} />
				<Route path="settings/remote" element={<RemoteSettings />} />
				<Route path="settings/shell" element={<ShellSettings />} />
				<Route path="settings/general" element={<GeneralSettings />} />
				<Route path="*" element={<Navigate to="/" replace />} />
			</Route>
		</Routes>
	);
}

/** /as：和图标栏的「视角」去同一个地方。 */
function PerspectiveRedirect() {
	return <Navigate to={usePerspectiveTarget().path} replace />;
}

/** 按偏好和系统设置给 html 加上或去掉 dark。 */
function useThemeClass(): void {
	const theme = usePreferences(state => state.theme);
	useEffect(() => {
		const media = window.matchMedia('(prefers-color-scheme: dark)');
		const apply = () => document.documentElement.classList.toggle('dark', theme === 'dark' || (theme === 'system' && media.matches));
		apply();
		media.addEventListener('change', apply);
		return () => media.removeEventListener('change', apply);
	}, [theme]);
}

/** 设置首页：手机上显示设置列表（由外层布局显示），其他时候直接打开模型设置。 */
function SettingsHome() {
	return useIsPhone() ? null : <Navigate to="/settings/models" replace />;
}
