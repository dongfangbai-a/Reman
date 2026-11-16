import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContext, Dialog, Page, Request } from 'playwright-core';
import { errorMessage, invalid } from '../common/errors.ts';
import { clipEnd } from '../common/text.ts';
import { BrowserBlocklist, isLoopbackHost } from './blocklist.ts';

/** 闲置多久关掉浏览器。 */
export const IDLE_CLOSE_MS = 60 * 60 * 1000;
/** 默认的页面大小。 */
export const VIEWPORT = { width: 1280, height: 800 };
/** 依次尝试的浏览器。Windows 上都有 Edge，先用它。 */
const CHANNELS: readonly { readonly channel: string; readonly name: string }[] = process.platform === 'win32'
	? [{ channel: 'msedge', name: 'Edge' }, { channel: 'chrome', name: 'Chrome' }]
	: [{ channel: 'chrome', name: 'Chrome' }, { channel: 'msedge', name: 'Edge' }];
/** 找元素、点击、输入等最多等多久。 */
const ACTION_TIMEOUT_MS = 10_000;
/** 打开网页最多等多久加载完。 */
export const NAVIGATION_TIMEOUT_MS = 30_000;
/** 页面日志最多留多少条、每条多长。 */
const MAX_LOGS = 200;
const LOG_CHARS = 500;

/** 浏览器关掉时开着的标签页和页面大小，用来恢复。 */
export interface IBrowserRecord {
	readonly tabs: readonly { readonly url: string; readonly title: string }[];
	/** 当前是第几个标签页，从 1 数。 */
	readonly current: number;
	readonly viewport: { readonly width: number; readonly height: number };
	/** 闲置关闭时是 true；运行时重启、浏览器意外退出时没有。 */
	readonly idle?: boolean;
}

/** 一个成员的浏览器：标签页、当前标签页、上次查看之后的页面日志。 */
export class BrowserSession {
	readonly context: BrowserContext;
	private current: Page | undefined;
	private logs: string[] = [];
	private droppedLogs = 0;
	private errors = 0;
	/** 上次取结果之后发生的、要告诉成员的事，如页面打开了新标签页。 */
	private notes: string[] = [];
	/** 页面大小；成员改过之后，新开的标签页也用它。 */
	private viewport = VIEWPORT;
	private closed = false;
	/** 拦下的请求和原因，日志里写明。 */
	private readonly blockedRequests = new WeakMap<Request, string>();
	/** 页面跳转被拦下的标签页和原因：停在报错页上，操作后换成空白页。 */
	private blockedPages = new Map<Page, string>();

	constructor(context: BrowserContext) {
		this.context = context;
		for (const page of context.pages()) this.watch(page);
		this.current = context.pages()[0];
		// 页面打开的新标签页（target=_blank、window.open）和自己新建的标签页，都切过去。
		context.on('page', page => {
			this.watch(page);
			this.current = page;
			if (this.viewport !== VIEWPORT) void page.setViewportSize(this.viewport).catch(() => undefined);
		});
		context.on('close', () => this.closed = true);
	}

	/** 现在开着的标签页和页面大小；没有打开网页时是 undefined。 */
	async record(): Promise<IBrowserRecord | undefined> {
		const pages = this.closed ? [] : this.pages();
		if (pages.every(page => page.url() === 'about:blank')) return undefined;
		const current = this.currentPage();
		return {
			tabs: await Promise.all(pages.map(async page => ({ url: page.url(), title: await page.title().catch(() => '') }))),
			current: current ? pages.indexOf(current) + 1 : pages.length,
			viewport: this.viewport,
		};
	}

	/** 全部标签页，按打开的先后。 */
	pages(): Page[] {
		return this.context.pages();
	}

	/** 当前标签页；全部关掉了时没有。 */
	currentPage(): Page | undefined {
		return this.current && !this.current.isClosed() ? this.current : undefined;
	}

	requirePage(): Page {
		const page = this.currentPage();
		if (!page) throw invalid('没有已打开的标签页，请先用 open 打开网页');
		return page;
	}

	async newTab(): Promise<Page> {
		const page = await this.context.newPage();
		this.current = page;
		return page;
	}

	/** 调整页面大小，对所有标签页有效，之后新开的也一样。 */
	async resize(width: number, height: number): Promise<void> {
		this.viewport = { width, height };
		await Promise.all(this.pages().map(page => page.setViewportSize(this.viewport)));
	}

	/** 切到第几个标签页（从 1 数）。 */
	async switchTo(tab: number): Promise<void> {
		const page = this.tab(tab);
		this.current = page;
		await page.bringToFront();
	}

	/** 关掉第几个标签页（从 1 数），关的是当前的就切到最后一个。 */
	async closeTab(tab: number): Promise<void> {
		const page = this.tab(tab);
		await page.close();
		if (this.current === page) this.current = this.pages().at(-1);
	}

	/** 取出上次查看之后的页面日志，报错数清零。 */
	takeLogs(): string[] {
		const logs = this.droppedLogs > 0 ? [`（更早的 ${this.droppedLogs} 条未保留）`, ...this.logs] : this.logs;
		this.logs = [];
		this.droppedLogs = 0;
		this.errors = 0;
		return logs;
	}

	/** 上次查看日志之后的报错数：控制台错误、页面报错、失败的请求、4xx 和 5xx 响应。 */
	get newErrors(): number {
		return this.errors;
	}

	takeNotes(): string[] {
		const notes = this.notes;
		this.notes = [];
		return notes;
	}

	/** 记下拦下的请求。 */
	blocked(request: Request, reason: string): void {
		this.blockedRequests.set(request, reason);
		if (!request.isNavigationRequest()) return;
		try {
			const frame = request.frame();
			if (frame.parentFrame() === null) this.blockedPages.set(frame.page(), reason);
		} catch {
			// 不是页面发出的请求。
		}
	}

	/** 记下拦下的 WebSocket。 */
	blockedWebSocket(url: string, reason: string): void {
		this.errors++;
		this.log(`[已拦截] WebSocket ${url}：${reason}`);
	}

	/** 取出上次取之后页面跳转被拦下的标签页和原因。 */
	takeBlockedPages(): Map<Page, string> {
		const pages = this.blockedPages;
		this.blockedPages = new Map();
		return pages;
	}

	private tab(tab: number): Page {
		const pages = this.pages();
		const page = pages[tab - 1];
		if (!Number.isInteger(tab) || !page) throw invalid(`不存在标签页 ${tab}，当前共有 ${pages.length} 个`);
		return page;
	}

	private watch(page: Page): void {
		page.on('console', message => {
			const type = message.type();
			// 请求失败时浏览器自己会打一条「Failed to load resource」，下面按请求记了地址，不重复记。
			if (type === 'debug' || message.text().startsWith('Failed to load resource')) return;
			if (type === 'error') this.errors++;
			this.log(`[控制台 ${type}] ${message.text()}`);
		});
		page.on('pageerror', error => {
			this.errors++;
			this.log(`[页面报错] ${error.message}`);
		});
		page.on('requestfailed', request => {
			const blocked = this.blockedRequests.get(request);
			if (blocked !== undefined) {
				this.errors++;
				this.log(`[已拦截] ${request.method()} ${request.url()}：${blocked}`);
				return;
			}
			const reason = request.failure()?.errorText ?? '';
			// 换页时取消的请求不算出错。
			if (reason === 'net::ERR_ABORTED' || isFavicon(request.url())) return;
			this.errors++;
			this.log(`[请求失败] ${request.method()} ${request.url()}：${reason}`);
		});
		page.on('response', response => {
			// 浏览器自己请求的网站图标没有时不算出错。
			if (response.status() < 400 || isFavicon(response.url())) return;
			this.errors++;
			this.log(`[HTTP ${response.status()}] ${response.request().method()} ${response.url()}`);
		});
		page.on('dialog', dialog => void this.answer(dialog));
		page.on('popup', () => this.notes.push('页面打开了新标签页，已切换过去'));
	}

	/** 页面弹出的提示框自动确定，记进日志。 */
	private async answer(dialog: Dialog): Promise<void> {
		this.log(`[提示框 ${dialog.type()}] ${dialog.message()}（已确认）`);
		try {
			await dialog.accept(dialog.type() === 'prompt' ? dialog.defaultValue() : undefined);
		} catch {
			// 页面已经关了。
		}
	}

	private log(text: string): void {
		this.logs.push(clipEnd(text, LOG_CHARS));
		if (this.logs.length > MAX_LOGS) {
			this.logs.shift();
			this.droppedLogs++;
		}
	}
}

/** 成员的浏览器发往本机的请求都带这个头，运行时收到带它的请求一律拒绝。 */
export const MEMBER_BROWSER_HEADER = 'x-reman-member-browser';

/**
 * 每个成员一个自己的浏览器：Playwright 驱动电脑上已有的 Edge 或 Chrome，没有窗口。
 * 浏览数据按成员存在 directory 下，下次打开还在。第一次用时启动，闲置一段时间后关掉。
 */
export class Browsers {
	private readonly directory: string;
	readonly idleCloseMs: number;
	/** 禁止访问的网址：运行时的网页端和用户加的。 */
	readonly blocklist: BrowserBlocklist;
	private readonly sessions = new Map<string, Promise<BrowserSession>>();
	/** 每个成员的操作依次执行。 */
	private readonly queues = new Map<string, Promise<unknown>>();
	private readonly timers = new Map<string, NodeJS.Timeout>();

	constructor(directory: string, idleCloseMs = IDLE_CLOSE_MS, blocklist = new BrowserBlocklist(undefined, () => undefined)) {
		this.directory = directory;
		this.idleCloseMs = idleCloseMs;
		this.blocklist = blocklist;
	}

	isOpen(memberId: string): boolean {
		return this.sessions.has(memberId);
	}

	/** 依次执行一个成员的浏览器操作；浏览器没开时先打开。 */
	use<T>(memberId: string, operation: (session: BrowserSession) => Promise<T>): Promise<T> {
		const previous = this.queues.get(memberId) ?? Promise.resolve();
		const next = previous.catch(() => undefined).then(async () => {
			this.clearTimer(memberId);
			try {
				const session = await this.session(memberId);
				try {
					return await operation(session);
				} finally {
					await this.remember(memberId, session);
				}
			} finally {
				this.armTimer(memberId);
			}
		});
		this.queues.set(memberId, next);
		const done = () => {
			if (this.queues.get(memberId) === next) this.queues.delete(memberId);
		};
		next.then(done, done);
		return next;
	}

	/** 当前标签页的地址；浏览器没开、没有标签页时是 undefined。 */
	async currentUrl(memberId: string): Promise<string | undefined> {
		const session = await this.sessions.get(memberId)?.catch(() => undefined);
		return session?.currentPage()?.url();
	}

	/** 当前页面上这个编号的元素是什么，如 `button "登录"`；找不到时是 undefined。 */
	async describeElement(memberId: string, ref: string): Promise<string | undefined> {
		const page = (await this.sessions.get(memberId)?.catch(() => undefined))?.currentPage();
		if (!page) return undefined;
		try {
			const snapshot = await page.getByRef(ref).ariaSnapshot({ timeout: 2_000 });
			return snapshot.split('\n')[0]?.replace(/^- /, '').replace(/:$/, '') || undefined;
		} catch {
			return undefined;
		}
	}

	/** 浏览器自己关掉（闲置、运行时重启、意外退出）时开着的标签页；浏览器开着、成员自己关的、没有记录时是 undefined。 */
	lastTabs(memberId: string): IBrowserRecord | undefined {
		if (this.isOpen(memberId)) return undefined;
		try {
			return JSON.parse(readFileSync(this.recordPath(memberId), 'utf8')) as IBrowserRecord;
		} catch {
			return undefined;
		}
	}

	/** 成员关掉浏览器：用完了，不再记着开过的标签页。没开时返回 false。 */
	async close(memberId: string): Promise<boolean> {
		rmSync(this.recordPath(memberId), { force: true });
		return this.closeSession(memberId);
	}

	private async closeSession(memberId: string): Promise<boolean> {
		this.clearTimer(memberId);
		const session = this.sessions.get(memberId);
		if (!session) return false;
		this.sessions.delete(memberId);
		try {
			await (await session).context.close();
		} catch {
			// 没能打开，或者已经关了。
		}
		return true;
	}

	/** 成员被删除：关掉浏览器，浏览数据和开着的标签页都留着，恢复后和删除前一样。 */
	async suspend(memberId: string): Promise<void> {
		await this.closeSession(memberId);
	}

	/** 清除浏览数据：关掉浏览器，删掉登录状态、Cookie 等。 */
	async clear(memberId: string): Promise<void> {
		await this.close(memberId);
		// 浏览器刚退出时文件可能还占着，多试几次。
		rmSync(this.dataDirectory(memberId), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
	}

	/** 运行时关闭：关掉所有浏览器，记着的标签页留着，下次可以恢复。 */
	async shutdown(): Promise<void> {
		await Promise.all([...this.sessions.keys()].map(memberId => this.closeSession(memberId)));
	}

	/** 闲置关闭：先记下开着的标签页，注明是闲置关闭的。正好有新的操作时不关。 */
	private async closeIdle(memberId: string): Promise<void> {
		this.timers.delete(memberId);
		const session = await this.sessions.get(memberId)?.catch(() => undefined);
		if (session && !this.queues.has(memberId)) await this.remember(memberId, session, true);
		if (!this.queues.has(memberId)) await this.closeSession(memberId);
	}

	/** 记下开着的标签页；没有打开网页时删掉记录。记不下来不影响操作。 */
	private async remember(memberId: string, session: BrowserSession, idle = false): Promise<void> {
		try {
			const record = await session.record();
			if (record) writeFileSync(this.recordPath(memberId), JSON.stringify(idle ? { ...record, idle } : record));
			else rmSync(this.recordPath(memberId), { force: true });
		} catch {
			// 浏览器正在关，或者写不了文件。
		}
	}

	private session(memberId: string): Promise<BrowserSession> {
		let session = this.sessions.get(memberId);
		if (!session) {
			session = this.launch(memberId);
			this.sessions.set(memberId, session);
			const launching = session;
			session.catch(() => {
				if (this.sessions.get(memberId) === launching) this.sessions.delete(memberId);
			});
		}
		return session;
	}

	private async launch(memberId: string): Promise<BrowserSession> {
		const userDataDir = this.dataDirectory(memberId);
		mkdirSync(userDataDir, { recursive: true });
		const problems: string[] = [];
		// playwright-core 用到时再加载：启动时加载要一百多毫秒，不开浏览器就用不上。
		const { chromium } = await import('playwright-core');
		for (const { channel, name } of CHANNELS) {
			let context: BrowserContext;
			try {
				// Service Worker 发的请求拦不到，不启用。
				context = await chromium.launchPersistentContext(userDataDir, { channel, headless: true, viewport: VIEWPORT, serviceWorkers: 'block' });
			} catch (error) {
				problems.push(`${name}：${errorText(error).split('\n')[0]}`);
				continue;
			}
			const session = new BrowserSession(context);
			// 禁止访问的网址（运行时的网页端和用户加的）直接拦下，页面跳转和页面里发出的请求都算。
			// 发往其他本机地址的带上标记头：经过开发服务器转发到运行时的请求，运行时见到它就拒绝。
			await context.route(url => (url.protocol === 'http:' || url.protocol === 'https:') && (isLoopbackHost(url.hostname) || !!this.blocklist.reason(url)), async route => {
				const request = route.request();
				const url = new URL(request.url());
				const reason = this.blocklist.reason(url);
				if (reason !== undefined) {
					session.blocked(request, reason);
					return route.abort('blockedbyclient');
				}
				await route.continue(isLoopbackHost(url.hostname) ? { headers: { ...request.headers(), [MEMBER_BROWSER_HEADER]: '1' } } : undefined);
			});
			await context.routeWebSocket(url => !!this.blocklist.reason(url), async route => {
				session.blockedWebSocket(route.url(), this.blocklist.reason(new URL(route.url())) ?? '禁止访问');
				await route.close({ code: 1008, reason: 'blocked' });
			});
			context.setDefaultTimeout(ACTION_TIMEOUT_MS);
			context.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
			// 浏览器自己退出了（崩溃、被关掉）：下次用时重新打开。
			context.on('close', () => void this.sessions.get(memberId)?.then(current => {
				if (current.context === context) {
					this.sessions.delete(memberId);
					this.clearTimer(memberId);
				}
			}, () => undefined));
			return session;
		}
		throw invalid(`无法启动浏览器，需要电脑上安装 Edge 或 Chrome。\n${problems.join('\n')}`);
	}

	private dataDirectory(memberId: string): string {
		return join(this.directory, memberId);
	}

	private recordPath(memberId: string): string {
		return join(this.directory, `${memberId}.json`);
	}

	private armTimer(memberId: string): void {
		this.clearTimer(memberId);
		if (!this.sessions.has(memberId)) return;
		const timer = setTimeout(() => void this.closeIdle(memberId), this.idleCloseMs);
		timer.unref();
		this.timers.set(memberId, timer);
	}

	private clearTimer(memberId: string): void {
		clearTimeout(this.timers.get(memberId));
		this.timers.delete(memberId);
	}
}

function isFavicon(url: string): boolean {
	return /\/favicon\.ico(\?|$)/.test(url);
}

/** Playwright 报错的说明：去掉开头的方法名和颜色控制符，调用记录只留最后几行。 */
export function errorText(error: unknown): string {
	const message = errorMessage(error).replace(/\x1b\[[0-9;]*m/g, '');
	const [head = '', log = ''] = message.split(/\nCall log:\n/);
	const first = head.replace(/^[a-zA-Z]+\.[a-zA-Z]+: /, '').trim();
	const steps = log.split('\n').map(line => line.trim()).filter(Boolean).slice(-3);
	return [first, ...steps].join('\n');
}
