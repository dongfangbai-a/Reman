import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	SandboxManager, VENDORED_SRT_WIN_EXE, checkWindowsDependenciesAsync, getWindowsSandboxUserStatusAsync, installWindowsSandboxAsync, resolveSrtWin,
	type SandboxRuntimeConfig,
} from '@anthropic-ai/sandbox-runtime';
import { errorMessage, invalid } from '../common/errors.ts';
import { readJsonFile } from '../common/json.ts';
import type { IShell } from '../shells/shells.ts';
import { contains } from '../tools/paths.ts';
import { sensitivePaths } from '../tools/protection.ts';
import { ALLOW_ALL, parseNetwork, serializeNetwork } from './network.ts';
import type { HostMessage, HostRequest } from './protocol.ts';
import type { ISandboxNetwork, ISandboxStatus, SandboxState } from './sandboxState.ts';

export type { ISandboxStatus, SandboxState } from './sandboxState.ts';

const HOST_SCRIPT = fileURLToPath(new URL('./host.ts', import.meta.url));
const UNINSTALL_SCRIPT = fileURLToPath(new URL('./uninstall.ts', import.meta.url));
/** Windows 上沙箱里用的 curl：Git Bash 自带的只用 Schannel，沙箱账户里访问不了 HTTPS。见 vendor/curl/README.md。 */
export const WINDOWS_CURL_DIRECTORY = fileURLToPath(new URL('../../vendor/curl', import.meta.url));
/**
 * Windows 上沙箱里的命令不登录，也不带用户的登录环境（会把用户的变量带进沙箱），只补语言：
 * 和 Git Bash 的 /etc/profile.d/lang.sh 一样，没设时取 locale -uU。没有它时命令按字节处理中文。
 */
const WINDOWS_LANG = 'test -n "${LC_ALL:-${LC_CTYPE:-$LANG}}" || export LANG=$(exec /usr/bin/locale -uU)';
/**
 * Windows 上 srt 代理用的端口范围，要和安装时的一样。避开 Hyper-V、Docker 在动态端口范围（49152 以上）里保留的端口，
 * 端口数够多个沙箱进程同时用。
 */
export const WINDOWS_PROXY_PORT_RANGE: readonly [number, number] = [40080, 40139];
/** 沙箱进程正常退出最多等多久，到了就强行结束。 */
const STOP_TIMEOUT_MS = 5000;
/** 找工作目录里的 git 仓库时最多看几层、看多少个目录。 */
const GIT_SEARCH_DEPTH = 3;
const GIT_SEARCH_LIMIT = 2000;

/** 这个工作目录的命令在不在沙箱里执行；不在时写原因。 */
export type SandboxPlacement = { readonly sandboxed: true } | { readonly sandboxed: false; readonly reason: string };

/** 运行时自己的数据：沙箱里能读，令牌和密钥、成员浏览器的数据、数据库除外；workspaces 以外都不能当工作目录。 */
export interface ISandboxData {
	readonly dataDirectory: string;
	readonly workspacesDirectory: string;
}

export interface ISandboxOptions {
	/** 开关和网络设置存在这里；不给时只在内存里。默认关，网络全部允许。 */
	readonly settingsPath?: string;
	readonly data?: ISandboxData;
	/** 沙箱账户还要能读的目录，如运行时自己装的 Git。 */
	readonly readDirectories?: () => readonly string[];
	/** 有成员在用的工作目录：没人在用、也没有命令在跑的沙箱进程退出。 */
	readonly workingDirectories: () => Iterable<string>;
	/** 状态、开关、放不进沙箱的工作目录变了。 */
	readonly onChange?: () => void;
}

/** 沙箱里执行完的命令。error 是没能启动的原因。 */
export interface ISandboxExit {
	readonly exitCode: number | null;
	readonly signal: string | null;
	readonly violations: readonly string[];
	readonly error?: string;
}

/** 沙箱里正在执行的命令。 */
export interface ISandboxCommand {
	readonly exited: Promise<ISandboxExit>;
	kill(): void;
}

/**
 * 命令的沙箱，用 srt（@anthropic-ai/sandbox-runtime）。srt 的配置一个进程只有一份、可写目录在会话开始时定好，
 * 所以每个工作目录起一个沙箱进程（host.ts），用同一个工作目录的成员共用。沙箱进程退出时，它启动的命令一起结束，
 * 所以有命令在跑时不退出。见设计文档「沙箱」。
 */
export class Sandbox {
	private readonly options: ISandboxOptions;
	private enabled: boolean;
	private network: ISandboxNetwork;
	/** sandbox.json 里的网络设置写错了的原因：照不允许处理。 */
	private networkProblem: string | null;
	/** 写回文件的 network：写错了时保持文件里原来的样子。 */
	private networkSource: unknown;
	private current: SandboxState = { kind: 'checking' };
	/** Windows 上装好了；还没检查过时是 undefined。 */
	private installed: boolean | undefined;
	private checking: Promise<SandboxState> | undefined;
	private readonly hosts = new Map<string, Host>();
	/** 放不进沙箱的工作目录和原因，重新打开开关前不再试。 */
	private readonly failures = new Map<string, string>();

	constructor(options: ISandboxOptions) {
		this.options = options;
		const settings = readSettings(options.settingsPath);
		this.enabled = settings.enabled;
		this.network = settings.network;
		this.networkProblem = settings.networkProblem;
		this.networkSource = settings.networkSource;
		if (this.enabled) void this.check();
		else this.current = { kind: 'off' };
	}

	state(): SandboxState {
		return this.current;
	}

	/** 给网页端的状态。还没检查过是否装好时先检查。 */
	async status(): Promise<ISandboxStatus> {
		if (this.installed === undefined && !this.busy) await this.check();
		const problems = this.current.kind !== 'ready' ? [] : [...new Set(this.options.workingDirectories())].flatMap(directory => {
			const reason = this.failures.get(directoryKey(directory)) ?? dataOverlap(directory, this.options.data);
			return reason ? [{ directory, reason }] : [];
		});
		return { enabled: this.enabled, state: this.current, installed: this.installed === true, problems, network: this.network, networkProblem: this.networkProblem };
	}

	/** 检查沙箱能不能用：没装、平台不支持、srt 报错时写原因。检查时开关变了就重新检查。 */
	check(): Promise<SandboxState> {
		this.checking ??= (async () => {
			let enabled: boolean;
			let state: SandboxState;
			do {
				enabled = this.enabled;
				state = await this.detect();
			} while (enabled !== this.enabled);
			this.checking = undefined;
			this.setState(state);
			return state;
		})();
		return this.checking;
	}

	/** 打开或关上。打开时 Windows 上没装过就安装；关上只是不用了，不卸载。安装、卸载要等很久，这里只是开始。 */
	setEnabled(enabled: boolean): void {
		if (this.busy) throw invalid('正在安装或卸载沙箱，请在完成后再修改');
		this.enabled = enabled;
		this.failures.clear();
		this.save();
		if (!enabled) {
			this.setState({ kind: 'off' });
			this.prune();
			return;
		}
		this.setState({ kind: 'checking' });
		void this.check().then(state => {
			if (state.kind === 'notInstalled') void this.doInstall();
		});
	}

	/** 改网络设置：立即发给每个沙箱进程，之后的连接按新的。有一项不对时报错，什么都不改。 */
	setNetwork(value: unknown): void {
		let network: ISandboxNetwork;
		try {
			network = parseNetwork(value);
		} catch (error) {
			throw invalid(errorMessage(error));
		}
		this.network = network;
		this.networkProblem = null;
		this.networkSource = serializeNetwork(network);
		this.save();
		for (const host of this.hosts.values()) host.setNetwork(network);
		this.options.onChange?.();
	}

	/** Windows 上安装：弹一次系统的确认窗口，建沙箱账户和网络过滤规则，授权读用户目录。用户在窗口里取消时开关回到关。 */
	install(): void {
		if (process.platform !== 'win32') throw invalid('仅 Windows 需要安装沙箱');
		if (this.busy) throw invalid('正在安装或卸载沙箱');
		void this.doInstall();
	}

	/** Windows 上卸载：结束沙箱里的命令，删掉沙箱账户和网络过滤规则，开关回到关。 */
	uninstall(): void {
		if (process.platform !== 'win32') throw invalid('仅 Windows 支持卸载沙箱');
		if (this.busy) throw invalid('正在安装或卸载沙箱');
		void this.doUninstall();
	}

	/** 这个工作目录的命令在不在沙箱里执行。第一次用到一个工作目录时启动它的沙箱进程，等它准备好。 */
	async placement(workingDirectory: string, shell: IShell): Promise<SandboxPlacement> {
		const state = this.current.kind === 'checking' ? await this.check() : this.current;
		if (state.kind !== 'ready') return { sandboxed: false, reason: stateReason(state) };
		// 命令前面要用 export 设环境变量。
		if (shell.kind === 'pwsh' || shell.kind === 'powershell') return { sandboxed: false, reason: '沙箱中只能使用 bash' };
		const key = directoryKey(workingDirectory);
		const failure = this.failures.get(key) ?? dataOverlap(workingDirectory, this.options.data);
		if (failure) return { sandboxed: false, reason: failure };
		let host = this.hosts.get(key);
		if (!host) {
			host = new Host(this.config(workingDirectory), this.network, () => {
				if (this.hosts.get(key) === host) this.hosts.delete(key);
			}, () => this.prune());
			this.hosts.set(key, host);
		}
		const error = await host.ready;
		if (error === undefined) return { sandboxed: true };
		this.failures.set(key, `启动沙箱失败：${error}`);
		this.options.onChange?.();
		return { sandboxed: false, reason: `启动沙箱失败：${error}` };
	}

	/** 在工作目录的沙箱进程里执行 bash 命令；先用 placement 确认放得进沙箱。 */
	run(workingDirectory: string, shell: string, command: string, onOutput: (text: string) => void): ISandboxCommand {
		const host = this.hosts.get(directoryKey(workingDirectory));
		if (!host?.isReady) throw new Error('该工作目录的沙箱进程尚未就绪');
		const full = process.platform === 'win32' ? `export PATH="${bashPath(WINDOWS_CURL_DIRECTORY)}:$PATH"\n${WINDOWS_LANG}\n${command}` : command;
		return host.run({ command: full, cwd: workingDirectory, shell, denyWrite: gitProtectedPaths(workingDirectory) }, onOutput);
	}

	/** 没人在用、也没有命令在跑的沙箱进程退出；沙箱用不了时（关上了、在卸载）不管有没有人在用。 */
	prune(): void {
		const used = new Set(this.current.kind === 'ready' ? [...this.options.workingDirectories()].map(directoryKey) : []);
		for (const [key, host] of this.hosts) {
			if (!used.has(key) && !host.busy) {
				this.hosts.delete(key);
				void host.stop();
			}
		}
	}

	/** 结束全部沙箱进程，里面的命令一起结束。 */
	async shutdown(): Promise<void> {
		const hosts = [...this.hosts.values()];
		this.hosts.clear();
		await Promise.all(hosts.map(host => host.stop()));
	}

	private save(): void {
		const network = this.networkSource;
		if (this.options.settingsPath) writeFileSync(this.options.settingsPath, `${JSON.stringify({ enabled: this.enabled, ...network !== undefined && { network } }, null, '\t')}\n`);
	}

	private get busy(): boolean {
		return this.current.kind === 'installing' || this.current.kind === 'uninstalling';
	}

	private setState(state: SandboxState): void {
		this.current = state;
		this.options.onChange?.();
	}

	private async detect(): Promise<SandboxState> {
		try {
			if (!SandboxManager.isSupportedPlatform()) {
				this.installed = false;
				return this.enabled ? { kind: 'unsupported', reason: '当前系统不支持' } : { kind: 'off' };
			}
			if (process.platform === 'win32') {
				const srtWin = resolveSrtWin({ path: VENDORED_SRT_WIN_EXE });
				const user = await getWindowsSandboxUserStatusAsync({ srtWin });
				this.installed = user.provisioned;
				if (!this.enabled) return { kind: 'off' };
				if (!user.provisioned) return { kind: 'notInstalled' };
				const check = await checkWindowsDependenciesAsync({ allowLoopback: true, proxyPortRange: WINDOWS_PROXY_PORT_RANGE, srtWin });
				return check.errors.length ? { kind: 'failed', reason: check.errors.join('；') } : { kind: 'ready' };
			}
			this.installed = false;
			if (!this.enabled) return { kind: 'off' };
			const check = await SandboxManager.checkDependenciesAsync();
			return check.errors.length ? { kind: 'unsupported', reason: check.errors.join('；') } : { kind: 'ready' };
		} catch (error) {
			return this.enabled ? { kind: 'failed', reason: errorMessage(error) } : { kind: 'off' };
		}
	}

	private async doInstall(): Promise<void> {
		this.setState({ kind: 'installing', granting: false });
		try {
			const result = await installWindowsSandboxAsync({
				proxyPortRange: WINDOWS_PROXY_PORT_RANGE, allowLoopback: true, srtWin: resolveSrtWin({ path: VENDORED_SRT_WIN_EXE }),
				onProfileGrantStart: () => this.setState({ kind: 'installing', granting: true }),
			});
			if (result.cancelled) {
				this.enabled = false;
				this.save();
			}
		} catch (error) {
			this.setState({ kind: 'failed', reason: `安装失败：${errorMessage(error)}` });
			return;
		}
		this.setState({ kind: 'checking' });
		await this.check();
	}

	private async doUninstall(): Promise<void> {
		this.setState({ kind: 'uninstalling' });
		await this.shutdown();
		const result = await new Promise<{ cancelled?: boolean; error?: string }>(resolveResult => {
			const child = fork(UNINSTALL_SCRIPT, [], { stdio: 'ignore', execArgv: ['--disable-warning=ExperimentalWarning'], windowsHide: true });
			let received: { cancelled?: boolean; error?: string } | undefined;
			child.on('message', message => received = message as typeof received);
			child.on('error', error => resolveResult({ error: error.message }));
			child.on('exit', code => resolveResult(received ?? { error: `卸载进程已退出（退出码 ${code}）` }));
		});
		if (result.error !== undefined) {
			this.setState({ kind: 'failed', reason: `卸载失败：${result.error}` });
			return;
		}
		if (!result.cancelled) {
			this.enabled = false;
			this.save();
		}
		this.setState({ kind: 'checking' });
		await this.check();
	}

	private config(workingDirectory: string): SandboxRuntimeConfig {
		return sandboxConfig(workingDirectory, this.options.data, this.options.readDirectories?.() ?? []);
	}
}

/**
 * 一个工作目录的沙箱配置：只能写工作目录；能读数据目录（成员要读 INDEX.md、技能和其他成员的配置），
 * 令牌和密钥、成员浏览器的数据、数据库除外（还不存在的，srt 会建一个占位的再禁止读）。网络按用户的设置在沙箱进程的回调里判断，本机端口放开。
 */
export function sandboxConfig(workingDirectory: string, data: ISandboxData | undefined, readDirectories: readonly string[]): SandboxRuntimeConfig {
	const windows = process.platform === 'win32';
	return {
		network: { allowedDomains: [], deniedDomains: [], allowLocalBinding: true },
		filesystem: {
			allowWrite: [workingDirectory],
			denyWrite: [],
			allowRead: [...data ? [data.dataDirectory] : [], ...readDirectories, ...windows ? [dirname(VENDORED_SRT_WIN_EXE), WINDOWS_CURL_DIRECTORY] : []],
			denyRead: data ? sensitivePaths(data.dataDirectory) : [],
		},
		...windows && { windows: { proxyPortRange: [...WINDOWS_PROXY_PORT_RANGE], srtWin: { path: VENDORED_SRT_WIN_EXE } } },
	} as SandboxRuntimeConfig;
}

/** 工作目录和运行时的数据重叠时放不进沙箱：沙箱里整个工作目录可写，受保护的数据也就能写了。 */
export function dataOverlap(workingDirectory: string, data: ISandboxData | undefined): string | undefined {
	if (!data) return undefined;
	for (const path of [workingDirectory, realPath(workingDirectory)]) {
		if (contains(path, data.dataDirectory)) return '工作目录包含运行时的数据目录';
		if (contains(data.dataDirectory, path) && !contains(data.workspacesDirectory, path)) return '工作目录位于运行时的数据目录中';
	}
	return undefined;
}

/**
 * 工作目录里已有仓库的 .git/hooks、.git/config：git 会执行里面写的程序，沙箱里改了它们，以后在沙箱外执行 git 时就会运行。
 * srt 在 Windows 上没挡住，每条命令单独禁止写。只看几层，跳过 node_modules 和其他点开头的目录。
 */
export function gitProtectedPaths(workingDirectory: string): string[] {
	const paths: string[] = [];
	let visited = 0;
	const visit = (directory: string, depth: number) => {
		if (visited++ >= GIT_SEARCH_LIMIT) return;
		let entries;
		try {
			entries = readdirSync(directory, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const path = join(directory, entry.name);
			if (entry.name === '.git') {
				for (const name of ['hooks', 'config']) if (existsSync(join(path, name))) paths.push(join(path, name));
			} else if (depth < GIT_SEARCH_DEPTH && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
				visit(path, depth + 1);
			}
		}
	};
	visit(workingDirectory, 0);
	return paths;
}

function stateReason(state: SandboxState): string {
	switch (state.kind) {
		case 'off': return '沙箱未开启';
		case 'checking': return '正在检查沙箱';
		case 'installing': return '正在安装沙箱';
		case 'uninstalling': return '正在卸载沙箱';
		case 'notInstalled': return '沙箱未安装';
		case 'unsupported': return `沙箱不可用：${state.reason}`;
		case 'failed': return `沙箱不可用：${state.reason}`;
		case 'ready': return '';
	}
}

/** Windows 路径在 Git Bash 里的写法，放在双引号里用：E:\a\b → /e/a/b。 */
function bashPath(path: string): string {
	return path.replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`).replace(/\\/g, '/').replace(/["$`]/g, '\\$&');
}

interface ISettings {
	readonly enabled: boolean;
	readonly network: ISandboxNetwork;
	readonly networkProblem: string | null;
	readonly networkSource: unknown;
}

/** 读 sandbox.json。读不出来时当作关着；网络设置写错时照不允许处理并记下原因：写错了不该变成放开。 */
function readSettings(path: string | undefined): ISettings {
	const empty: ISettings = { enabled: false, network: ALLOW_ALL, networkProblem: null, networkSource: undefined };
	if (!path || !existsSync(path)) return empty;
	let parsed: { enabled?: unknown; network?: unknown };
	try {
		parsed = readJsonFile(path) as typeof parsed;
	} catch (error) {
		console.error(`无法读取沙箱设置 ${path}：`, error);
		return empty;
	}
	const enabled = parsed.enabled === true;
	if (parsed.network === undefined) return { ...empty, enabled };
	try {
		return { enabled, network: parseNetwork(parsed.network), networkProblem: null, networkSource: parsed.network };
	} catch (error) {
		return { enabled, network: { mode: 'none', hosts: [] }, networkProblem: `sandbox.json 中的网络设置有误：${errorMessage(error)}`, networkSource: parsed.network };
	}
}

function directoryKey(directory: string): string {
	const path = resolve(directory);
	return process.platform === 'win32' ? path.toLowerCase() : path;
}

function realPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/** 一个沙箱进程。 */
class Host {
	/** 准备好时是 undefined，否则是原因。 */
	readonly ready: Promise<string | undefined>;
	private readonly child: ChildProcess;
	private readonly commands = new Map<string, { readonly onOutput: (text: string) => void; readonly exit: (result: ISandboxExit) => void }>();
	private readonly onIdle: () => void;
	private stderr = '';
	private settled = false;
	private exited = false;

	constructor(config: SandboxRuntimeConfig, network: ISandboxNetwork, onExit: () => void, onIdle: () => void) {
		this.onIdle = onIdle;
		this.child = fork(HOST_SCRIPT, [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: ['--disable-warning=ExperimentalWarning'], windowsHide: true });
		this.child.stderr!.on('data', (chunk: Buffer) => this.stderr = (this.stderr + chunk.toString()).slice(-2000));
		this.ready = new Promise(resolveReady => {
			const settle = (error: string | undefined) => {
				if (this.settled) return;
				this.settled = true;
				resolveReady(error);
			};
			this.child.on('message', (message: HostMessage) => {
				switch (message.type) {
					case 'ready': settle(undefined); break;
					case 'initFailed': settle(message.error); this.stop(); break;
					case 'output': this.commands.get(message.id)?.onOutput(message.text); break;
					case 'exit': {
						const command = this.commands.get(message.id);
						this.commands.delete(message.id);
						command?.exit(message);
						if (!this.busy) this.onIdle();
						break;
					}
				}
			});
			this.child.on('error', error => settle(`沙箱进程无法启动：${error.message}`));
			this.child.on('exit', code => {
				this.exited = true;
				const reason = `沙箱进程已退出（退出码 ${code}）${this.stderr.trim() ? `：${this.stderr.trim().split('\n').at(-1)}` : ''}`;
				settle(reason);
				for (const [, command] of this.commands) command.exit({ exitCode: null, signal: null, violations: [], error: reason });
				this.commands.clear();
				onExit();
			});
			this.send({ type: 'init', config, network });
		});
	}

	get isReady(): boolean {
		return this.settled && !this.exited;
	}

	get busy(): boolean {
		return this.commands.size > 0;
	}

	run(request: Omit<Extract<HostRequest, { type: 'run' }>, 'type' | 'id'>, onOutput: (text: string) => void): ISandboxCommand {
		const id = randomUUID();
		const exited = new Promise<ISandboxExit>(exit => this.commands.set(id, { onOutput, exit }));
		this.send({ type: 'run', id, ...request });
		return { exited, kill: () => this.send({ type: 'kill', id }) };
	}

	setNetwork(network: ISandboxNetwork): void {
		this.send({ type: 'network', network });
	}

	/** 断开连接，沙箱进程结束会话后退出；等不到就强行结束。 */
	stop(): Promise<void> {
		if (this.exited) return Promise.resolve();
		const exited = new Promise<void>(resolveExit => this.child.once('exit', () => resolveExit()));
		if (this.child.connected) this.child.disconnect();
		const timer = setTimeout(() => this.child.kill(), STOP_TIMEOUT_MS);
		return exited.finally(() => clearTimeout(timer));
	}

	private send(request: HostRequest): void {
		if (this.child.connected) this.child.send(request);
	}
}
