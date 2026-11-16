import clsx from 'clsx';
import { BookOpen, ChartColumn, CircleAlert, Cloud, Cpu, Globe, Hammer, Inbox, Palette, Plug, SquareTerminal, Wrench } from 'lucide-react';
import type { ReactNode } from 'react';
import { NavLink } from 'react-router';
import { useCustomTools, useExternal, useMcp, useModels } from '../api/directory.ts';

/** 设置的分类。 */
export function SettingsList() {
	const models = useModels();
	const mcp = useMcp();
	const customTools = useCustomTools();
	const customToolsFailed = !!customTools.data && (!!customTools.data.configError || customTools.data.issues.length > 0 || customTools.data.tools.some(tool => tool.undecryptable));
	const mcpFailed = !!mcp.data && (!!mcp.data.error || mcp.data.servers.some(server => server.status === 'failed'));
	const external = useExternal();
	const externalProblem = !!external.data && (
		external.data.sources.some(source => source.status === 'failed' || source.status === 'missing')
		|| external.data.routes.some(route => !!route.problem || !!route.lastRun?.error)
	);
	const externalWarning = !!external.data && external.data.sources.some(source => !!source.warning);
	return (
		<aside className="flex min-h-0 w-full flex-1 flex-col border-r border-line bg-pane">
			<header className="flex h-12 shrink-0 items-center border-b border-line px-4">
				<span className="font-semibold">设置</span>
			</header>
			<nav className="py-1">
				<Item to="/settings/models" icon={<Cpu size={16} />} label="模型">
					{models.data?.error && <CircleAlert size={14} className="text-danger" aria-label="模型配置有误" />}
				</Item>
				<Item to="/settings/usage" icon={<ChartColumn size={16} />} label="用量" />
				<Item to="/settings/shell" icon={<SquareTerminal size={16} />} label="shell 环境" />
				<Item to="/settings/tools" icon={<Wrench size={16} />} label="工具" />
				<Item to="/settings/skills" icon={<BookOpen size={16} />} label="技能" />
				<Item to="/settings/custom-tools" icon={<Hammer size={16} />} label="自定义工具">
					{customToolsFailed && <CircleAlert size={14} className="text-danger" aria-label="自定义工具存在问题" />}
				</Item>
				<Item to="/settings/mcp" icon={<Plug size={16} />} label="MCP">
					{mcpFailed && <CircleAlert size={14} className="text-danger" aria-label="有 MCP 服务器连接失败" />}
				</Item>
				<Item to="/settings/external" icon={<Inbox size={16} />} label="事件">
					{externalProblem
						? <CircleAlert size={14} className="text-danger" aria-label="事件存在问题" />
						: externalWarning && <CircleAlert size={14} className="text-warning" aria-label="来源有警告" />}
				</Item>
				<Item to="/settings/browser" icon={<Globe size={16} />} label="浏览器" />
				<Item to="/settings/remote" icon={<Cloud size={16} />} label="公网访问" />
				<Item to="/settings/general" icon={<Palette size={16} />} label="外观和通知" />
			</nav>
		</aside>
	);
}

function Item({ to, icon, label, children }: { to: string; icon: ReactNode; label: string; children?: ReactNode }) {
	return (
		<NavLink to={to} className={({ isActive }) => clsx('mx-1.5 flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px]', isActive ? 'bg-selected' : 'hover:bg-hover')}>
			<span className="text-fg-2">{icon}</span>
			<span className="flex-1">{label}</span>
			{children}
		</NavLink>
	);
}
