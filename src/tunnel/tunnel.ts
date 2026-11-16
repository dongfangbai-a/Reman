import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { errorMessage, invalid } from '../common/errors.ts';
import { isRecord, readJsonFile } from '../common/json.ts';
import { killProcessTree } from '../common/process.ts';
import type { Secrets } from '../common/secrets.ts';
import { cloudflaredAsset, cloudflaredFileName, cloudflaredUrl, type ICloudflaredAsset } from './cloudflaredRelease.ts';
import type { CloudflaredState, IRemoteStatus, TunnelProcessKind } from './tunnelState.ts';

/** 云端托管的隧道：token 就够，路由在 Cloudflare 后台定。 */
const RUN_ARGS = ['--no-autoupdate', 'tunnel', 'run'];
/** cloudflared 自己写的日志文件名，放在设置文件旁边。 */
const LOG_FILE = 'cloudflared.log';
/** 日志超过这么大就在启动时清掉，别越写越大。 */
const LOG_MAX_BYTES = 5 * 1024 * 1024;
/** 下载进度最多多久变一次。 */
const PROGRESS_INTERVAL_MS = 250;
/** 断了以后隔多久重试：5 秒、30 秒、5 分钟，之后每 30 分钟一次。 */
const RESTART_DELAYS_MS = [5_000, 30_000, 300_000, 1_800_000];
/** 取版本号最多等多久。 */
const VERSION_TIMEOUT_MS = 5_000;
/** 下载 cloudflared 最多等多久；断网卡住时不能一直挂在「正在下载」。 */
const DOWNLOAD_TIMEOUT_MS = 600_000;
/** 结束进程后最多等它退出多久。 */
const EXIT_TIMEOUT_MS = 5_000;

/** 设置文件里的样子。token 加密保存。 */
interface ISettings {
	readonly enabled: boolean;
	readonly hostname: string | null;
	/** 除隧道外还接受哪些域名：Tailscale serve 的 ts.net 域名之类，不需要隧道打开。 */
	readonly hostnames: readonly string[];
	readonly token: string;
	readonly cloudflaredPath: string | null;
	/** 上次连上 Cloudflare 时的服务地址。 */
	readonly lastOrigin: string | null;
}

const EMPTY_SETTINGS: ISettings = { enabled: false, hostname: null, hostnames: [], token: '', cloudflaredPath: null, lastOrigin: null };

export interface ITunnelOptions {
	/** 设置存在这里；不给时只在内存里。 */
	readonly settingsPath?: string;
	/** cloudflared 下载、放到这里；不给时不能下载，只能用已有的路径。 */
	readonly directory?: string;
	readonly secrets?: Secrets;
	/** 运行时的端口，拼 Cloudflare 后台要填的服务地址。 */
	readonly port: () => number;
	/** 运行时的访问令牌，拼手机上打开的链接。 */
	readonly accessToken: () => string;
	readonly onChange?: () => void;
}

/**
 * 公网访问：管 cloudflared 的下载和子进程，停运行时就断。
 * 隧道是云端托管的（Cloudflare 后台建，Public Hostname 在后台配），本机只要 token。
 */
export class Tunnel {
	private readonly options: ITunnelOptions;
	private settings: ISettings;
	private cloudflared: CloudflaredState;
	private processKind: TunnelProcessKind = 'off';
	private processError: string | null = null;
	private child: ChildProcess | undefined;
	/** 主动停掉的：它的退出不再算错误，也不重试。 */
	private stopping = false;
	private restartTimer: NodeJS.Timeout | undefined;
	private restartAttempt = 0;
	private installing: Promise<void> | undefined;
	/** 取过一次的版本号，按程序路径记，避免每次刷新状态都跑一遍 --version。 */
	private version: { readonly path: string; readonly value: string } | undefined;
	/** 现在这个进程是按哪套设置起的：换设置时要重启。 */
	private spawnedKey: string | undefined;

	constructor(options: ITunnelOptions) {
		this.options = options;
		this.settings = readSettings(options.settingsPath);
		this.cloudflared = this.resolveCloudflared();
		this.reapOrphan();
	}

	/** 在 Cloudflare 后台的 Public Hostname 里要填的服务地址：跟着端口走。 */
	get origin(): string {
		return `http://127.0.0.1:${this.options.port()}`;
	}

	status(): IRemoteStatus {
		const { hostname } = this.settings;
		const token = this.token();
		const origin = this.origin;
		return {
			enabled: this.settings.enabled,
			hostname,
			hostnames: this.settings.hostnames,
			tokenTail: token ? token.slice(-4) : null,
			cloudflaredPath: this.settings.cloudflaredPath,
			cloudflared: this.cloudflared,
			process: { kind: this.processKind, error: this.processError },
			origin,
			lastOrigin: this.settings.lastOrigin,
		};
	}

	/** 手机上打开的链接：带访问令牌。不放在状态里，网页端点了「复制链接」或「显示二维码」时才单独要一次。 */
	link(): string | null {
		const { hostname, enabled } = this.settings;
		return enabled && hostname ? `https://${hostname}/#token=${encodeURIComponent(this.options.accessToken())}` : null;
	}

	/** 网页端接受请求的主机名：开了公网访问并且填了主机名才算。 */
	get hostname(): string | null {
		return this.settings.enabled ? this.settings.hostname : null;
	}

	/** 隧道之外还接受的域名：Tailscale 之类的反向代理用，和隧道开关无关。 */
	get hostnames(): readonly string[] {
		return this.settings.hostnames;
	}

	/** 请求的 Host 是不是认的外部域名。 */
	allowsHost(host: string): boolean {
		return (this.settings.enabled && this.settings.hostname === host) || this.settings.hostnames.includes(host);
	}

	/** 指定域名的登录链接：只给认的外部域名（额外域名，或者开着的时候隧道那个），都按 https 访问。 */
	linkTo(host: string): string | null {
		return this.allowsHost(host) ? `https://${host}/#token=${encodeURIComponent(this.options.accessToken())}` : null;
	}

	/** 改设置：主机名、token、已有的 cloudflared 路径、开关。有一项不对时报错，什么都不改。 */
	update(body: Record<string, unknown>): IRemoteStatus {
		const next: { -readonly [K in keyof ISettings]: ISettings[K] } = { ...this.settings };
		if ('hostname' in body) next.hostname = parseHostname(body['hostname']);
		if ('hostnames' in body) next.hostnames = parseHostList(body['hostnames']);
		if ('token' in body) next.token = this.encryptToken(body['token']);
		if ('cloudflaredPath' in body) next.cloudflaredPath = parsePath(body['cloudflaredPath']);
		if ('enabled' in body) {
			if (typeof body['enabled'] !== 'boolean') throw invalid('enabled 必须是 true 或 false');
			next.enabled = body['enabled'];
		}
		if (next.enabled && (!next.hostname || !next.token)) throw invalid('打开公网访问前要先填主机名和隧道 token');
		this.settings = next;
		this.save();
		this.version = undefined;
		// 换了设置就从头重试，不要沿用之前失败攒下的 30 分钟间隔。
		this.restartAttempt = 0;
		this.cloudflared = this.resolveCloudflared();
		this.changed();
		void this.sync();
		return this.status();
	}

	/** 下载 cloudflared（只能由用户触发）。 */
	install(): void {
		void this.doInstall();
	}

	/** 按设置把隧道拉起来或停掉；运行时启动时也调用一次。 */
	async sync(): Promise<void> {
		const ready = this.cloudflared.kind === 'ready' ? this.cloudflared.path : undefined;
		const token = this.token();
		if (this.settings.enabled && ready && token) {
			// 换了 token、域名或程序时重启一次，不然新设置不生效。
			const key = this.keyFor(ready);
			if (this.running && this.spawnedKey === key) return;
			this.stop();
			this.start(ready, key);
			return;
		}
		this.stop();
	}

	/** 退出前调用：结束 cloudflared，不留进程。 */
	async shutdown(): Promise<void> {
		const child = this.child;
		this.stop();
		await waitForExit(child, EXIT_TIMEOUT_MS);
	}

	/** 子进程是否还在跑；测试用。 */
	get running(): boolean {
		return this.child !== undefined && this.child.exitCode === null;
	}

	private changed(): void {
		this.options.onChange?.();
	}

	/** 记下 cloudflared 的 pid：运行时被强杀时来不及收拾，下次启动据此清掉留下的一条隧道。 */
	private pidPath(): string | undefined {
		return this.options.directory ? join(this.options.directory, 'cloudflared.pid') : undefined;
	}

	private writePid(pid: number): void {
		const path = this.pidPath();
		if (!path) return;
		try {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, `${JSON.stringify({ pid, startedAt: Date.now() })}\n`);
		} catch {
			// 记不上只是清不掉上次的进程，不影响这次运行。
		}
	}

	private clearPid(): void {
		const path = this.pidPath();
		if (path) rmSync(path, { force: true });
	}

	/** 上次运行时被强杀的话，cloudflared 会留下来继续连着隧道；启动时先确认是它再结束掉。 */
	private reapOrphan(): void {
		const path = this.pidPath();
		if (!path || !existsSync(path)) return;
		let pid: number | undefined;
		try {
			const parsed = readJsonFile(path);
			if (isRecord(parsed) && typeof parsed['pid'] === 'number') pid = parsed['pid'];
		} catch {
			pid = undefined;
		}
		rmSync(path, { force: true });
		if (pid === undefined || pid === process.pid || !isCloudflared(pid)) return;
		killPidTree(pid);
		this.note(`结束上次留下的 cloudflared（pid ${pid}）`);
	}

	private token(): string {
		if (!this.settings.token) return '';
		return this.options.secrets ? this.options.secrets.decrypt(this.settings.token) ?? '' : this.settings.token;
	}

	private encryptToken(value: unknown): string {
		if (value === null || value === undefined || value === '') return '';
		if (typeof value !== 'string') throw invalid('隧道 token 必须是字符串');
		const token = value.trim();
		if (!token) return '';
		return this.options.secrets?.encrypt(token) ?? token;
	}

	private save(): void {
		if (!this.options.settingsPath) return;
		writeFileSync(this.options.settingsPath, `${JSON.stringify(this.settings, null, '\t')}\n`);
	}

	/** 已有的路径优先；否则看下载好的文件。 */
	private resolveCloudflared(): CloudflaredState {
		const custom = this.settings.cloudflaredPath;
		if (custom) {
			if (!existsSync(custom)) return { kind: 'failed', reason: `找不到 ${custom}` };
			const version = this.readVersion(custom);
			return version === undefined ? { kind: 'failed', reason: `${custom} 执行 --version 失败` } : { kind: 'ready', version, path: custom };
		}
		const target = this.binaryPath();
		if (!target) return { kind: 'missing' };
		if (!existsSync(target)) return cloudflaredAsset() ? { kind: 'missing' } : { kind: 'unsupported', reason: unsupportedReason() };
		const version = this.readVersion(target);
		return version === undefined ? { kind: 'failed', reason: `${target} 执行 --version 失败` } : { kind: 'ready', version, path: target };
	}

	private binaryPath(): string | undefined {
		return this.options.directory ? join(this.options.directory, cloudflaredFileName()) : undefined;
	}

	private readVersion(executable: string): string | undefined {
		if (this.version?.path === executable) return this.version.value;
		try {
			const output = execFileSync(executable, ['--version'], { timeout: VERSION_TIMEOUT_MS, encoding: 'utf8', windowsHide: true });
			const value = /version\s+(\S+)/i.exec(output)?.[1] ?? 'unknown';
			this.version = { path: executable, value };
			return value;
		} catch {
			return undefined;
		}
	}

	private async doInstall(): Promise<void> {
		this.installing ??= this.installNow().finally(() => {
			this.installing = undefined;
		});
		return this.installing;
	}

	private async installNow(): Promise<void> {
		const directory = this.options.directory;
		const asset = cloudflaredAsset();
		if (!directory || !asset) {
			this.setCloudflared({ kind: 'unsupported', reason: unsupportedReason() });
			return;
		}
		const target = join(directory, cloudflaredFileName());
		const downloads = join(directory, 'downloads');
		const packagePath = join(downloads, asset.file);
		const temporary = `${packagePath}.download`;
		const progress = (receivedBytes: number) => this.setCloudflared({ kind: 'downloading', receivedBytes, totalBytes: asset.size });
		// 断网卡住时不能一直挂在「正在下载」上。
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
		timer.unref();
		try {
			await mkdir(downloads, { recursive: true });
			progress(0);
			const response = await fetch(cloudflaredUrl(asset), { signal: controller.signal });
			if (!response.ok || !response.body) throw new Error(`下载 cloudflared 失败：HTTP ${response.status}`);
			let receivedBytes = 0;
			let lastAt = 0;
			let lastPercent = -1;
			const counter = new Transform({
				transform: (chunk: Buffer, _encoding, callback) => {
					receivedBytes += chunk.byteLength;
					// 比清单上的大就不要了：不认识的来源不能一直往磁盘上写。
					if (receivedBytes > asset.size) return callback(new Error(`下载的 cloudflared 比预期的 ${asset.size} 字节大`));
					const now = Date.now();
					// 百分比变一档才推一次：55 MB 的包一秒能收好几块，每块都推会把网页端刷爆。
					const percent = Math.floor((receivedBytes / asset.size) * 100);
					if (percent !== lastPercent && now - lastAt >= PROGRESS_INTERVAL_MS) {
						lastPercent = percent;
						lastAt = now;
						progress(receivedBytes);
					}
					callback(null, chunk);
				},
			});
			await pipeline(Readable.fromWeb(response.body), counter, createWriteStream(temporary));
			if (receivedBytes !== asset.size) throw new Error(`下载的 cloudflared 大小不对：应为 ${asset.size} 字节，实际 ${receivedBytes} 字节`);
			if (!await verify(temporary, asset)) throw new Error('下载的 cloudflared 未通过 SHA-256 校验');
			await this.place(temporary, asset, directory, target);
			this.version = undefined;
			this.cloudflared = this.resolveCloudflared();
			this.changed();
			void this.sync();
		} catch (error) {
			await rm(temporary, { force: true }).catch(() => undefined);
			const reason = error instanceof Error && error.name === 'AbortError' ? '下载 cloudflared 超时' : errorMessage(error);
			// 之前装好的还能用就继续用，别因为一次重新下载失败把隧道弄停。
			const resolved = this.resolveCloudflared();
			this.setCloudflared(resolved.kind === 'ready' ? resolved : { kind: 'failed', reason });
		} finally {
			clearTimeout(timer);
		}
	}

	/** 裸二进制直接放到位；macOS 的 tgz 先解开。 */
	private async place(downloaded: string, asset: ICloudflaredAsset, directory: string, target: string): Promise<void> {
		if (!asset.archive) {
			await rm(target, { force: true });
			await rename(downloaded, target);
		} else {
			const staging = join(directory, `staging-${randomUUID()}`);
			await mkdir(staging, { recursive: true });
			try {
				await run(process.platform === 'win32' ? 'tar.exe' : 'tar', ['-xzf', downloaded, '-C', staging]);
				const extracted = join(staging, cloudflaredFileName(process.platform));
				if (!existsSync(extracted)) throw new Error('解压结果中没有 cloudflared');
				await rm(target, { force: true });
				await rename(extracted, target);
			} finally {
				await rm(staging, { recursive: true, force: true }).catch(() => undefined);
				await rm(downloaded, { force: true }).catch(() => undefined);
			}
		}
		if (process.platform !== 'win32') await chmod(target, 0o755);
	}

	private setCloudflared(state: CloudflaredState): void {
		this.cloudflared = state;
		this.changed();
	}

	/** 一套设置（程序、token、域名）对应一个进程；变了就重启。 */
	private keyFor(executable: string): string {
		return `${executable}\n${this.token()}\n${this.settings.hostname ?? ''}`;
	}

	private start(executable: string, key: string): void {
		if (this.running) return;
		const token = this.token();
		if (!token) return;
		this.spawnedKey = key;
		this.clearRestart();
		this.stopping = false;
		this.processKind = 'starting';
		this.processError = null;
		this.note('启动 cloudflared');
		const child = spawn(executable, this.runArgs(), {
			env: { ...process.env, TUNNEL_TOKEN: token, NO_AUTOUPDATE: 'true' },
			stdio: ['ignore', 'pipe', 'pipe'],
			windowsHide: true,
		});
		this.child = child;
		if (child.pid !== undefined) this.writePid(child.pid);
		this.changed();
		for (const stream of [child.stdout, child.stderr]) {
			if (!stream) continue;
			let pending = '';
			stream.setEncoding('utf8');
			stream.on('data', (chunk: string) => {
				pending += chunk;
				const lines = pending.split(/\r?\n/);
				pending = lines.pop() ?? '';
				for (const line of lines) this.onLine(line);
			});
			stream.on('end', () => {
				if (pending) this.onLine(pending);
			});
		}
		child.on('error', error => this.onExit(child, error.message));
		child.on('exit', (code, signal) => this.onExit(child, undefined, code, signal));
	}

	private stop(): void {
		this.stopping = true;
		this.clearRestart();
		const child = this.child;
		this.child = undefined;
		this.processKind = 'off';
		this.processError = null;
		this.clearPid();
		this.changed();
		if (child && child.exitCode === null) killProcessTree(child);
	}

	private onLine(raw: string): void {
		const line = raw.trim();
		if (!line) return;
		if (/Registered tunnel connection/i.test(line)) {
			// 两条 HA 连接会各注册一次，只报第一条，免得启动时刷两遍。
			if (this.processKind !== 'connected') {
				const location = /location=(\S+)/.exec(line)?.[1];
				this.note(location ? `已连上 Cloudflare（${location}）` : '已连上 Cloudflare');
			}
			this.processKind = 'connected';
			this.processError = null;
			this.restartAttempt = 0;
			// 记下这次连上用的服务地址：端口或域名改过时，设置页据此提醒去 Cloudflare 后台改。
			if (this.settings.lastOrigin !== this.origin) {
				this.settings = { ...this.settings, lastOrigin: this.origin };
				this.save();
			}
			this.changed();
		}
	}

	private onExit(source: ChildProcess, error?: string, code?: number | null, signal?: NodeJS.Signals | null): void {
		// 换过一次进程的旧进程退出，不影响现在的状态。
		if (this.child !== source) return;
		this.child = undefined;
		this.clearPid();
		if (this.stopping || !this.settings.enabled) {
			this.processKind = 'off';
			this.processError = null;
			this.changed();
			return;
		}
		const reason = error ?? `cloudflared 退出了（${signal ? `信号 ${signal}` : `退出码 ${code}`}）`;
		this.processKind = 'error';
		this.processError = reason;
		this.note(reason);
		this.scheduleRestart();
		this.changed();
	}

	private scheduleRestart(): void {
		this.clearRestart();
		const delay = RESTART_DELAYS_MS[Math.min(this.restartAttempt, RESTART_DELAYS_MS.length - 1)]!;
		this.restartAttempt += 1;
		this.note(`${Math.round(delay / 1000)} 秒后重试`);
		this.restartTimer = setTimeout(() => {
			this.restartTimer = undefined;
			const executable = this.cloudflared.kind === 'ready' ? this.cloudflared.path : undefined;
			if (this.settings.enabled && executable) this.start(executable, this.keyFor(executable));
		}, delay);
		this.restartTimer.unref();
	}

	private clearRestart(): void {
		if (this.restartTimer) clearTimeout(this.restartTimer);
		this.restartTimer = undefined;
	}

	/**
	 * 打到运行时的输出里：只在启动、连上、退出这几件说一句，其余（cloudflared 每次都刷一大屏）写到数据目录的 cloudflared.log。
	 * 网页端和接口都不带日志，配错了去看那个文件。
	 */
	private note(line: string): void {
		console.log(`[cloudflared] ${line}`);
	}

	/** 运行参数：日志写文件，免得每次都往控制台刷。 */
	private runArgs(): string[] {
		const directory = this.options.settingsPath ? dirname(this.options.settingsPath) : undefined;
		if (!directory) return RUN_ARGS;
		const file = join(directory, LOG_FILE);
		// 启动时清掉太大的旧日志。
		try {
			if (statSync(file).size > LOG_MAX_BYTES) rmSync(file);
		} catch {
			// 没有文件、或者删不掉：照旧写。
		}
		return ['--loglevel', 'info', '--logfile', file, ...RUN_ARGS];
	}
}

/** 这个 pid 现在是不是 cloudflared：强杀留下的进程，pid 可能已经被别人用了。 */
function isCloudflared(pid: number): boolean {
	try {
		const output = process.platform === 'win32'
			? execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { timeout: 5_000, encoding: 'utf8', windowsHide: true })
			: execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { timeout: 5_000, encoding: 'utf8' });
		return /cloudflared/i.test(output);
	} catch {
		// 进程不在了，或者系统里没有这个命令。
		return false;
	}
}

/** 按 pid 结束进程和它的子进程。 */
function killPidTree(pid: number): void {
	if (process.platform === 'win32') {
		spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true }).on('error', () => undefined);
		return;
	}
	try {
		process.kill(-pid, 'SIGKILL');
	} catch {
		try {
			process.kill(pid, 'SIGKILL');
		} catch {
			// 已经退了。
		}
	}
}

function unsupportedReason(): string {
	return `${process.platform} ${process.arch} 官方没有 cloudflared 的包，请填已有的路径`;
}

function readSettings(path: string | undefined): ISettings {
	if (!path || !existsSync(path)) return EMPTY_SETTINGS;
	try {
		const parsed = readJsonFile(path);
		if (!isRecord(parsed)) return EMPTY_SETTINGS;
		return {
			enabled: parsed['enabled'] === true,
			hostname: typeof parsed['hostname'] === 'string' ? parsed['hostname'] : null,
			hostnames: readHostList(parsed['hostnames']),
			token: typeof parsed['token'] === 'string' ? parsed['token'] : '',
			cloudflaredPath: typeof parsed['cloudflaredPath'] === 'string' ? parsed['cloudflaredPath'] : null,
			lastOrigin: typeof parsed['lastOrigin'] === 'string' ? parsed['lastOrigin'] : null,
		};
	} catch {
		return EMPTY_SETTINGS;
	}
}

/** 主机名：小写字母、数字、横杠、点，必须有点；本机地址、IP 和带协议、端口、路径的不收。 */
export function parseHostname(value: unknown): string | null {
	if (value === null || value === undefined || value === '') return null;
	if (typeof value !== 'string') throw invalid('主机名必须是字符串');
	const name = value.trim().toLowerCase().replace(/\.$/, '');
	if (!name) return null;
	if (name.includes('/') || name.includes(':') || name.includes(' ')) throw invalid('只填域名，不带协议、端口和路径，如 human.example.com');
	if (name === 'localhost' || name.endsWith('.localhost')) throw invalid('这是本机地址，手机上访问要填自己的域名');
	if (/^\d+(\.\d+){3}$/.test(name)) throw invalid('这是 IP 地址，要填域名');
	if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(name)) throw invalid(`「${value}」不是有效的域名`);
	if (name.length > 253) throw invalid('域名太长了');
	return name;
}

/** 额外的域名：接口收数组，也收逗号、空格分开的一串；去重，保持顺序。 */
export function parseHostList(value: unknown): string[] {
	if (value === null || value === undefined || value === '') return [];
	const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,]+/) : undefined;
	if (!items) throw invalid('域名要是字符串或字符串数组');
	const names: string[] = [];
	for (const item of items) {
		const name = parseHostname(item);
		if (name && !names.includes(name)) names.push(name);
	}
	return names;
}

/** 读设置文件时用：写坏了的项跳过，不让整个文件读不出来。 */
function readHostList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const names: string[] = [];
	for (const item of value) {
		if (typeof item !== 'string') continue;
		try {
			const name = parseHostname(item);
			if (name && !names.includes(name)) names.push(name);
		} catch {
			// 跳过这一项。
		}
	}
	return names;
}

function parsePath(value: unknown): string | null {
	if (value === null || value === undefined || value === '') return null;
	if (typeof value !== 'string') throw invalid('cloudflared 路径必须是字符串');
	const path = value.trim();
	if (!path) return null;
	if (!(path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(path))) throw invalid('cloudflared 路径要写绝对路径');
	return path;
}

/** 下载的文件 SHA-256 要对；对不上就删掉。 */
async function verify(path: string, asset: ICloudflaredAsset): Promise<boolean> {
	const hash = createHash('sha256');
	await pipeline(createReadStream(path), hash);
	if (hash.digest('hex') === asset.sha256) return true;
	await rm(path, { force: true }).catch(() => undefined);
	return false;
}

/** 执行一个命令等它结束；解压 tar 用。 */
function run(executable: string, args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(executable, args, { stdio: 'ignore', windowsHide: true });
		child.on('error', reject);
		child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`${executable} 退出码 ${code}`))));
	});
}

function waitForExit(child: ChildProcess | undefined, timeout: number): Promise<void> {
	if (!child || child.exitCode !== null) return Promise.resolve();
	return new Promise<void>(resolve => {
		const timer = setTimeout(resolve, timeout);
		child.once('exit', () => {
			clearTimeout(timer);
			resolve();
		});
	});
}
