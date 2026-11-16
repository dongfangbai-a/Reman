import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';
import { BrowserBlocklist } from '../../browsers/blocklist.ts';
import { Browsers, MEMBER_BROWSER_HEADER } from '../../browsers/browsers.ts';
import { RuntimeError } from '../../common/errors.ts';
import { Resources } from '../../resources/resources.ts';
import { createBrowserTool, isLocalUrl, normalizeUrl, scrollNote, type IBrowserPage } from './browser.ts';
import { DataProtection } from '../protection.ts';
import type { IToolContext } from '../tools.ts';

test('本机网页：回环地址、本地文件和空白页', () => {
	for (const url of ['about:blank', 'http://localhost:5173/', 'https://app.localhost/x', 'http://127.0.0.1:4800/', 'http://127.1.2.3/', 'http://[::1]:3000/', 'file:///C:/a.html']) assert.equal(isLocalUrl(url), true, url);
	for (const url of ['https://example.com/', 'http://localhost.example.com/', 'http://192.168.1.2/', 'data:text/html,<p>x</p>', 'chrome-error://chromewebdata/']) assert.equal(isLocalUrl(url), false, url);
});

test('网址补上协议：本机地址用 http，其他用 https；只能打开网页、本地文件和空白页', () => {
	assert.equal(normalizeUrl('localhost:5173/login'), 'http://localhost:5173/login');
	assert.equal(normalizeUrl('127.0.0.1:4800'), 'http://127.0.0.1:4800/');
	assert.equal(normalizeUrl('example.com'), 'https://example.com/');
	assert.equal(normalizeUrl('http://example.com/a?b=1'), 'http://example.com/a?b=1');
	assert.equal(normalizeUrl('about:blank'), 'about:blank');
	assert.throws(() => normalizeUrl('javascript:alert(1)'), /只能打开/);
	assert.throws(() => normalizeUrl('edge://settings'), /只能打开/);
});

test('只读操作和本机网页不审批：外部网站上的点击、输入、执行脚本要审批，原因写网站和页面上实际的元素', async () => {
	let url: string | undefined = 'http://localhost:5173/';
	const browsers = {
		currentUrl: async () => url,
		describeElement: async (_: string, ref: string) => ref === 'e5' ? 'button "付款"' : undefined,
	} as unknown as Browsers;
	const tool = createBrowserTool(browsers, new Resources(tmpdir()));
	const context: IToolContext = { memberId: 'M_A', workingDirectory: tmpdir(), signal: new AbortController().signal };
	const ask = (args: Record<string, unknown>) => tool.needsApproval!(context, args);

	assert.equal(await ask({ action: 'click', ref: 'e5' }), undefined);
	url = 'https://shop.example.com/cart';
	for (const action of ['open', 'snapshot', 'screenshot', 'hover', 'console', 'tabs', 'wait', 'back', 'close']) assert.equal(await ask({ action, ref: 'e5', url: 'https://example.com' }), undefined, action);
	assert.deepEqual(await ask({ action: 'click', ref: 'e5', element: '取消按钮' }), ['其他网站：https://shop.example.com/cart', '元素：button "付款"']);
	assert.equal(await ask({ action: 'click', ref: 'e9', element: '取消按钮' }), '其他网站：https://shop.example.com/cart');
	assert.equal(await ask({ action: 'evaluate', script: 'document.cookie' }), '其他网站：https://shop.example.com/cart');
	url = undefined;
	assert.equal(await ask({ action: 'click', ref: 'e5' }), undefined);
	await assert.rejects(async () => ask({ action: 'jump' }), RuntimeError);
});

test('滚动后写明滚到了哪：到没到头、还有约几屏，没滚动时写原因', () => {
	const at = (top: number, scrollHeight = 3000) => ({ top, left: 0, scrollHeight, scrollWidth: 1000, clientHeight: 1000, clientWidth: 1000 });
	assert.equal(scrollNote('down', at(0), at(900)), '下方还有约 1.1 屏');
	assert.equal(scrollNote('down', at(900), at(2000)), '已到底部');
	assert.equal(scrollNote('down', at(2000), at(2000)), '未滚动：已位于底部');
	assert.equal(scrollNote('down', at(0), at(0)), '未滚动：页面无响应，下方还有约 2 屏');
	assert.equal(scrollNote('up', at(900), at(0)), '已到顶部');
	assert.equal(scrollNote('up', at(2000), at(1500)), '上方还有约 1.5 屏');
	assert.equal(scrollNote('down', at(0, 1000), at(0, 1000)), '未滚动：此处无法上下滚动，可用 ref 指定要滚动的区域');
	// 滚到底后页面又加载了更多：按滚动后的高度算。
	assert.equal(scrollNote('down', at(0), at(2000, 4000)), '下方还有约 1 屏');
	assert.equal(scrollNote('right', { ...at(0), scrollWidth: 2500, left: 0 }, { ...at(0), scrollWidth: 2500, left: 1500 }), '已到最右侧');
});

/** 起一个本机网站和一个浏览器；电脑上没有 Edge 或 Chrome 时跳过这个测试，open 返回 undefined。 */
async function startBrowser(t: TestContext, pages: Record<string, string>, idleCloseMs?: number) {
	const server = createServer((request, response) => {
		response.setHeader('Content-Type', 'text/html; charset=utf-8');
		const page = pages[request.url ?? ''];
		if (page === undefined) response.statusCode = 404;
		response.end(page);
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const directory = mkdtempSync(join(tmpdir(), 'reman-browser-'));
	const browsers = new Browsers(join(directory, 'browsers'), idleCloseMs);
	t.after(async () => {
		await browsers.shutdown();
		server.close();
		rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
	});
	const tool = createBrowserTool(browsers, new Resources(join(directory, 'resources')));
	const context: IToolContext = { memberId: 'M_A', workingDirectory: directory, signal: new AbortController().signal };
	const call = async (args: Record<string, unknown>) => await tool.execute(context, args) as IBrowserPage;
	const open = async (path: string): Promise<IBrowserPage | undefined> => {
		try {
			return await call({ action: 'open', url: `${base}${path}` });
		} catch (error) {
			if (error instanceof RuntimeError && error.message.startsWith('无法启动浏览器')) {
				t.skip('电脑上没有 Edge 或 Chrome');
				return undefined;
			}
			throw error;
		}
	};
	return { directory, browsers, tool, context, call, open };
}

function ref(page: IBrowserPage, pattern: string): string {
	return new RegExp(`${pattern} \\[ref=(\\w+)\\]`).exec(page.snapshot ?? '')?.[1] ?? assert.fail(`没找到 ${pattern}：\n${page.snapshot}`);
}

test('浏览器：打开本机网页、按编号输入和点击、看日志、新标签页、截图、执行脚本，关闭后清除浏览数据', async t => {
	const { directory, browsers, tool, context, call, open } = await startBrowser(t, {
		'/': `<title>登录</title><h1>请登录</h1><label>用户名 <input></label>
			<button onclick="document.querySelector('h1').textContent = '欢迎 ' + document.querySelector('input').value; fetch('/missing')">提交</button>
			<button onclick="confirm('确定吗？') && (document.title = '已确认')">确认</button>
			<a href="/next" target="_blank">新窗口</a><script>console.error('坏了')</script>`,
		'/next': '<title>下一页</title><p>第二页</p>',
	});

	await assert.rejects(async () => call({ action: 'snapshot' }), /先用 open 打开网页/);
	let page = await open('/');
	if (!page) return;
	assert.equal(page.title, '登录');
	assert.equal(page.newErrors, 1);
	assert.match((tool.format!(page) as { text: string }).text, /^\[标签页 1\/1\] 登录 — http:\/\/127\.0\.0\.1:\d+\/\n[\s\S]*heading "请登录"[\s\S]*页面有 1 条新的报错，可用 console 查看$/);

	// 没变的元素在新快照里编号不变：脚本里可以接着用最近一次读到的编号。
	const submit = ref(page, 'button "提交"');
	const typed = await call({ action: 'type', ref: ref(page, 'textbox "用户名"'), text: '张三' });
	assert.equal(ref(typed, 'button "提交"'), submit);
	page = await call({ action: 'click', ref: submit, element: '提交按钮' });
	assert.match(page.snapshot!, /heading "欢迎 张三"/);
	await assert.rejects(async () => call({ action: 'click', ref: 'e999' }), /未找到元素 e999/);

	page = await call({ action: 'click', ref: ref(page, 'button "确认"') });
	assert.equal(page.title, '已确认');
	const logs = (await call({ action: 'console' })).logs!;
	assert.ok(logs.some(line => line === '[控制台 error] 坏了'), logs.join('\n'));
	assert.ok(logs.some(line => /^\[HTTP 404\] GET .*\/missing$/.test(line)), logs.join('\n'));
	assert.ok(logs.includes('[提示框 confirm] 确定吗？（已确认）'), logs.join('\n'));
	assert.equal((await call({ action: 'snapshot' })).newErrors, 0);

	page = await call({ action: 'click', ref: ref(page, 'link "新窗口"') });
	assert.deepEqual([page.tab, page.tabCount, page.title], [2, 2, '下一页']);
	assert.deepEqual(page.notes, ['页面打开了新标签页，已切换过去']);
	page = await call({ action: 'switch_tab', tab: 1 });
	assert.deepEqual([page.tab, page.title], [1, '已确认']);
	page = await call({ action: 'close_tab', tab: 2 });
	assert.equal(page.tabCount, 1);

	assert.deepEqual((await call({ action: 'evaluate', script: '({ title: document.title, count: document.querySelectorAll("button").length })' })).result, { title: '已确认', count: 2 });
	const shot = await call({ action: 'screenshot' });
	assert.match(shot.image!.image_url, /^resource:[A-HJ-NP-Z2-9]{8}\.png$/);
	assert.ok(existsSync(shot.image!.path));
	assert.ok((tool.format!(shot) as { text: string }).text.includes(`截图 1，文件位于 ${shot.image!.path}`));
	page = await call({ action: 'wait', text: '不会出现', seconds: 0.5 });
	assert.deepEqual(page.notes, ['已等待 0.5 秒，未出现「不会出现」']);

	assert.equal(await tool.execute(context, { action: 'close' }), '已关闭浏览器');
	assert.equal(await tool.execute(context, { action: 'close' }), '浏览器未打开');
	assert.ok(existsSync(join(directory, 'browsers', 'M_A')));
	await browsers.clear('M_A');
	assert.ok(!existsSync(join(directory, 'browsers', 'M_A')));
});

test('浏览器滚动：整页上下滚、列表里滚到底加载更多、横向滚动，写明滚到了哪', async t => {
	const { call, open } = await startBrowser(t, {
		'/': `<title>滚动</title><style>body { margin: 0 } #list { height: 200px; overflow: auto; margin: 0 } #list li { height: 30px }</style>
			<ul id="list" aria-label="消息列表"></ul>
			<div role="region" aria-label="宽表格" style="width: 300px; overflow-x: auto"><div style="width: 1200px">很宽的内容</div></div>
			<div style="height: 3000px">很长的页面</div>
			<script>
				const list = document.getElementById('list');
				const more = () => { const start = list.children.length; for (let i = 1; i <= 20; i++) { const item = document.createElement('li'); item.textContent = '项目 ' + (start + i); list.append(item); } };
				more();
				// 滚到底时再加载 20 条，最多 60 条。
				list.addEventListener('scroll', () => { if (list.scrollTop + list.clientHeight >= list.scrollHeight - 5 && list.children.length < 60) more(); });
			</script>`,
	});
	let page = await open('/');
	if (!page) return;
	assert.match(page.snapshot!, /项目 20/);
	assert.doesNotMatch(page.snapshot!, /项目 21/);

	// 不给 ref 时滚页面正中所在的区域：这里是整个页面。
	page = await call({ action: 'scroll', direction: 'down' });
	assert.match(page.notes![0]!, /^下方还有约 [\d.]+ 屏$/);
	page = await call({ action: 'scroll', direction: 'up', amount: 3 });
	assert.deepEqual(page.notes, ['已到顶部']);
	page = await call({ action: 'scroll', direction: 'up' });
	assert.deepEqual(page.notes, ['未滚动：已位于顶部']);

	// 在列表里滚到底，页面加载更多，直到全部加载完。
	const list = ref(page, 'list "消息列表"');
	const notes: string[] = [];
	for (let i = 0; i < 10 && notes.at(-1) !== '已到底部'; i++) {
		page = await call({ action: 'scroll', ref: list, direction: 'down', amount: 10, element: '消息列表' });
		notes.push(page.notes![0]!);
	}
	assert.equal(notes.at(-1), '已到底部', notes.join('\n'));
	assert.match(notes[0]!, /^下方还有约 [\d.]+ 屏$/);
	assert.match(page.snapshot!, /项目 60/);

	page = await call({ action: 'scroll', ref: ref(page, 'region "宽表格"'), direction: 'right', amount: 5 });
	assert.deepEqual(page.notes, ['已到最右侧']);
	page = await call({ action: 'scroll', ref: ref(page, 'region "宽表格"'), direction: 'down' });
	assert.match(page.notes![0]!, /^下方还有约/, '宽表格不能上下滚动时滚的是外面的页面');
	await assert.rejects(async () => call({ action: 'scroll', direction: 'sideways' }), /direction 只能是/);
});

test('调整页面大小：所有标签页和之后新开的都用新大小，布局和截图跟着变；不给的一边用默认大小；关掉浏览器后恢复默认', async t => {
	const { browsers, call, open } = await startBrowser(t, {
		'/': '<title>首页</title><style>@media (max-width: 600px) { .wide { display: none } } @media (min-width: 601px) { .narrow { display: none } }</style><nav class="wide">电脑菜单</nav><nav class="narrow">手机菜单</nav>',
	});
	const first = await open('/');
	if (!first) return;
	const size = async () => (await call({ action: 'evaluate', script: '[innerWidth, innerHeight]' })).result;
	assert.deepEqual(await size(), [1280, 800]);
	assert.match(first.snapshot!, /电脑菜单/);

	const page = await call({ action: 'resize', width: 390, height: 844 });
	assert.match(page.snapshot!, /手机菜单/);
	assert.doesNotMatch(page.snapshot!, /电脑菜单/);
	assert.deepEqual(await size(), [390, 844]);
	await call({ action: 'open', url: first.url, new_tab: true });
	assert.deepEqual(await size(), [390, 844]);
	const png = readFileSync((await call({ action: 'screenshot' })).image!.path);
	assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [390, 844]);
	await assert.rejects(call({ action: 'resize', width: 100, height: 844 }), /width 必须是 320 到 3840 之间的整数/);
	// 不给的那一边用默认大小。
	await call({ action: 'resize', height: 600 });
	assert.deepEqual(await size(), [1280, 600]);
	await call({ action: 'resize', width: 390, height: 844 });

	await browsers.close('M_A');
	await open('/');
	assert.deepEqual(await size(), [1280, 800]);
});

test('浏览器自己关掉后：其他操作报错写明原因和当时的标签页，restore 恢复标签页和页面大小；成员自己关的不再记着', async t => {
	const { directory, browsers, tool, context, call, open } = await startBrowser(t, {
		'/a': '<title>甲</title><p>甲页</p>',
		'/b': '<title>乙</title><p>乙页</p>',
	}, 1_000);
	const first = await open('/a');
	if (!first) return;
	const base = first.url.replace(/\/a$/, '');
	await call({ action: 'open', url: `${base}/b`, new_tab: true });
	await call({ action: 'resize', width: 800, height: 600 });
	await call({ action: 'switch_tab', tab: 1 });
	for (let waited = 0; browsers.isOpen('M_A') && waited < 5_000; waited += 50) await new Promise(resolve => setTimeout(resolve, 50));
	const tabs = `1. 甲 — ${base}/a（当前）\n2. 乙 — ${base}/b`;
	await assert.rejects(call({ action: 'snapshot' }), { message: `浏览器闲置超过 1 秒，已自动关闭。关闭前打开的标签页：\n${tabs}\n可用 restore 重新打开这些标签页，或用 open 打开网页。` });

	const restored = await call({ action: 'restore' });
	assert.deepEqual([restored.tab, restored.tabCount, restored.title], [1, 2, '甲']);
	assert.match(restored.snapshot!, /甲页/);
	assert.deepEqual((await call({ action: 'evaluate', script: '[innerWidth, innerHeight]' })).result, [800, 600]);
	await assert.rejects(call({ action: 'restore' }), { message: '浏览器已打开，无需恢复' });

	// 运行时重启：记着的标签页留着，原因写运行时重启或意外退出。
	await browsers.shutdown();
	await assert.rejects(call({ action: 'click', ref: 'e1' }), { message: `浏览器已关闭（运行时曾重启或浏览器意外退出）。关闭前打开的标签页：\n${tabs}\n可用 restore 重新打开这些标签页，或用 open 打开网页。` });

	// 关掉后 open：新开的浏览器，不提之前的页面。
	const fresh = await call({ action: 'open', url: `${base}/b` });
	assert.deepEqual([fresh.tabCount, fresh.notes], [1, undefined]);
	assert.equal(await tool.execute(context, { action: 'close' }), '已关闭浏览器');
	await assert.rejects(call({ action: 'snapshot' }), { message: '浏览器尚未打开，请先用 open 打开网页' });
	await assert.rejects(call({ action: 'restore' }), { message: '没有可恢复的标签页' });
	assert.ok(!existsSync(join(directory, 'browsers', 'M_A.json')));
});

test('成员的浏览器：打不开运行时的网页端，页面里也请求不到；发往本机的请求带标记头；数据目录里的文件打不开，点链接打开的换成空白页', async t => {
	let runtimeRequests = 0;
	const runtimeServer = createServer((_, response) => {
		runtimeRequests++;
		response.end('runtime');
	});
	const marks: (string | string[] | undefined)[] = [];
	const site = createServer((request, response) => {
		marks.push(request.headers[MEMBER_BROWSER_HEADER]);
		response.setHeader('Content-Type', 'text/html; charset=utf-8');
		response.end('<title>站点</title><p>本机站点</p>');
	});
	const listen = async (server: ReturnType<typeof createServer>) => {
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		return (server.address() as AddressInfo).port;
	};
	const runtimePort = await listen(runtimeServer);
	const sitePort = await listen(site);
	const data = mkdtempSync(join(tmpdir(), 'reman-browser-'));
	const workspace = join(data, 'workspaces', 'M_A');
	mkdirSync(workspace, { recursive: true });
	writeFileSync(join(data, 'models.json'), '{"apiKey":"secret"}');
	writeFileSync(join(workspace, 'link.html'), `<title>链接</title><a href="${pathToFileURL(join(data, 'models.json')).href}">密钥</a>`);
	const protection = new DataProtection({
		dataDirectory: data, workspacesDirectory: join(data, 'workspaces'), membersDirectory: join(data, 'members'), skillsDirectory: join(data, 'skills'),
		eventRoutesDirectory: join(data, 'event-routes'),
		customToolsDirectory: join(data, 'custom-tools'),
	});
	const browsers = new Browsers(join(data, 'browsers'), undefined, new BrowserBlocklist(undefined, () => runtimePort));
	t.after(async () => {
		await browsers.shutdown();
		runtimeServer.close();
		site.close();
		rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
	});
	const tool = createBrowserTool(browsers, new Resources(join(data, 'resources')), protection);
	const context: IToolContext = { memberId: 'M_A', workingDirectory: workspace, signal: new AbortController().signal };
	const call = async (args: Record<string, unknown>) => await tool.execute(context, args) as IBrowserPage;
	try {
		await call({ action: 'open', url: `http://127.0.0.1:${sitePort}/` });
	} catch (error) {
		if (error instanceof RuntimeError && error.message.startsWith('无法启动浏览器')) return t.skip('电脑上没有 Edge 或 Chrome');
		throw error;
	}
	// 可能还请求了 favicon，每个请求都要带上。
	assert.ok(marks.length > 0 && marks.every(mark => mark === '1'), String(marks));

	assert.equal(await tool.refuseReason!(context, { action: 'open', url: `localhost:${runtimePort}/` }), '不能打开运行时的网页端');
	await assert.rejects(call({ action: 'open', url: `localhost:${runtimePort}/` }), { message: '不能打开运行时的网页端' });
	const fetched = await call({ action: 'evaluate', script: `fetch('http://127.0.0.1:${runtimePort}/v1/state', { mode: 'no-cors' }).then(() => '请求到了', () => '被拦下')` });
	assert.equal(fetched.result, '被拦下');
	assert.equal(runtimeRequests, 0);

	await assert.rejects(call({ action: 'open', url: pathToFileURL(join(data, 'models.json')).href }), /不能打开运行时数据目录中的文件/);
	const page = await call({ action: 'open', url: pathToFileURL(join(workspace, 'link.html')).href });
	await assert.rejects(call({ action: 'click', ref: ref(page, 'link "密钥"') }), /不能打开运行时数据目录中的文件.*已替换为空白页/);
	assert.equal((await call({ action: 'snapshot' })).url, 'about:blank');
});

test('禁止访问的网址：打开前就报错、不开浏览器；点链接、页面里的请求和 WebSocket 都拦下，写明原因；停在禁止的网址上的标签页换成空白页', async t => {
	let blockedHits = 0;
	const blocked = createServer((_, response) => {
		blockedHits++;
		response.setHeader('Content-Type', 'text/html; charset=utf-8');
		response.end('<title>禁止</title><p>不该看到</p>');
	});
	blocked.on('upgrade', (_, socket) => {
		blockedHits++;
		socket.destroy();
	});
	let blockedPort = 0;
	const site = createServer((request, response) => {
		if (request.url === '/redirect') {
			response.writeHead(302, { Location: `http://127.0.0.1:${blockedPort}/` });
			return response.end();
		}
		response.setHeader('Content-Type', 'text/html; charset=utf-8');
		response.end(`<title>站点</title><a href="http://127.0.0.1:${blockedPort}/">去禁止的</a>`);
	});
	const listen = async (server: ReturnType<typeof createServer>) => {
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		return (server.address() as AddressInfo).port;
	};
	blockedPort = await listen(blocked);
	const sitePort = await listen(site);
	const data = mkdtempSync(join(tmpdir(), 'reman-browser-'));
	// 写的是 localhost，本机地址算同一个，127.0.0.1 也禁止。
	const blocklist = new BrowserBlocklist(undefined, () => undefined);
	blocklist.set([`localhost:${blockedPort}`]);
	const browsers = new Browsers(join(data, 'browsers'), undefined, blocklist);
	t.after(async () => {
		await browsers.shutdown();
		blocked.close();
		site.close();
		rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
	});
	const tool = createBrowserTool(browsers, new Resources(join(data, 'resources')));
	const context: IToolContext = { memberId: 'M_A', workingDirectory: data, signal: new AbortController().signal };
	const call = async (args: Record<string, unknown>) => await tool.execute(context, args) as IBrowserPage;
	const reason = `用户禁止访问 localhost:${blockedPort}`;

	assert.equal(await tool.refuseReason!(context, { action: 'open', url: `127.0.0.1:${blockedPort}/a` }), reason);
	assert.equal(await tool.refuseReason!(context, { action: 'click', ref: 'e1' }), undefined);
	await assert.rejects(call({ action: 'open', url: `http://127.0.0.1:${blockedPort}/` }), { message: reason });
	assert.equal(browsers.isOpen('M_A'), false);

	let page: IBrowserPage;
	try {
		page = await call({ action: 'open', url: `http://127.0.0.1:${sitePort}/` });
	} catch (error) {
		if (error instanceof RuntimeError && error.message.startsWith('无法启动浏览器')) return t.skip('电脑上没有 Edge 或 Chrome');
		throw error;
	}
	await assert.rejects(call({ action: 'click', ref: ref(page, 'link "去禁止的"') }), { message: `${reason}，已替换为空白页` });
	assert.equal((await call({ action: 'snapshot' })).url, 'about:blank');

	await call({ action: 'open', url: `http://127.0.0.1:${sitePort}/` });
	const fetched = await call({ action: 'evaluate', script: `fetch('http://127.0.0.1:${blockedPort}/', { mode: 'no-cors' }).then(() => '请求到了', () => '被拦下')` });
	assert.equal(fetched.result, '被拦下');
	const socket = await call({
		action: 'evaluate',
		script: `new Promise(resolve => { const ws = new WebSocket('ws://127.0.0.1:${blockedPort}/'); ws.onclose = event => resolve(event.code); setTimeout(() => resolve('没有关'), 5000); })`,
	});
	assert.equal(socket.result, 1008);
	const logs = (await call({ action: 'console' })).logs ?? [];
	assert.ok(logs.includes(`[已拦截] GET http://127.0.0.1:${blockedPort}/：${reason}`), logs.join('\n'));
	assert.ok(logs.includes(`[已拦截] WebSocket ws://127.0.0.1:${blockedPort}/：${reason}`), logs.join('\n'));
	assert.equal(blockedHits, 0);

	// 重定向拦不到，请求会发出去；去到的页面换成空白页，内容不交给成员。
	await assert.rejects(call({ action: 'open', url: `http://127.0.0.1:${sitePort}/redirect` }), { message: `${reason}，已替换为空白页` });
	assert.equal((await call({ action: 'snapshot' })).url, 'about:blank');

	// 开着的页面刚被禁止：下次操作时换成空白页。
	await call({ action: 'open', url: `http://127.0.0.1:${sitePort}/` });
	blocklist.set([`localhost:${blockedPort}`, `127.0.0.1:${sitePort}`]);
	await assert.rejects(call({ action: 'snapshot' }), { message: `用户禁止访问 127.0.0.1:${sitePort}，已替换为空白页` });
	assert.equal((await call({ action: 'snapshot' })).url, 'about:blank');
});
