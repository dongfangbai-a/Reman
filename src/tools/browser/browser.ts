import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { ElementHandle, Locator, Page } from 'playwright-core';
import {
	errorText, NAVIGATION_TIMEOUT_MS, VIEWPORT, type Browsers, type BrowserSession, type IBrowserRecord,
} from '../../browsers/browsers.ts';
import { RuntimeError, invalid } from '../../common/errors.ts';
import { clipMiddle } from '../../common/text.ts';
import { formatDuration } from '../../common/time.ts';
import type { IToolImage, Resources } from '../../resources/resources.ts';
import { DataProtection } from '../protection.ts';
import type { ITool } from '../tools.ts';

const ACTIONS = ['open', 'snapshot', 'click', 'type', 'press', 'select', 'hover', 'scroll', 'resize', 'screenshot', 'back', 'reload', 'restore', 'tabs', 'switch_tab', 'close_tab', 'evaluate', 'console', 'wait', 'close'] as const;
type Action = typeof ACTIONS[number];
/** 改变页面的动作：结果直接带上新的快照。 */
const CHANGES_PAGE: ReadonlySet<Action> = new Set(['open', 'click', 'type', 'press', 'select', 'hover', 'scroll', 'resize', 'back', 'reload', 'switch_tab', 'close_tab', 'wait']);
/** 自己等页面反应的动作，最后不用再等。 */
const SETTLES_ITSELF: ReadonlySet<Action> = new Set(['scroll', 'wait']);
/** 在外部网站上要审批的动作。 */
const INTERACTIONS: ReadonlySet<Action> = new Set(['click', 'type', 'press', 'select', 'evaluate']);
/** 页面快照、脚本返回值交给模型时的长度上限，保留开头和结尾。 */
const HEAD_CHARS = 15_000;
const TAIL_CHARS = 5_000;
const MAX_WAIT_SECONDS = 30;
const DEFAULT_WAIT_SECONDS = 10;
const MAX_SCROLL_SCREENS = 10;
/** 滚一屏滚多少：留一点重叠，免得漏看。 */
const SCREEN_RATIO = 0.9;
const DIRECTIONS = ['up', 'down', 'left', 'right'] as const;
type Direction = typeof DIRECTIONS[number];
/** 页面大小的范围：宽从手机到 4K 屏，高同样。 */
const WIDTH_RANGE = [320, 3840] as const;
const HEIGHT_RANGE = [200, 2160] as const;
/** 操作后等页面反应：先等一小会儿，再等新页面加载完。 */
const SETTLE_MS = 500;
const SETTLE_LOAD_MS = 5_000;

const DESCRIPTION = `操作你自己的浏览器：打开网页、读取页面、点击、输入、截图、查看页面日志。用于验证网页、查找资料。浏览器没有窗口，用户无法看到。
- 点击、输入、打开等会改变页面的操作完成后，直接返回新的页面内容，无需再调用 snapshot。
- 有 run_tool_script 时，无需根据中间页面做判断的连续操作（如按读取到的编号填写表单后提交、逐个打开多个页面检查报错），可写在 run_tool_script 的脚本中一次完成：中间的页面内容保留在脚本中，只输出所需的结果。
- 页面弹出的提示框会自动确认；页面打开的新标签页会自动切换过去。
- 登录状态会保存，下次打开时仍然有效。遇到需要输入密码、验证码，或需要用户本人确认的页面时，不要猜测，也不要让用户把密码发给你，应停止操作并告知用户。`;

/** 只说明名字看不出来或者容易误解的动作，其他的用法见各自参数的说明。 */
const ACTION_DESCRIPTION = 'snapshot 读取页面：返回整个页面的结构和文字，不限于可见部分，可操作的元素带有编号（如 [ref=e5]）；screenshot 截图；scroll 滚动：读取页面时一般不需要，仅在长列表只显示可见部分（滚动加载更多）、或需要截取滚动区域内的画面时使用；console 查看上次查看之后的控制台输出、页面报错和失败的请求；close 关闭整个浏览器';

/** 一次操作后的页面：当前标签页、地址、标题，以及这次操作要返回的内容。 */
export interface IBrowserPage {
	/** 当前是第几个标签页，从 1 数；全部关掉了时是 0。 */
	readonly tab: number;
	readonly tabCount: number;
	readonly url: string;
	readonly title: string;
	readonly snapshot?: string;
	readonly image?: IToolImage;
	/** evaluate 的返回值。 */
	readonly result?: unknown;
	readonly logs?: readonly string[];
	readonly tabs?: readonly { readonly url: string; readonly title: string }[];
	/** 要告诉成员的事，如页面打开了新标签页、等的文字没有出现。 */
	readonly notes?: readonly string[];
	/** 上次查看日志之后的报错数。 */
	readonly newErrors: number;
}

export function createBrowserTool(browsers: Browsers, resources: Resources, protection = new DataProtection()): ITool<IBrowserPage | string> {
	/** 成员的浏览器不能打开这个网址时返回原因：运行时的数据目录里的文件、禁止访问的网址。 */
	const forbidden = async (url: string): Promise<string | undefined> => {
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			return undefined;
		}
		if (parsed.protocol !== 'file:') return browsers.blocklist.reason(parsed);
		let path: string;
		try {
			path = fileURLToPath(parsed);
		} catch {
			return undefined;
		}
		return await protection.isProtected(path) ? `不能打开运行时数据目录中的文件：${path}` : undefined;
	};
	return {
		name: 'browser',
		label: '使用浏览器',
		description: DESCRIPTION,
		parameters: {
			type: 'object',
			properties: {
				action: { type: 'string', enum: ACTIONS, description: ACTION_DESCRIPTION },
				url: { type: 'string', description: 'open：要打开的网址' },
				new_tab: { type: 'boolean', description: 'open：为 true 时在新标签页打开' },
				ref: { type: 'string', description: '元素编号，如 e5，仅对最近一次读取的页面有效。click、type、select、hover 必须提供，press、screenshot 可选' },
				element: { type: 'string', description: '要操作的元素，向用户展示的简短说明，如「登录按钮」' },
				text: { type: 'string', description: 'type：要输入的文字，替换原有内容；wait：要等待出现的文字' },
				submit: { type: 'boolean', description: 'type：为 true 时输入后按回车' },
				key: { type: 'string', description: 'press：按键，如 Enter、Escape、ArrowDown、Control+A' },
				values: { type: 'array', items: { type: 'string' }, description: 'select：要选择的选项（选项的文字或值）' },
				direction: { type: 'string', enum: DIRECTIONS, description: 'scroll：滚动方向' },
				amount: { type: 'number', exclusiveMinimum: 0, maximum: MAX_SCROLL_SCREENS, description: `scroll：滚动的屏数，默认 1，最多 ${MAX_SCROLL_SCREENS}；提供 ref 时滚动该元素所在的滚动区域，否则滚动页面中央所在的区域` },
				width: { type: 'integer', minimum: WIDTH_RANGE[0], maximum: WIDTH_RANGE[1], description: `resize：页面宽度，${WIDTH_RANGE[0]}–${WIDTH_RANGE[1]}，默认 ${VIEWPORT.width}` },
				height: { type: 'integer', minimum: HEIGHT_RANGE[0], maximum: HEIGHT_RANGE[1], description: `resize：页面高度，${HEIGHT_RANGE[0]}–${HEIGHT_RANGE[1]}，默认 ${VIEWPORT.height}` },
				full_page: { type: 'boolean', description: 'screenshot：为 true 时截整个页面' },
				tab: { type: 'integer', minimum: 1, description: 'switch_tab、close_tab：标签页序号，从 1 开始；close_tab 不提供时关闭当前标签页' },
				script: { type: 'string', description: 'evaluate：JavaScript 表达式，如 document.title；多句时写成 (() => { ... })()；返回值须能转换为 JSON' },
				seconds: { type: 'number', exclusiveMinimum: 0, maximum: MAX_WAIT_SECONDS, description: `wait：等待的秒数，最多 ${MAX_WAIT_SECONDS}；提供 text 时为最长等待时间，默认 ${DEFAULT_WAIT_SECONDS}` },
			},
			required: ['action'],
			additionalProperties: false,
		},
		returns: '{ tab: number; tabCount: number; url: string; title: string; snapshot?: string; image?: InputImage; result?: unknown; logs?: string[]; tabs?: { url: string; title: string }[]; notes?: string[]; newErrors: number } | string',
		defaultPolicy: 'auto',
		autoPolicy: { label: '只读操作和本机网页免审批', description: '打开网页、读取页面、截图等直接执行；点击、输入、执行脚本在本机网页（localhost、127.0.0.1）上直接执行，在其他网站上须审批' },
		needsApproval: async (context, args) => {
			const action = parseAction(args);
			if (!INTERACTIONS.has(action)) return undefined;
			const url = await browsers.currentUrl(context.memberId);
			if (url === undefined || isLocalUrl(url)) return undefined;
			// 要做什么网页端按参数显示；成员给的元素说明可能和页面上的不一样，所以页面上实际的元素写在原因里。
			const ref = typeof args['ref'] === 'string' ? args['ref'] : undefined;
			const element = ref && await browsers.describeElement(context.memberId, ref);
			return element ? [`其他网站：${url}`, `元素：${element}`] : `其他网站：${url}`;
		},
		// 要打开的网址不能打开时直接报错，不用审批，也不开浏览器。
		refuseReason: async (_, args) => parseAction(args) === 'open' ? await forbidden(normalizeUrl(requiredString(args, 'url'))) : undefined,
		execute: async (context, args) => {
			const action = parseAction(args);
			const memberId = context.memberId;
			const run = (operation: (session: BrowserSession) => Promise<IBrowserPage>) => browsers.use(memberId, async session => {
				try {
					const page = await operation(session).catch(async (error: unknown) => {
						// 跳转被拦下时，拦下的原因比 Playwright 的报错清楚。
						await closeForbiddenPages(session, forbidden);
						throw error;
					});
					// 点链接、重定向也可能去到不能打开的地方，开着的页面也可能刚被禁止：换成空白页，这次的结果不交给成员。
					await closeForbiddenPages(session, forbidden);
					return page;
				} catch (error) {
					if (error instanceof RuntimeError) throw error;
					throw invalid(errorText(error));
				}
			});
			// 审批之前查过；等审批的时候用户可能刚加了禁止的网址，再查一次。
			if (action === 'open') {
				const reason = await forbidden(normalizeUrl(requiredString(args, 'url')));
				if (reason !== undefined) throw invalid(reason);
			}
			if (action === 'close') return await browsers.close(memberId) ? '已关闭浏览器' : '浏览器未打开';
			if (action === 'restore') {
				if (browsers.isOpen(memberId)) throw invalid('浏览器已打开，无需恢复');
				const record = browsers.lastTabs(memberId);
				if (!record) throw invalid('没有可恢复的标签页');
				return run(session => restore(session, record, forbidden));
			}
			if (action !== 'open' && !browsers.isOpen(memberId)) throw invalid(closedText(browsers.lastTabs(memberId), browsers.idleCloseMs));
			return run(session => perform(session, action, args, resources, context.signal));
		},
		format(result) {
			if (typeof result === 'string') return result;
			const lines = [result.tabCount === 0 ? '[没有已打开的标签页]' : `[标签页 ${result.tab}/${result.tabCount}] ${result.title || '（无标题）'} — ${result.url}`];
			lines.push(...result.notes ?? []);
			if (result.tabs) lines.push(...tabLines(result.tabs, result.tab));
			if (result.logs) lines.push(result.logs.length > 0 ? result.logs.join('\n') : '（无新日志）');
			if ('result' in result) lines.push(`返回值：${resultText(result.result)}`);
			if (result.image) lines.push(`截图 1，文件位于 ${result.image.path}`);
			if (result.snapshot !== undefined) lines.push(result.snapshot || '（页面为空）');
			if (result.newErrors > 0 && !result.logs) lines.push(`页面有 ${result.newErrors} 条新的报错，可用 console 查看`);
			return { text: lines.join('\n'), images: result.image ? [result.image] : [] };
		},
	};
}

async function perform(session: BrowserSession, action: Action, args: Record<string, unknown>, resources: Resources, signal: AbortSignal): Promise<IBrowserPage> {
	const notes: string[] = [];
	let extra: Partial<IBrowserPage> = {};
	switch (action) {
		case 'open': {
			const url = normalizeUrl(requiredString(args, 'url'));
			if (args['new_tab'] !== undefined && typeof args['new_tab'] !== 'boolean') throw invalid('new_tab 只能是 true 或 false');
			const page = args['new_tab'] === true ? await session.newTab() : session.currentPage() ?? await session.newTab();
			await navigate(() => page.goto(url, { waitUntil: 'load' }), notes);
			break;
		}
		case 'snapshot':
			session.requirePage();
			break;
		case 'click':
			await (await locate(session, args)).click();
			break;
		case 'type': {
			const text = requiredString(args, 'text', true);
			const locator = await locate(session, args);
			await locator.fill(text);
			if (args['submit'] === true) await locator.press('Enter');
			break;
		}
		case 'press': {
			const key = requiredString(args, 'key');
			if (args['ref'] !== undefined) await (await locate(session, args)).press(key);
			else await session.requirePage().keyboard.press(key);
			break;
		}
		case 'select': {
			const values = args['values'];
			if (!Array.isArray(values) || values.length === 0 || !values.every(value => typeof value === 'string')) throw invalid('values 必须是非空的字符串数组');
			await (await locate(session, args)).selectOption(values as string[]);
			break;
		}
		case 'hover':
			await (await locate(session, args)).hover();
			break;
		case 'scroll':
			await scroll(session, args, notes);
			break;
		case 'resize':
			session.requirePage();
			await session.resize(inRange(args, 'width', WIDTH_RANGE, VIEWPORT.width), inRange(args, 'height', HEIGHT_RANGE, VIEWPORT.height));
			break;
		case 'screenshot': {
			const page = session.requirePage();
			if (args['full_page'] !== undefined && typeof args['full_page'] !== 'boolean') throw invalid('full_page 只能是 true 或 false');
			const bytes = args['ref'] !== undefined ? await (await locate(session, args)).screenshot() : await page.screenshot({ fullPage: args['full_page'] === true });
			extra = { image: resources.toolImage(bytes, `浏览器截图 ${page.url()}`) };
			break;
		}
		case 'back': {
			const page = session.requirePage();
			const response = await navigate(() => page.goBack({ waitUntil: 'load' }), notes);
			if (response === null) notes.push('没有可后退的页面');
			break;
		}
		case 'reload': {
			const page = session.requirePage();
			await navigate(() => page.reload({ waitUntil: 'load' }), notes);
			break;
		}
		case 'tabs':
			extra = { tabs: await Promise.all(session.pages().map(async page => ({ url: page.url(), title: await page.title().catch(() => '') }))) };
			break;
		case 'switch_tab':
			await session.switchTo(integer(args, 'tab'));
			break;
		case 'close_tab': {
			const current = session.currentPage();
			const tab = args['tab'] === undefined && current ? session.pages().indexOf(current) + 1 : integer(args, 'tab');
			await session.closeTab(tab);
			break;
		}
		case 'evaluate': {
			const script = requiredString(args, 'script');
			const value: unknown = await session.requirePage().evaluate(script);
			const text = resultText(value);
			extra = { result: text.length > HEAD_CHARS + TAIL_CHARS ? clipMiddle(text, HEAD_CHARS, TAIL_CHARS) : value };
			break;
		}
		case 'console':
			session.requirePage();
			extra = { logs: session.takeLogs() };
			break;
		case 'wait':
			await wait(session, args, notes, signal);
			break;
	}
	if (CHANGES_PAGE.has(action) && !SETTLES_ITSELF.has(action)) await settle(session);
	return describePage(session, action === 'snapshot' || CHANGES_PAGE.has(action), [...session.takeNotes(), ...notes], extra);
}

/** 把停在不能打开的地方的标签页换成空白页，包括跳转被拦下、停在报错页的；有这样的标签页时报错。 */
async function closeForbiddenPages(session: BrowserSession, forbidden: (url: string) => Promise<string | undefined>): Promise<void> {
	const blockedPages = session.takeBlockedPages();
	const reasons: string[] = [];
	for (const page of session.pages()) {
		const url = page.url();
		const reason = await forbidden(url) ?? (url.startsWith('chrome-error:') ? blockedPages.get(page) : undefined);
		if (reason === undefined) continue;
		await page.goto('about:blank');
		if (!reasons.includes(reason)) reasons.push(reason);
	}
	if (reasons.length > 0) throw invalid(reasons.map(reason => `${reason}，已替换为空白页`).join('\n'));
}

/** 重新打开记下的标签页，恢复页面大小，切到当时的标签页。打不开、不能打开的页面写进说明，不算出错。 */
async function restore(session: BrowserSession, record: IBrowserRecord, forbidden: (url: string) => Promise<string | undefined>): Promise<IBrowserPage> {
	const notes: string[] = [];
	await session.resize(record.viewport.width, record.viewport.height);
	const pages = [session.currentPage() ?? await session.newTab()];
	while (pages.length < record.tabs.length) pages.push(await session.newTab());
	await Promise.all(record.tabs.map(async ({ url }, index) => {
		const reason = await forbidden(url);
		if (reason !== undefined) {
			notes.push(`未打开 ${url}：${reason}`);
			return;
		}
		try {
			await pages[index]!.goto(url, { waitUntil: 'load' });
		} catch (error) {
			const timeout = error instanceof Error && error.name === 'TimeoutError';
			notes.push(timeout ? `${url} 在 ${NAVIGATION_TIMEOUT_MS / 1000} 秒内未加载完成` : `无法打开 ${url}：${errorText(error)}`);
		}
	}));
	if (record.current >= 1 && record.current <= pages.length) await session.switchTo(record.current);
	await settle(session);
	return describePage(session, true, [...session.takeNotes(), ...notes], {});
}

/** 浏览器没开时的说明：浏览器自己关掉的，写明原因和当时开着的标签页。 */
function closedText(record: IBrowserRecord | undefined, idleCloseMs: number): string {
	if (!record) return '浏览器尚未打开，请先用 open 打开网页';
	const reason = record.idle ? `浏览器闲置超过 ${formatDuration(idleCloseMs, true)}，已自动关闭` : '浏览器已关闭（运行时曾重启或浏览器意外退出）';
	return [`${reason}。关闭前打开的标签页：`, ...tabLines(record.tabs, record.current), '可用 restore 重新打开这些标签页，或用 open 打开网页。'].join('\n');
}

/** 标签页列表，每个一行，标出当前的。 */
function tabLines(tabs: readonly { readonly url: string; readonly title: string }[], current: number): string[] {
	return tabs.map((tab, index) => `${index + 1}. ${tab.title || '（无标题）'} — ${tab.url}${index + 1 === current ? '（当前）' : ''}`);
}

/** 当前页面的情况；要快照时带上快照。 */
async function describePage(session: BrowserSession, withSnapshot: boolean, notes: readonly string[], extra: Partial<IBrowserPage>): Promise<IBrowserPage> {
	const pages = session.pages();
	const page = session.currentPage();
	const base = {
		tab: page ? pages.indexOf(page) + 1 : 0,
		tabCount: pages.length,
		url: page?.url() ?? '',
		title: page ? await page.title().catch(() => '') : '',
		...notes.length > 0 && { notes },
		newErrors: session.newErrors,
	};
	if (!page || !withSnapshot) return { ...base, ...extra };
	const snapshot = await page.ariaSnapshot({ mode: 'ai' });
	return { ...base, ...extra, snapshot: clipMiddle(snapshot, HEAD_CHARS, TAIL_CHARS) };
}

/** 按编号找当前页面上的元素；找不到时马上报错，不等到超时。 */
async function locate(session: BrowserSession, args: Record<string, unknown>): Promise<Locator> {
	const ref = requiredString(args, 'ref');
	const locator = session.requirePage().getByRef(ref);
	if (await locator.count() === 0) throw invalid(`未找到元素 ${ref}：页面可能已变化，或元素不可见。请先用 snapshot 重新读取页面`);
	return locator;
}

/** 打开、后退、刷新：加载超时不算出错，返回当时的页面；打不开时报错。 */
async function navigate<T>(go: () => Promise<T>, notes: string[]): Promise<T | undefined> {
	try {
		return await go();
	} catch (error) {
		if (error instanceof Error && error.name === 'TimeoutError') {
			notes.push(`页面在 ${NAVIGATION_TIMEOUT_MS / 1000} 秒内未加载完成，以下是当前的页面内容`);
			return undefined;
		}
		throw invalid(`无法打开网页：${errorText(error)}`);
	}
}

/** 等一段文字出现，或者等几秒。等不到不算出错，返回当时的页面。 */
async function wait(session: BrowserSession, args: Record<string, unknown>, notes: string[], signal: AbortSignal): Promise<void> {
	const page = session.requirePage();
	const text = args['text'];
	const seconds = args['seconds'];
	if (seconds !== undefined && (typeof seconds !== 'number' || !(seconds > 0) || seconds > MAX_WAIT_SECONDS)) throw invalid(`seconds 必须是 0 到 ${MAX_WAIT_SECONDS} 之间的数值`);
	if (text === undefined) {
		if (seconds === undefined) throw invalid('wait 须提供 text 或 seconds');
		await delay(seconds * 1000, undefined, { signal });
		return;
	}
	if (typeof text !== 'string' || !text) throw invalid('text 必须是非空的字符串');
	const timeout = (seconds ?? DEFAULT_WAIT_SECONDS) * 1000;
	try {
		await page.getByText(text).first().waitFor({ state: 'visible', timeout });
	} catch (error) {
		if (!(error instanceof Error) || error.name !== 'TimeoutError') throw error;
		notes.push(`已等待 ${timeout / 1000} 秒，未出现「${text}」`);
	}
}

/**
 * 滚动：鼠标移到区域上用滚轮滚，和人一样，滚到底时加载更多的页面会照常反应。
 * 等页面反应后写明滚到了哪：到没到头、还有约几屏；没滚动时写原因。
 */
async function scroll(session: BrowserSession, args: Record<string, unknown>, notes: string[]): Promise<void> {
	const direction = args['direction'];
	if (typeof direction !== 'string' || !(DIRECTIONS as readonly string[]).includes(direction)) throw invalid(`direction 只能是 ${DIRECTIONS.join('、')}`);
	const amount = args['amount'] ?? 1;
	if (typeof amount !== 'number' || !(amount > 0) || amount > MAX_SCROLL_SCREENS) throw invalid(`amount 必须是 0 到 ${MAX_SCROLL_SCREENS} 之间的数值`);
	const page = session.requirePage();
	const point = args['ref'] !== undefined ? await visibleCenter(page, await locate(session, args)) : await viewportCenter(page);
	const vertical = direction === 'up' || direction === 'down';
	const area = await scrollArea(page, point, vertical);
	try {
		const before = await area.evaluate(measure);
		const sign = direction === 'up' || direction === 'left' ? -1 : 1;
		const distance = Math.round((vertical ? before.clientHeight : before.clientWidth) * SCREEN_RATIO * amount) * sign;
		await page.mouse.move(point.x, point.y);
		await page.mouse.wheel(vertical ? 0 : distance, vertical ? distance : 0);
		await settle(session);
		const after = await area.evaluate(measure).catch(() => undefined);
		notes.push(after ? scrollNote(direction as Direction, before, after) : '滚动后页面已变化，请查看以下内容');
	} finally {
		await area.dispose();
	}
}

/** 滚动区域的位置和大小。 */
export interface IScrollMetrics {
	readonly top: number;
	readonly left: number;
	readonly scrollHeight: number;
	readonly scrollWidth: number;
	readonly clientHeight: number;
	readonly clientWidth: number;
}

/** 页面里的元素。运行时的类型里没有 DOM，用到的几样自己写。 */
interface IPageElement {
	readonly scrollTop: number;
	readonly scrollLeft: number;
	readonly scrollHeight: number;
	readonly scrollWidth: number;
	readonly clientHeight: number;
	readonly clientWidth: number;
	readonly parentElement: IPageElement | null;
}

/** 在页面里执行：区域的滚动位置和大小。 */
function measure(element: unknown): IScrollMetrics {
	const area = element as IPageElement;
	return { top: area.scrollTop, left: area.scrollLeft, scrollHeight: area.scrollHeight, scrollWidth: area.scrollWidth, clientHeight: area.clientHeight, clientWidth: area.clientWidth };
}

/** 这个点上往这个方向能滚的区域：从这个点上的元素往外找第一个能滚的，都不能滚时是整个页面。 */
async function scrollArea(page: Page, point: { x: number; y: number }, vertical: boolean): Promise<ElementHandle> {
	const handle = await page.evaluateHandle(({ x, y, vertical }) => {
		const window = globalThis as unknown as {
			document: { elementFromPoint(x: number, y: number): IPageElement | null; scrollingElement: IPageElement | null; documentElement: IPageElement };
			getComputedStyle(element: IPageElement): { overflowX: string; overflowY: string };
		};
		for (let element = window.document.elementFromPoint(x, y); element; element = element.parentElement) {
			const style = window.getComputedStyle(element);
			const overflows = vertical ? element.scrollHeight > element.clientHeight : element.scrollWidth > element.clientWidth;
			if (overflows && /auto|scroll|overlay/.test(vertical ? style.overflowY : style.overflowX)) return element;
		}
		return window.document.scrollingElement ?? window.document.documentElement;
	}, { ...point, vertical });
	const element = handle.asElement();
	if (!element) throw invalid('未找到可滚动的区域');
	return element;
}

/** 页面正中。 */
async function viewportCenter(page: Page): Promise<{ x: number; y: number }> {
	const size = page.viewportSize() ?? await page.evaluate(() => {
		const window = globalThis as unknown as { innerWidth: number; innerHeight: number };
		return { width: window.innerWidth, height: window.innerHeight };
	});
	return { x: size.width / 2, y: size.height / 2 };
}

/** 元素看得见的部分的中心：先滚到看得见的地方，比窗口大时取和窗口重叠的部分。 */
async function visibleCenter(page: Page, locator: Locator): Promise<{ x: number; y: number }> {
	await locator.scrollIntoViewIfNeeded();
	const box = await locator.boundingBox();
	if (!box) throw invalid('该元素不可见，无法在其上滚动');
	const center = await viewportCenter(page);
	const left = Math.max(box.x, 0);
	const top = Math.max(box.y, 0);
	const right = Math.min(box.x + box.width, center.x * 2);
	const bottom = Math.min(box.y + box.height, center.y * 2);
	return { x: (left + right) / 2, y: (top + bottom) / 2 };
}

/** 滚动后写明滚到了哪：到没到头、还有约几屏；没滚动时写原因。 */
export function scrollNote(direction: Direction, before: IScrollMetrics, after: IScrollMetrics): string {
	const vertical = direction === 'up' || direction === 'down';
	const forward = direction === 'down' || direction === 'right';
	const position = (metrics: IScrollMetrics) => vertical ? metrics.top : metrics.left;
	const view = vertical ? after.clientHeight : after.clientWidth;
	const total = vertical ? after.scrollHeight : after.scrollWidth;
	const end = ({ down: '底部', up: '顶部', right: '最右侧', left: '最左侧' } as const)[direction];
	const side = ({ down: '下方', up: '上方', right: '右侧', left: '左侧' } as const)[direction];
	if (total <= view + 1) return `未滚动：此处无法${vertical ? '上下' : '左右'}滚动，可用 ref 指定要滚动的区域`;
	const remaining = forward ? total - view - position(after) : position(after);
	const moved = Math.abs(position(after) - position(before)) >= 1;
	if (remaining <= 1) return moved ? `已到${end}` : `未滚动：已位于${end}`;
	const screens = Math.round(remaining / view * 10) / 10;
	return `${moved ? '' : '未滚动：页面无响应，'}${side}还有约 ${screens} 屏`;
}

/** 操作后等页面反应，点击打开了新页面时等它加载完。 */
async function settle(session: BrowserSession): Promise<void> {
	await delay(SETTLE_MS);
	await session.currentPage()?.waitForLoadState('load', { timeout: SETTLE_LOAD_MS }).catch(() => undefined);
}

/**
 * 本机网页：回环地址（localhost、*.localhost、127.*、[::1]），以及本地文件和空白页。
 * 在这些页面上点击、输入不用审批。
 */
export function isLocalUrl(url: string): boolean {
	if (url === '' || url === 'about:blank') return true;
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	if (parsed.protocol === 'file:') return true;
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
	const host = parsed.hostname;
	return host === 'localhost' || host.endsWith('.localhost') || /^127(\.\d{1,3}){3}$/.test(host) || host === '[::1]';
}

/** 补上省略的协议：本机地址用 http，其他用 https。只能打开网页、本地文件和空白页。 */
export function normalizeUrl(input: string): string {
	const text = input.trim();
	const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) && !/^[^/:]+:\d+(\/|$)/.test(text)
		? text
		: `${isLocalUrl(`http://${text}`) ? 'http' : 'https'}://${text}`;
	let url: URL;
	try {
		url = new URL(withScheme);
	} catch {
		throw invalid(`网址格式有误：${input}`);
	}
	if (!['http:', 'https:', 'file:', 'about:'].includes(url.protocol)) throw invalid(`只能打开 http、https、file 网址和 about:blank：${input}`);
	return url.href;
}

function parseAction(args: Record<string, unknown>): Action {
	const action = args['action'];
	if (typeof action !== 'string' || !(ACTIONS as readonly string[]).includes(action)) throw invalid(`action 只能是 ${ACTIONS.join('、')}`);
	return action as Action;
}

function requiredString(args: Record<string, unknown>, name: string, allowEmpty = false): string {
	const value = args[name];
	if (typeof value !== 'string' || (!allowEmpty && !value.trim())) throw invalid(`${name} 必须是${allowEmpty ? '' : '非空的'}字符串`);
	return value;
}

function integer(args: Record<string, unknown>, name: string): number {
	const value = args[name];
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw invalid(`${name} 必须是正整数`);
	return value;
}

/** 范围里的整数，不给时用 fallback。 */
function inRange(args: Record<string, unknown>, name: string, [min, max]: readonly [number, number], fallback: number): number {
	const value = args[name] ?? fallback;
	if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw invalid(`${name} 必须是 ${min} 到 ${max} 之间的整数`);
	return value;
}

function resultText(value: unknown): string {
	if (value === undefined) return 'undefined';
	return typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? String(value);
}
