import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { errorMessage } from '../common/errors.ts';
import type { EventHub } from '../common/events.ts';
import { killProcessTree } from '../common/process.ts';
import type { PortableGitState } from './portableGitState.ts';

/** 固定的 PortableGit 版本：只下载这个文件，并核对大小和 SHA-256。 */
const PORTABLE_GIT_RELEASE = {
	version: '2.56.0.4',
	fileName: 'PortableGit-2.56.0.4-64-bit.7z.exe',
	size: 60_087_472,
	sha256: 'b1f3e52216e2ed6882d1bebfd4d3fdf319bec40d2edbbf9fd26ec4fd3fce7ed1',
	urls: [
		'https://registry.npmmirror.com/-/binary/git-for-windows/v2.56.0.windows.4/PortableGit-2.56.0.4-64-bit.7z.exe',
		'https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.4/PortableGit-2.56.0.4-64-bit.7z.exe',
	],
} as const;

/** 解压和 post-install 最长等多久。 */
const EXTRACT_TIMEOUT_MS = 10 * 60 * 1000;
/** 下载进度最多多久推送一次。 */
const PROGRESS_INTERVAL_MS = 250;

/**
 * 运行时自己安装的 Git for Windows 便携版，给没装 Git 的 Windows 机器提供 bash。
 * 只能由用户触发安装（不给模型用）；装好后 shell 检测会用上它。
 */
export class PortableGit {
	private readonly events: EventHub;
	/** 安装目录；undefined 表示这个平台不支持。 */
	private readonly root: string | undefined;
	private readonly onInstalled: () => void;
	private current: PortableGitState | undefined;
	private installing: Promise<PortableGitState> | undefined;
	private controller: AbortController | undefined;

	constructor(events: EventHub, root: string | undefined, onInstalled: () => void) {
		this.events = events;
		this.root = root;
		this.onInstalled = onInstalled;
	}

	/** 默认安装目录：只支持 Windows x64。 */
	static defaultRoot(): string | undefined {
		const localAppData = process.env['LOCALAPPDATA'];
		if (process.platform !== 'win32' || process.arch !== 'x64' || !localAppData) return undefined;
		return join(localAppData, 'reman-runtime', 'PortableGit');
	}

	/** 装好时 bash.exe 的路径，没装好返回 undefined。 */
	bashPath(): string | undefined {
		if (!this.root) return undefined;
		const path = join(this.root, 'bin', 'bash.exe');
		return existsSync(path) ? path : undefined;
	}

	state(): PortableGitState {
		if (this.installing && this.current) return this.current;
		if (!this.root) return { kind: 'unsupported' };
		const bashPath = this.bashPath();
		if (bashPath) return { kind: 'installed', bashPath };
		return this.current?.kind === 'failed' ? this.current : { kind: 'notInstalled' };
	}

	/** 开始安装，已经在装时返回同一个过程。 */
	install(): Promise<PortableGitState> {
		this.installing ??= this.doInstall().finally(() => {
			this.installing = undefined;
			this.controller = undefined;
		});
		return this.installing;
	}

	cancel(): void {
		this.controller?.abort(new Error('安装已取消'));
	}

	/** 等安装结束（运行时退出时用）。 */
	async shutdown(): Promise<void> {
		this.cancel();
		await this.installing;
	}

	private async doInstall(): Promise<PortableGitState> {
		const root = this.root;
		if (!root) return this.setState({ kind: 'unsupported' });
		const existing = join(root, 'bin', 'bash.exe');
		if (existsSync(existing)) return this.setState({ kind: 'installed', bashPath: existing });

		this.controller = new AbortController();
		const signal = this.controller.signal;
		const downloads = join(dirname(root), 'downloads');
		const packagePath = join(downloads, PORTABLE_GIT_RELEASE.fileName);
		const staging = `${root}.staging-${randomUUID()}`;
		try {
			await mkdir(downloads, { recursive: true });
			if (!await this.isVerified(packagePath)) {
				await this.download(packagePath, signal);
				this.setState({ kind: 'verifying' });
				if (!await this.isVerified(packagePath)) throw new Error('下载的文件未通过校验');
			}
			signal.throwIfAborted();
			this.setState({ kind: 'extracting' });
			await this.run(packagePath, [`-o${staging}`, '-y'], downloads, signal);
			if (!existsSync(join(staging, 'bin', 'bash.exe'))) throw new Error('解压结果中没有 bin\\bash.exe');
			signal.throwIfAborted();
			// 整个换到最终目录后再执行 post-install，免得半解压的目录被 shell 检测用上。
			await rm(root, { recursive: true, force: true });
			await rename(staging, root);
			await this.runPostInstall(root, signal);
			await rm(packagePath, { force: true }).catch(() => undefined);
			this.onInstalled();
			return this.setState({ kind: 'installed', bashPath: existing });
		} catch (error) {
			await rm(staging, { recursive: true, force: true }).catch(() => undefined);
			if (signal.aborted) return this.setState({ kind: 'notInstalled' });
			return this.setState({ kind: 'failed', error: errorMessage(error) });
		}
	}

	/** 依次试各个下载源，边下载边推送进度；大小不对的算失败，换下一个源。 */
	private async download(packagePath: string, signal: AbortSignal): Promise<void> {
		const temporary = `${packagePath}.download`;
		const failures: string[] = [];
		for (const url of PORTABLE_GIT_RELEASE.urls) {
			signal.throwIfAborted();
			const source = new URL(url).host;
			let receivedBytes = 0;
			let lastProgressAt = 0;
			const progress = () => {
				this.current = { kind: 'downloading', source, receivedBytes, totalBytes: PORTABLE_GIT_RELEASE.size };
				this.events.delta({ type: 'portableGit.progress', receivedBytes, totalBytes: PORTABLE_GIT_RELEASE.size });
			};
			this.setState({ kind: 'downloading', source, receivedBytes: 0, totalBytes: PORTABLE_GIT_RELEASE.size });
			try {
				const response = await fetch(url, { signal });
				if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
				const counter = new Transform({
					transform(chunk: Buffer, _encoding, callback) {
						receivedBytes += chunk.byteLength;
						const now = Date.now();
						if (now - lastProgressAt >= PROGRESS_INTERVAL_MS) {
							lastProgressAt = now;
							progress();
						}
						callback(null, chunk);
					},
				});
				await pipeline(Readable.fromWeb(response.body), counter, createWriteStream(temporary), { signal });
				progress();
				if (receivedBytes !== PORTABLE_GIT_RELEASE.size) throw new Error(`文件大小有误：应为 ${PORTABLE_GIT_RELEASE.size} 字节，实际 ${receivedBytes} 字节`);
				await rename(temporary, packagePath);
				return;
			} catch (error) {
				await rm(temporary, { force: true }).catch(() => undefined);
				signal.throwIfAborted();
				failures.push(`${source}：${errorMessage(error)}`);
			}
		}
		throw new Error(`所有下载源均失败（${failures.join('；')}）`);
	}

	/** 文件存在且 SHA-256 对得上；对不上的删掉。 */
	private async isVerified(packagePath: string): Promise<boolean> {
		if (!existsSync(packagePath)) return false;
		const hash = createHash('sha256');
		await pipeline(createReadStream(packagePath), hash);
		if (hash.digest('hex') === PORTABLE_GIT_RELEASE.sha256) return true;
		await rm(packagePath, { force: true }).catch(() => undefined);
		return false;
	}

	/**
	 * Git for Windows 第一次启动 git-bash.exe 时才执行 post-install；这里直接执行一次，让直接调用 bin\bash.exe 也有完整环境。
	 * 脚本会在 PATH 里找 git，所以 PATH 只留这个安装目录和系统目录，免得改到机器上别的 Git。
	 */
	private async runPostInstall(root: string, signal: AbortSignal): Promise<void> {
		const script = join(root, 'post-install.bat');
		if (!existsSync(script)) return;
		const systemRoot = process.env['SystemRoot'] ?? 'C:\\Windows';
		const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
		env['Path'] = [join(root, 'cmd'), join(root, 'ucrt64', 'bin'), join(root, 'mingw64', 'bin'), join(root, 'usr', 'bin'), join(systemRoot, 'System32'), systemRoot].join(';');
		try {
			await this.run(join(systemRoot, 'System32', 'cmd.exe'), ['/d', '/c', script], root, signal, env);
		} catch {
			// 脚本最后会删除自己，cmd 因此常以退出码 1 结束；没执行完也不影响 bash 基本可用。
			signal.throwIfAborted();
		}
	}

	private run(executable: string, args: string[], cwd: string, signal: AbortSignal, env?: NodeJS.ProcessEnv): Promise<void> {
		signal.throwIfAborted();
		return new Promise<void>((resolve, reject) => {
			const child = spawn(executable, args, { cwd, env, windowsHide: true, stdio: 'ignore' });
			const stop = () => killProcessTree(child);
			const timer = setTimeout(() => {
				stop();
				reject(new Error(`${basename(executable)} 执行超时`));
			}, EXTRACT_TIMEOUT_MS);
			signal.addEventListener('abort', stop, { once: true });
			const finish = () => {
				clearTimeout(timer);
				signal.removeEventListener('abort', stop);
			};
			child.once('error', error => {
				finish();
				reject(error);
			});
			child.once('exit', code => {
				finish();
				if (signal.aborted) reject(signal.reason);
				else if (code === 0) resolve();
				else reject(new Error(`${basename(executable)} 退出码 ${code}`));
			});
		});
	}

	private setState(state: PortableGitState): PortableGitState {
		this.current = state;
		this.events.emit({ type: 'portableGit.changed' });
		return state;
	}
}
