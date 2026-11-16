import { useQuery, type QueryClient } from '@tanstack/react-query';
import { create } from 'zustand';
import { api } from './client.ts';
import { queryKeys } from './keys.ts';
import type { IDirectoryListing, IPortableGitProgressEvent, IRemoteStatus, ISandboxStatus, IShell, ITerminalInfo, ITerminalOutputEvent, PortableGitState } from './types.ts';

export interface IShellEnvironment {
	readonly portableGit: PortableGitState;
	readonly shell: IShell;
}

/** 运行时所在的系统（Node 的 process.platform），认路径时用；还没取到时是 undefined。 */
export function useRuntimePlatform(): string | undefined {
	return useQuery({ queryKey: queryKeys.runtimeState, queryFn: () => api<{ platform: string }>('GET', '/v1/state') }).data?.platform;
}

export function useShellEnvironment() {
	return useQuery({
		queryKey: queryKeys.portableGit,
		queryFn: () => api<IShellEnvironment>('GET', '/v1/portable-git'),
	});
}

export function useSandbox() {
	return useQuery({
		queryKey: queryKeys.sandbox,
		queryFn: () => api<ISandboxStatus>('GET', '/v1/sandbox'),
	});
}

/** 公网访问：cloudflared 的状态、隧道进程、设置。 */
export function useRemote() {
	return useQuery({
		queryKey: queryKeys.remote,
		queryFn: () => api<IRemoteStatus>('GET', '/v1/remote'),
	});
}

/** 这个工作目录的命令不在沙箱里执行的原因；沙箱没打开、或放得进沙箱时没有。 */
export function useSandboxProblem(directory: string | null | undefined): string | undefined {
	const sandbox = useSandbox();
	return directory ? sandbox.data?.problems.find(problem => problem.directory === directory)?.reason : undefined;
}

/** 运行时所在机器上一个目录的子目录；path 为 null 时只看用户目录和各个盘符。 */
export function useDirectories(path: string | null) {
	return useQuery({
		queryKey: queryKeys.directories(path),
		queryFn: () => api<IDirectoryListing>('GET', path === null ? '/v1/directories' : `/v1/directories?path=${encodeURIComponent(path)}`),
	});
}

/** 下载进度只靠增量推送，直接改缓存里的状态。 */
export function applyPortableGitProgress(queryClient: QueryClient, event: IPortableGitProgressEvent): void {
	queryClient.setQueryData<IShellEnvironment>(queryKeys.portableGit, current => current?.portableGit.kind === 'downloading'
		? { ...current, portableGit: { ...current.portableGit, receivedBytes: event.receivedBytes, totalBytes: event.totalBytes } }
		: current);
}

export function useTerminals() {
	return useQuery({
		queryKey: queryKeys.terminals,
		queryFn: async () => (await api<{ terminals: ITerminalInfo[] }>('GET', '/v1/terminals')).terminals,
	});
}

type OutputListener = (event: ITerminalOutputEvent) => void;
const outputListeners = new Map<string, Set<OutputListener>>();

/** 收听某个终端的输出，返回取消函数。 */
export function onTerminalOutput(terminalId: string, listener: OutputListener): () => void {
	let listeners = outputListeners.get(terminalId);
	if (!listeners) outputListeners.set(terminalId, listeners = new Set());
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
		if (listeners.size === 0) outputListeners.delete(terminalId);
	};
}

export function emitTerminalOutput(event: ITerminalOutputEvent): void {
	markOutput(event.terminalId);
	for (const listener of outputListeners.get(event.terminalId) ?? []) listener(event);
}

/** 停下来这么久没有新输出，就不算在输出了。 */
const QUIET_MS = 2000;
const lastOutputAt = new Map<string, number>();

/** 正在输出的终端。只在开始输出、安静下来时更新，输出再频繁也不会每次都重画。 */
export const useOutputtingTerminals = create<{ ids: ReadonlySet<string> }>(() => ({ ids: new Set() }));

function markOutput(terminalId: string): void {
	lastOutputAt.set(terminalId, Date.now());
	if (useOutputtingTerminals.getState().ids.has(terminalId)) return;
	useOutputtingTerminals.setState(state => ({ ids: new Set([...state.ids, terminalId]) }));
	const check = () => {
		const quiet = Date.now() - lastOutputAt.get(terminalId)!;
		if (quiet < QUIET_MS) {
			setTimeout(check, QUIET_MS - quiet);
			return;
		}
		lastOutputAt.delete(terminalId);
		useOutputtingTerminals.setState(state => ({ ids: new Set([...state.ids].filter(id => id !== terminalId)) }));
	};
	setTimeout(check, QUIET_MS);
}
