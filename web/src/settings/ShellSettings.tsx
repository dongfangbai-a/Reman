import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useQueryClient } from '@tanstack/react-query';
import { CircleAlert, Ellipsis } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../api/client.ts';
import { queryKeys } from '../api/keys.ts';
import { useSandbox, useShellEnvironment, type IShellEnvironment } from '../api/system.ts';
import type { ISandboxNetwork, ISandboxStatus, IShell, PortableGitState, SandboxNetworkMode } from '../api/types.ts';
import { errorMessage } from '../lib/errors.ts';
import { BackLink } from '../ui/BackLink.tsx';
import { Button, IconButton } from '../ui/Button.tsx';
import { Choice } from '../ui/Choice.tsx';
import { ConfirmDialog, INPUT_CLASS } from '../ui/Dialog.tsx';
import { MenuContent, MenuItem } from '../ui/Menu.tsx';
import { Switch } from '../ui/Switch.tsx';
import { SettingsPage } from './SettingsPage.tsx';

/** shell 环境：当前使用的 shell（Windows 上没有 Git Bash 时可以装 PortableGit）、沙箱。 */
export function ShellSettings() {
	const environment = useShellEnvironment();
	const data = environment.data;
	return (
		<SettingsPage>
			<BackLink to="/settings" label="设置" />
			<h1 className="mb-6 text-xl font-semibold">shell 环境</h1>
			{environment.isPending && <div className="text-center text-[13px] text-fg-3">正在加载…</div>}
			{environment.isError && <div className="text-[13px] text-danger">加载失败：{environment.error.message}</div>}
			{data && (
				<div className="space-y-4">
					<section className="rounded-xl border border-line bg-raised p-5">
						<h2 className="mb-1 font-semibold">当前使用的 shell</h2>
						<div className="mb-3 text-[13px] text-fg-2">AI 成员执行命令和打开终端均使用该 shell。</div>
						<InstallGitBash state={data.portableGit.kind !== 'unsupported' && data.portableGit.kind !== 'installed' && data.shell.label !== 'Git Bash' ? data.portableGit : undefined}>
							<div className="text-[13px] font-medium">{data.shell.label}</div>
							<div className="mt-0.5 break-all font-mono text-xs text-fg-3">{data.shell.executable}</div>
						</InstallGitBash>
					</section>
					<Sandbox shell={data.shell} />
				</div>
			)}
		</SettingsPage>
	);
}

function Sandbox({ shell }: { shell: IShell }) {
	const sandbox = useSandbox();
	const queryClient = useQueryClient();
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string>();
	const [confirming, setConfirming] = useState(false);
	const call = async (method: 'PUT' | 'POST', path: string, body?: unknown) => {
		setError(undefined);
		setPending(true);
		try {
			await api(method, path, body);
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setPending(false);
			void queryClient.invalidateQueries({ queryKey: queryKeys.sandbox });
		}
	};
	const status = sandbox.data;
	const state = status?.state;
	const busy = state?.kind === 'installing' || state?.kind === 'uninstalling';

	return (
		<section className="rounded-xl border border-line bg-raised p-5">
			<div className="mb-1 flex items-center gap-1">
				<h2 className="flex-1 font-semibold">沙箱</h2>
				{status?.installed && (
					<DropdownMenu.Root>
						<DropdownMenu.Trigger asChild>
							<IconButton label="更多操作" disabled={pending || busy}><Ellipsis size={18} /></IconButton>
						</DropdownMenu.Trigger>
						<MenuContent align="end">
							<MenuItem className="text-danger" onSelect={() => setConfirming(true)}>卸载</MenuItem>
						</MenuContent>
					</DropdownMenu.Root>
				)}
				{status && <Switch checked={status.enabled} label="沙箱" disabled={pending || busy} onChange={enabled => void call('PUT', '/v1/sandbox', { enabled })} />}
			</div>
			<div className="text-[13px] text-fg-2">AI 成员的命令在沙箱中执行，无需审批。命令只能修改成员工作目录中的文件。</div>
			{sandbox.isError && <div className="mt-3 text-[13px] text-danger">加载失败：{sandbox.error.message}</div>}
			{state?.kind === 'checking' && <div className="mt-3 text-[13px] text-fg-2">正在检查…</div>}
			{state?.kind === 'installing' && <div className="mt-3 text-[13px] text-fg-2">{state.granting ? '正在安装，需要几分钟…' : '正在安装，请在系统弹出的窗口中允许'}</div>}
			{state?.kind === 'uninstalling' && <div className="mt-3 text-[13px] text-fg-2">正在卸载，请在系统弹出的窗口中允许</div>}
			{state?.kind === 'notInstalled' && (
				<div className="mt-3 flex items-center justify-between gap-3 text-[13px] text-fg-2">
					<span>尚未安装</span>
					<Button className="shrink-0" disabled={pending} onClick={() => void call('POST', '/v1/sandbox/install')}>安装</Button>
				</div>
			)}
			{(state?.kind === 'failed' || state?.kind === 'unsupported') && (
				<div className="mt-3 flex items-start gap-1.5 text-[13px] text-danger"><CircleAlert size={14} className="mt-0.5 shrink-0" /><span className="break-all">{state.reason}</span></div>
			)}
			{state?.kind === 'ready' && (shell.kind === 'pwsh' || shell.kind === 'powershell') && (
				<div className="mt-3 text-[13px] text-fg-2">沙箱中只能使用 bash，当前的命令未在沙箱中执行</div>
			)}
			{error && <div className="mt-2 text-[13px] text-danger">操作失败：{error}</div>}
			<ConfirmDialog
				open={confirming}
				onOpenChange={setConfirming}
				title="卸载沙箱"
				detail="沙箱中正在执行的命令将被终止。此后再次开启须重新安装。"
				confirmLabel="卸载"
				onConfirm={() => {
					setConfirming(false);
					void call('POST', '/v1/sandbox/uninstall');
				}}
			/>
			{status && <SandboxNetwork network={status.network} problem={status.networkProblem} />}
		</section>
	);
}

const NETWORK_LABELS: Record<SandboxNetworkMode, string> = { none: '不允许', all: '全部允许', allow: '仅允许以下地址', deny: '允许以下地址之外的所有地址' };

/** 沙箱里的命令能连哪些地址。改了立即保存；切到「全部允许」再切回来时名单还在。 */
function SandboxNetwork({ network, problem }: { network: ISandboxNetwork; problem: string | null }) {
	const queryClient = useQueryClient();
	const [input, setInput] = useState('');
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const [lastHosts, setLastHosts] = useState<readonly string[]>(network.hosts);
	useEffect(() => {
		if (network.hosts.length > 0) setLastHosts(network.hosts);
	}, [network.hosts]);

	const save = async (mode: SandboxNetworkMode, hosts: readonly string[]): Promise<ISandboxStatus | undefined> => {
		setError(undefined);
		setBusy(true);
		try {
			const status = await api<ISandboxStatus>('PUT', '/v1/sandbox', { network: mode === 'all' || mode === 'none' ? mode : { [mode]: hosts } });
			queryClient.setQueryData(queryKeys.sandbox, status);
			if (mode === 'allow' || mode === 'deny') setLastHosts(status.network.hosts);
			return status;
		} catch (caught) {
			setError(errorMessage(caught));
			return undefined;
		} finally {
			setBusy(false);
		}
	};
	// 运行时会规范化（整个网址只取主机名和端口、统一小写）并去掉重复，保存后条数没变就是已经有了。
	const add = async () => {
		if (!input.trim() || network.mode === 'all' || network.mode === 'none') return;
		const status = await save(network.mode, [...network.hosts, input.trim()]);
		if (!status) return;
		setInput('');
		if (status.network.hosts.length === network.hosts.length) setError('已存在');
	};
	const listed = network.mode === 'allow' || network.mode === 'deny';

	return (
		<div className="mt-4 border-t border-line pt-4">
			<div className="flex flex-wrap items-center gap-x-3 gap-y-2">
				<span className="text-[13px] font-medium">网络</span>
				<div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="沙箱中的命令可访问的地址">
					{(Object.keys(NETWORK_LABELS) as SandboxNetworkMode[]).map(mode => (
						<Choice
							key={mode}
							checked={network.mode === mode && !problem}
							disabled={busy}
							onClick={() => void save(mode, mode === 'allow' || mode === 'deny' ? (network.hosts.length ? network.hosts : lastHosts) : [])}
						>
							{NETWORK_LABELS[mode]}
						</Choice>
					))}
				</div>
			</div>
			{problem && <div className="mt-2 flex items-start gap-1.5 text-[13px] text-danger"><CircleAlert size={14} className="mt-0.5 shrink-0" /><span className="break-all">{problem}</span></div>}
			{listed && !problem && (
				<div className="mt-3 rounded-lg border border-line">
					{network.hosts.length > 0 && (
						<div className="divide-y divide-line border-b border-line">
							{network.hosts.map(host => (
								<div key={host} className="flex h-10 items-center gap-3 pr-2 pl-3 text-[13px]">
									<span className="min-w-0 flex-1 truncate font-mono">{host}</span>
									<Button variant="ghost" className="shrink-0 text-fg-2" disabled={busy} onClick={() => void save(network.mode, network.hosts.filter(item => item !== host))}>删除</Button>
								</div>
							))}
						</div>
					)}
					<form className="flex gap-2 p-3" onSubmit={event => {
						event.preventDefault();
						void add();
					}}>
						<input
							value={input}
							onChange={event => {
								setInput(event.target.value);
								setError(undefined);
							}}
							placeholder="域名或地址，如 github.com、192.168.1.10:8080"
							aria-label="要添加的地址"
							className={INPUT_CLASS}
							spellCheck={false}
						/>
						<Button type="submit" className="shrink-0" disabled={busy || !input.trim()}>添加</Button>
					</form>
				</div>
			)}
			{error && <div className="mt-2 text-[13px] text-danger">{error}</div>}
			<div className="mt-2 text-xs text-fg-3">域名包含其子域名；未指定端口时适用于所有端口。本机地址始终可以访问。</div>
		</div>
	);
}

/** 当前 shell 那一行：Windows 上没有 Git Bash 时（state 不是 undefined）右边是安装 PortableGit 的操作，下载中下面是进度。 */
function InstallGitBash({ state, children }: { state: PortableGitState | undefined; children: ReactNode }) {
	const queryClient = useQueryClient();
	const [error, setError] = useState<string>();
	const call = async (path: 'install' | 'cancel') => {
		setError(undefined);
		try {
			const result = await api<{ portableGit?: PortableGitState }>('POST', `/v1/portable-git/${path}`);
			if (result.portableGit) queryClient.setQueryData<IShellEnvironment>(queryKeys.portableGit, current => current && { ...current, portableGit: result.portableGit! });
		} catch (caught) {
			setError(errorMessage(caught));
		}
	};
	return (
		<>
			<div className="flex items-start gap-3">
				<div className="min-w-0 flex-1">{children}</div>
				{state?.kind === 'notInstalled' && <Button className="shrink-0" onClick={() => void call('install')}>安装 Git Bash</Button>}
				{state?.kind === 'downloading' && <Button className="shrink-0" onClick={() => void call('cancel')}>取消</Button>}
				{state?.kind === 'verifying' && <span className="shrink-0 text-xs text-fg-2">正在校验…</span>}
				{state?.kind === 'extracting' && <span className="shrink-0 text-xs text-fg-2">正在解压，需要一两分钟…</span>}
				{state?.kind === 'failed' && <Button className="shrink-0" onClick={() => void call('install')}>重试</Button>}
			</div>
			{state?.kind === 'downloading' && (
				<div className="mt-3">
					<div className="h-1 overflow-hidden rounded-full bg-line">
						<div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${state.totalBytes > 0 ? Math.min(100, state.receivedBytes / state.totalBytes * 100) : 0}%` }} />
					</div>
					<div className="mt-1 flex justify-between gap-3 text-xs text-fg-3">
						<span>已下载 {megabytes(state.receivedBytes)} / {megabytes(state.totalBytes)} MB</span>
						<span className="truncate">来自 {host(state.source)}</span>
					</div>
				</div>
			)}
			{state?.kind === 'failed' && <div className="mt-2 flex items-start gap-1.5 text-[13px] text-danger"><CircleAlert size={14} className="mt-0.5 shrink-0" /><span className="break-all">安装失败：{state.error}</span></div>}
			{error && <div className="mt-2 text-[13px] text-danger">操作失败：{error}</div>}
		</>
	);
}

function megabytes(bytes: number): string {
	return (bytes / 1024 / 1024).toFixed(1);
}

function host(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}
