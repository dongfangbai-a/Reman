import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { formatLocalTime } from '../common/text.ts';
import type { IModelClient, IModelRequest, IModelResponse } from '../models/client.ts';
import type { Runtime } from '../runtime.ts';
import { RuntimeServer } from '../server/server.ts';
import { addAi, leaveContext, temporaryDirectory, testModels, testRuntime, timelineOf, withoutNumbers } from '../testing.ts';
import { EventLog, type EventLogEntry } from './eventLog.ts';

const SERVER = fileURLToPath(new URL('../mcp/testServer.ts', import.meta.url));
const CHANNEL = { command: process.execPath, args: ['--disable-warning=ExperimentalWarning', SERVER], env: { TEST_CHANNEL: '1' } };

/** 被唤醒的成员运行时不做任何事，只记下请求。 */
class IdleModel implements IModelClient {
	readonly requests: IModelRequest[] = [];

	async respond(request: IModelRequest): Promise<IModelResponse> {
		this.requests.push(request);
		return { output: [], usage: undefined };
	}

	/** 这个成员第一次请求里收到的内容（用户角色的消息）。 */
	received(memberId: string): string[] {
		const request = this.requests.find(item => item.promptCacheKey === `reman-runtime:${memberId}`);
		return withoutNumbers(timelineOf(request?.input ?? [])).map(raw => raw as { role?: string; content?: { text?: string }[] })
			.filter(item => item.role === 'user').map(item => (item.content ?? []).map(part => part.text ?? '').join(''));
	}
}

function setup(t: TestContext, mcp?: object) {
	const directory = temporaryDirectory(t);
	const mcpPath = join(directory, 'mcp.json');
	if (mcp) writeFileSync(mcpPath, JSON.stringify({ mcpServers: mcp }));
	const model = new IdleModel();
	const runtime = testRuntime(t, { ...mcp ? { mcpPath } : {}, models: testModels(), modelClient: model });
	t.after(() => runtime.close());
	mkdirSync(runtime.external.routes.directory, { recursive: true });
	const route = (name: string, code: string) => writeFileSync(join(runtime.external.routes.directory, `${name}.js`), code);
	const call = async (memberId: string, name: string, args: object) =>
		await runtime.tools.call({ memberId, workingDirectory: '.', signal: new AbortController().signal }, name, JSON.stringify(args));
	return { runtime, model, route, call };
}

/** 事件日志里的全部条目。 */
function logEntries(runtime: Runtime): EventLogEntry[] {
	const directory = runtime.external.log.directory;
	return readdirSync(directory).sort().flatMap(file => readFileSync(join(directory, file), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as EventLogEntry));
}

async function waitFor(condition: () => boolean, what: string): Promise<void> {
	const deadline = Date.now() + 30_000;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`一直没有${what}`);
		await new Promise(resolve => setTimeout(resolve, 20));
	}
}

test('外部事件：来源推来的事件交给所有处理这个来源的路由，投给 AI 成员或由真人成员发到群聊；相同的投递合并，出错的路由不影响别的', async t => {
	const { runtime, model, route, call } = setup(t, { feishu: CHANNEL });
	const ai = addAi(runtime, '沈安', { tools: ['mcp:feishu'] });
	const reviewer = addAi(runtime, '林岚');
	const bot = runtime.members.createHuman('飞书');
	const group = runtime.groups.create(bot.memberId, 'CI通知', [ai.memberId, reviewer.memberId]);
	runtime.runs.start();

	route('to-member', `export const sources = ['feishu'];
export default function (event) {
	console.log('发送人', event.meta.sender_name);
	return event.meta.mentioned_bot === 'true' ? { to: '${ai.memberId}' } : null;
}`);
	route('quiet-copy', `export const sources = ['feishu'];
export default (event) => event.meta.mentioned_bot === 'true' ? [{ to: '${ai.memberId}', wake: false }] : null;`);
	route('ci-to-group', `export const sources = ['feishu'];
export default function (event) {
	if (!event.content.includes('CI')) return null;
	return [{ to: '${group.groupId}', from: '${bot.memberId}', mentions: ['${reviewer.memberId}'] }, { to: '${group.groupId}', from: '${ai.memberId}' }];
}`);
	route('broken', `export const sources = ['feishu'];\nexport default function (event) { return { to: ; }`);
	route('github-only', `export const sources = ['github'];\nexport default () => { throw new Error('不该执行'); };`);

	const server = () => runtime.mcp.snapshot().servers[0]!;
	await waitFor(() => server().status === 'connected', '连上来源');
	assert.equal(server().channel, true);
	runtime.tools.setPolicy(ai.memberId, 'mcp:feishu', 'allow');
	const meta = { event_id: 'e1', chat_id: 'oc_1', sender_name: '张三', mentioned_bot: 'true', 'bad-key': 'x', number: 1, title: '第一行\n第二行' };
	const emitted = await call(ai.memberId, 'feishu__emit', { events: [{ content: '@机器人 CI 挂了', meta }, { content: '重复推送', meta }, { meta: { event_id: 'e2' } }] });
	assert.equal(emitted.output, '推送了');
	await waitFor(() => logEntries(runtime).length === 4, '处理完三个推送');

	const [connected, event, duplicate, invalid] = logEntries(runtime);
	assert.deepEqual(connected, { type: 'connected', time: connected!.time, source: 'feishu', error: null });
	assert.equal(event?.type, 'event');
	if (event?.type !== 'event') return;
	// meta 只留键合规、值是文字的，值里的换行换成空格。
	assert.deepEqual(event.meta, { event_id: 'e1', chat_id: 'oc_1', sender_name: '张三', mentioned_bot: 'true', title: '第一行 第二行' });
	assert.deepEqual(event.routes.map(item => [item.route, item.error?.split('\n')[0] ?? null, item.logs]), [
		['broken', "SyntaxError: unexpected token in expression: ';'", []],
		['ci-to-group', null, []],
		['quiet-copy', null, []],
		['to-member', null, ['发送人 张三']],
	]);
	assert.deepEqual(event.deliveries, [
		{ to: group.groupId, from: bot.memberId, mentions: [reviewer.memberId], routes: ['ci-to-group'], error: null },
		{ to: group.groupId, from: ai.memberId, mentions: [], routes: ['ci-to-group'], error: `代发的 沈安(${ai.memberId}) 不是真人成员` },
		{ to: ai.memberId, wake: true, routes: ['quiet-copy', 'to-member'], error: null },
	]);
	assert.deepEqual(duplicate, { type: 'duplicate', time: duplicate!.time, source: 'feishu', event_id: 'e1' });
	assert.deepEqual(invalid, { type: 'invalid', time: invalid!.time, source: 'feishu', error: 'content 须为字符串' });

	// 投给成员：时间线里一条外部事件，唤醒它。投到群聊：真人成员发的消息记下来源和 meta，被点名的成员被唤醒。
	assert.deepEqual(runtime.timeline.all(ai.memberId).filter(item => item.kind === 'external_event').map(item => item.wakes), [true]);
	const [message] = runtime.messages.list(reviewer.memberId, { kind: 'group', groupId: group.groupId });
	assert.deepEqual([message!.senderMemberId, message!.text, message!.external], [bot.memberId, '@机器人 CI 挂了', { source: 'feishu', meta: event.meta }]);

	// 上下文里第一行写来源，接着每个 meta 一行，空一行后是正文；转发的说明行按各自的情况写点名。
	await waitFor(() => model.received(ai.memberId).length > 0 && model.received(reviewer.memberId).length > 0, '唤醒成员');
	const body = 'event_id: e1\nchat_id: oc_1\nsender_name: 张三\nmentioned_bot: true\ntitle: 第一行 第二行\n\n@机器人 CI 挂了';
	const forwarded = `群聊「CI通知」(${group.groupId}) 飞书(${bot.memberId}) 转发外部来源「feishu」`;
	// 前面一条是被拉进群聊。
	assert.deepEqual(model.received(ai.memberId).slice(1), [`${forwarded}，点名了林岚(${reviewer.memberId})：\n${body}`, `外部来源「feishu」：\n${body}`]);
	assert.deepEqual(model.received(reviewer.memberId).slice(1), [`${forwarded}，点名了你：\n${body}`]);
	assert.match(JSON.stringify(model.requests[0]!.input[0]), /# 外部来源的内容/);

	// 查历史连 meta 一起搜。
	leaveContext(runtime, ai.memberId);
	assert.match((await call(ai.memberId, 'search_history', { keywords: ['oc_1'] })).output, /^找到 2 条/);
});

test('外部事件：每个来源每小时最多投递要唤醒成员的 300 次、不唤醒的 3000 次，分开算，满了记警告；投给已删除的成员投不成；路由改了立即生效', async t => {
	const { runtime, route } = setup(t);
	const ai = addAi(runtime, '沈安');
	const gone = addAi(runtime, '林岚');
	runtime.memberFolders.remove(gone.memberId);
	// 暂停的成员不运行，投递照收，也照样算次数。
	runtime.runs.pause(ai.memberId);
	const bot = runtime.members.createHuman('飞书');
	const group = runtime.groups.create(bot.memberId, '讨论', [ai.memberId]);
	route('all', `export const sources = ['feishu'];
export default (event) => event.meta.group
	? { to: '${group.groupId}', from: '${bot.memberId}', mentions: event.meta.group === 'mention' ? ['${ai.memberId}'] : [] }
	: { to: '${ai.memberId}', wake: event.meta.wake === 'true' };`);
	for (let index = 1; index <= 301; index++) runtime.external.event('feishu', { content: `唤醒 ${index}`, meta: { wake: 'true' } });
	// 投到群聊：没有点名、没人关注这个群时不唤醒，不占要唤醒的次数。
	runtime.external.event('feishu', { content: '群里没点名', meta: { group: 'quiet' } });
	runtime.external.event('feishu', { content: '群里点名', meta: { group: 'mention' } });
	for (let index = 2; index <= 3001; index++) runtime.external.event('feishu', { content: `不唤醒 ${index}` });
	runtime.external.event('github', { content: '别的来源不受影响' });
	await runtime.external.idle();
	const events = logEntries(runtime).filter(entry => entry.type === 'event');
	const errors = (content: string) => events.find(entry => entry.content === content)!.deliveries.map(delivery => delivery.error);
	assert.deepEqual(errors('唤醒 300'), [null]);
	assert.deepEqual(errors('唤醒 301'), ['来源「feishu」一小时内唤醒成员的投递已达 300 次上限，本次不投递']);
	assert.deepEqual(errors('群里没点名'), [null]);
	assert.deepEqual(errors('群里点名'), ['来源「feishu」一小时内唤醒成员的投递已达 300 次上限，本次不投递']);
	assert.deepEqual(errors('不唤醒 3000'), [null]);
	assert.deepEqual(errors('不唤醒 3001'), ['来源「feishu」一小时内不唤醒成员的投递已达 3000 次上限，本次不投递']);
	assert.deepEqual(events.at(-1)!.routes, []);
	assert.equal(runtime.timeline.all(ai.memberId).filter(item => item.kind === 'external_event').length, 300 + 2999);
	// 同样的警告 10 分钟内只记一次。
	assert.deepEqual(logEntries(runtime).flatMap(entry => entry.type === 'warning' ? [[entry.source, entry.text]] : []), [
		['feishu', '一小时内唤醒成员的投递已达 300 次上限，此后的投递暂停'],
		['feishu', '一小时内不唤醒成员的投递已达 3000 次上限，此后的投递暂停'],
	]);

	route('all', `export const sources = ['github'];\nexport default () => [{ to: '${gone.memberId}' }, { to: 'M_NOTEXIST' }, { to: '${ai.memberId}', text: '改写过的文字', wake: false }];`);
	runtime.external.event('github', { content: '新路由', meta: { repo: 'a/b' } });
	await runtime.external.idle();
	assert.deepEqual(logEntries(runtime).at(-1)!.type === 'event' && logEntries(runtime).at(-1), {
		type: 'event', source: 'github', content: '新路由', meta: { repo: 'a/b' }, time: logEntries(runtime).at(-1)!.time,
		routes: [{ route: 'all', error: null, logs: [] }],
		deliveries: [
			{ to: gone.memberId, wake: true, routes: ['all'], error: `林岚(${gone.memberId}) 已删除` },
			{ to: 'M_NOTEXIST', wake: true, routes: ['all'], error: '成员 M_NOTEXIST 不存在' },
			{ to: ai.memberId, text: '改写过的文字', wake: false, routes: ['all'], error: null },
		],
	});
	const last = runtime.timeline.all(ai.memberId).at(-1)!;
	assert.deepEqual(last.kind === 'external_event' && last.external, { source: 'github', meta: { repo: 'a/b' }, text: '改写过的文字' });
});

test('test_event_route：用日志里最近的、路由处理的来源的事件试跑，新的在前，不真的投递', async t => {
	const { runtime, route, call } = setup(t);
	const ai = addAi(runtime, '沈安', { tools: ['test_event_route'] });
	const bot = runtime.members.createHuman('GitHub');
	const group = runtime.groups.create(bot.memberId, 'CI通知', [ai.memberId]);
	runtime.external.event('github', { content: 'CI 失败', meta: { type: 'CheckSuite', conclusion: 'failure' } });
	runtime.external.event('feishu', { content: '群消息' });
	runtime.external.event('github', { content: '新评论', meta: { type: 'Issue' } });
	await runtime.external.idle();
	route('ci', `export const sources = ['github'];
export default function (event) {
	console.log(event.meta.type);
	return event.meta.conclusion === 'failure' ? { to: '${ai.memberId}' } : null;
}`);

	const saved = await call(ai.memberId, 'test_event_route', { route: 'ci' });
	const times = logEntries(runtime).filter(entry => entry.type === 'event').map(entry => entry.time);
	assert.equal(saved.output, [
		`[${times[2]}] github：新评论\n不投递\nconsole 输出：\nIssue`,
		`[${times[0]}] github：CI 失败\n- 投递给 沈安(${ai.memberId})，唤醒\nconsole 输出：\nCheckSuite`,
	].join('\n\n'));
	assert.equal(runtime.timeline.all(ai.memberId).some(item => item.kind === 'external_event'), false);

	const draft = `export const sources = ['github', 'feishu'];
export default (event) => event.source === 'feishu' ? { to: '${group.groupId}', from: '${ai.memberId}', text: '转发：' + event.content, mentions: 'all' } : null;`;
	assert.equal((await call(ai.memberId, 'test_event_route', { code: draft, limit: 2 })).output, [
		`[${times[2]}] github：新评论\n不投递`,
		`[${times[1]}] feishu：群消息\n- 由 沈安(${ai.memberId}) 转发到群聊「CI通知」(${group.groupId})，点名所有人，文字：转发：群消息；无法投递：代发的 沈安(${ai.memberId}) 不是真人成员`,
	].join('\n\n'));
	assert.equal((await call(ai.memberId, 'test_event_route', { code: draft, source: 'gitlab' })).output, '事件日志中尚无该路由所处理来源的事件');

	const failed = await call(ai.memberId, 'test_event_route', { code: 'export default () => null;' });
	assert.deepEqual([failed.isError, failed.output], [true, "路由有误：须导出 sources，写明要处理的事件来源，如 export const sources = ['github']"]);
	assert.match((await call(ai.memberId, 'test_event_route', { route: 'ci', code: draft })).output, /route 和 code 须提供其中一个/);
	assert.match((await call(ai.memberId, 'test_event_route', { route: 'missing' })).output, /不存在路由 missing/);
	const thrown = await call(ai.memberId, 'test_event_route', { code: "export const sources = ['github'];\nexport default (event) => event.meta.x.y;", limit: 1 });
	assert.equal(thrown.output, `[${times[2]}] github：新评论\n执行出错：TypeError: cannot read property 'y' of undefined\n  at default (route.js:2:39)`);
});

test('MCP 服务器停用：不启动、不收事件，工具用不了；启用后连上', async t => {
	const { runtime, call } = setup(t, { feishu: { ...CHANNEL, disabled: true } });
	const ai = addAi(runtime, '沈安', { tools: ['mcp:feishu'] });
	const server = () => runtime.mcp.snapshot().servers[0]!;
	assert.deepEqual([server().status, server().channel], ['disabled', false]);
	assert.throws(() => runtime.mcp.reconnect('feishu'), /已停用/);

	runtime.mcp.setDisabled('feishu', false);
	await waitFor(() => server().status === 'connected', '连上来源');
	assert.equal(server().channel, true);
	assert.equal(readFileSync(runtime.mcp.path!, 'utf8').includes('disabled'), false);
	assert.deepEqual(logEntries(runtime).map(entry => entry.type), ['connected']);

	runtime.mcp.setDisabled('feishu', true);
	assert.equal(server().status, 'disabled');
	assert.match(readFileSync(runtime.mcp.path!, 'utf8'), /"disabled": true/);
	runtime.tools.setPolicy(ai.memberId, 'mcp:feishu', 'allow');
	assert.match((await call(ai.memberId, 'feishu__emit', { events: [] })).output, /不存在工具 feishu__emit/);
});

test('来源断了自己重连，不用等调用；普通服务器断了等下次调用', async t => {
	const plain = { command: CHANNEL.command, args: CHANNEL.args };
	const { runtime, call } = setup(t, { feishu: CHANNEL, plain });
	const ai = addAi(runtime, '沈安', { tools: ['mcp:feishu', 'mcp:plain'] });
	runtime.tools.setPolicy(ai.memberId, 'mcp:feishu', 'allow');
	const status = (name: string) => runtime.mcp.snapshot().servers.find(server => server.name === name)!.status;
	await waitFor(() => status('feishu') === 'connected' && status('plain') === 'connected', '都连上');

	await call(ai.memberId, 'feishu__exit', {});
	await waitFor(() => status('feishu') === 'failed', '来源断开');
	await waitFor(() => status('feishu') === 'connected', '来源自己重连上');
	assert.deepEqual(logEntries(runtime).map(entry => entry.type), ['connected', 'disconnected', 'connected']);

	runtime.tools.setPolicy(ai.memberId, 'mcp:plain', 'allow');
	await call(ai.memberId, 'plain__exit', {}).catch(() => undefined);
	await waitFor(() => status('plain') === 'failed', '普通服务器断开');
	await new Promise(resolve => setTimeout(resolve, 6000));
	assert.equal(status('plain'), 'failed');
});

test('来源的警告：连上以后写到 stderr 的每一行记进事件日志，同样的只记一次，每小时最多 30 条；来源列表显示最近一条，重新连上后清掉', async t => {
	const { runtime, call } = setup(t, { feishu: CHANNEL });
	const ai = addAi(runtime, '沈安', { tools: ['mcp:feishu'] });
	const server = () => runtime.mcp.snapshot().servers[0]!;
	await waitFor(() => server().status === 'connected', '连上来源');
	runtime.tools.setPolicy(ai.memberId, 'mcp:feishu', 'allow');
	const warnings = () => logEntries(runtime).flatMap(entry => entry.type === 'warning' ? [entry.text] : []);
	const latest = async () => (await runtime.external.overview(runtime.mcp.snapshot().servers)).sources[0]!.warning;

	// 测试服务器启动时写的「测试服务器启动了」在连上之前，不算。一行分两段写也是一条；空行不记。
	await call(ai.memberId, 'feishu__stderr', { text: '查名字失败：缺权限\n\n取不到' });
	await call(ai.memberId, 'feishu__stderr', { text: '详情\n查名字失败：缺权限\n' });
	await waitFor(() => warnings().length === 2, '记下警告');
	assert.deepEqual(warnings(), ['查名字失败：缺权限', '取不到详情']);
	assert.equal((await latest())?.text, '取不到详情');

	// 每小时最多 30 条，超出时记一行说明，后面的不记。
	await call(ai.memberId, 'feishu__stderr', { text: Array.from({ length: 40 }, (_, index) => `警告 ${index}\n`).join('') });
	await waitFor(() => warnings().length === 31, '记满一小时的警告');
	await new Promise(resolve => setTimeout(resolve, 200));
	assert.deepEqual([warnings().length, warnings().at(-2), warnings().at(-1)], [31, '警告 27', '一小时内的警告已超过 30 条，此后的警告暂不记录']);

	// 重新连上后来源列表不再显示以前的警告。
	runtime.mcp.reconnect('feishu');
	await waitFor(() => logEntries(runtime).filter(entry => entry.type === 'connected').length === 2, '重新连上');
	assert.equal(await latest(), null);
	assert.equal(warnings().length, 31);
});

test('外部事件接口：来源和路由一起看，写错的来源名、不推事件的服务器标出来；事件日志按天倒序分页；停用开关', async t => {
	const plain = { command: CHANNEL.command, args: CHANNEL.args };
	const { runtime, route } = setup(t, { feishu: { ...CHANNEL, disabled: true }, plain });
	const server = new RuntimeServer(runtime, 'secret');
	const port = await server.listen();
	t.after(() => server.close());
	const call = async (method: string, path: string, body?: object): Promise<any> => (await fetch(`http://127.0.0.1:${port}${path}`, {
		method, headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' }, body: body && JSON.stringify(body),
	})).json();
	let changes = 0;
	runtime.events.subscribe(({ event }) => {
		if (event.type === 'external.changed') changes++;
	});
	route('a', `export const sources = ['feishu', 'nowhere'];\nexport default (event) => (console.log(event.content), null);`);
	route('b', 'export default function (');
	route('c', `export const sources = ['plain'];\nexport default () => null;`);
	await waitFor(() => runtime.mcp.snapshot().servers.find(item => item.name === 'plain')?.status === 'connected', '连上 plain');

	const overview = await call('GET', '/v1/external');
	assert.equal(overview.routesDirectory, runtime.external.routes.directory);
	assert.deepEqual(overview.sources, [
		{ name: 'feishu', status: 'disabled', error: null, warning: null },
		{ name: 'nowhere', status: 'missing', error: null, warning: null },
		{ name: 'plain', status: 'not_channel', error: null, warning: null },
	]);
	assert.deepEqual(overview.routes.map((item: any) => [item.name, item.sources, item.problem?.split(':')[0] ?? null, item.lastRun]), [
		['a', ['feishu', 'nowhere'], null, null],
		['b', [], 'SyntaxError', null],
		['c', ['plain'], null, null],
	]);

	// 启用来源；处理过事件后有最近一次执行的结果。
	assert.equal((await call('PUT', '/v1/mcp/servers/feishu/disabled', { disabled: false })).servers[0].status, 'connecting');
	assert.match((await call('PUT', '/v1/mcp/servers/feishu/disabled', { disabled: 'no' })).error.message, /disabled 必须是 true 或 false/);
	await waitFor(() => runtime.mcp.snapshot().servers[0]!.status === 'connected', '连上 feishu');
	for (const content of ['一', '二', '三']) runtime.external.event('feishu', { content });
	runtime.external.event('other', { content: '别的来源' });
	await runtime.external.idle();
	const after = await call('GET', '/v1/external');
	assert.deepEqual(after.sources[0], { name: 'feishu', status: 'connected', error: null, warning: null });
	assert.deepEqual(after.routes[0].lastRun, { time: logEntries(runtime).at(-2)!.time, error: null });
	await waitFor(() => changes > 0, '通知网页端');

	// 日志：新的在前，带字节位置；before 往前翻；只看某个来源。
	const page = await call('GET', '/v1/external/log?limit=2');
	assert.deepEqual([page.dates.length, page.entries.map((entry: any) => [entry.type, entry.content]), page.more], [1, [['event', '别的来源'], ['event', '三']], true]);
	const older = await call('GET', `/v1/external/log?limit=2&before=${page.entries[1].offset}&source=feishu`);
	assert.deepEqual([older.entries.map((entry: any) => entry.content ?? entry.type), older.more], [['二', '一'], true]);
	assert.deepEqual((await call('GET', `/v1/external/log?before=${older.entries[1].offset}&source=feishu`)).entries.map((entry: any) => entry.type), ['connected']);
	assert.deepEqual((await call('GET', '/v1/external/log?date=2020-01-01')).entries, []);
	assert.match((await call('GET', '/v1/external/log?date=1月1日')).error.message, /YYYY-MM-DD/);
});

test('事件日志里缺了路由结果、投递的事件按空的算，照样能看、能拿来试跑', t => {
	const directory = temporaryDirectory(t);
	const event = { source: 'github', content: '手改过的', meta: {}, time: formatLocalTime(Date.now()) };
	writeFileSync(join(directory, `${event.time.slice(0, 10)}.jsonl`), [
		JSON.stringify({ type: 'event', ...event }),
		JSON.stringify({ type: 'event', ...event, content: '投递缺了路由', routes: [{ route: 'ci', error: '出错了', logs: [] }], deliveries: [{ to: 'M_1', error: null }] }),
		'',
	].join('\n'));
	const log = new EventLog(directory);
	t.after(() => log.close());
	assert.deepEqual(log.page({ limit: 10 }).entries.map(entry => entry.type === 'event' ? [entry.content, entry.routes.length, entry.deliveries.map(delivery => delivery.routes)] : []), [
		['投递缺了路由', 1, [[]]],
		['手改过的', 0, []],
	]);
	assert.deepEqual([...log.recentRouteRuns(['ci'], 10)], [['ci', { time: event.time, error: '出错了' }]]);
	assert.deepEqual(log.recentEvents(10).map(item => item.content), ['投递缺了路由', '手改过的']);
});

test('事件日志从文件末尾往前读：跨过读取的块时中文不断开，按位置翻页拿到全部；路由最近的结果只在最近的事件里找', t => {
	const directory = temporaryDirectory(t);
	const time = formatLocalTime(Date.now());
	const contents = Array.from({ length: 3000 }, (_, index) => `第 ${index} 条，中文内容`);
	writeFileSync(join(directory, `${time.slice(0, 10)}.jsonl`), contents.map((content, index) => JSON.stringify({
		type: 'event', source: 'github', content, meta: {}, time, routes: [{ route: index === 0 ? 'old' : 'ci', error: null, logs: [] }], deliveries: [],
	})).join('\n') + '\n');
	const log = new EventLog(directory);
	t.after(() => log.close());
	const read: string[] = [];
	let before: number | undefined;
	for (let more = true; more;) {
		const page = log.page({ limit: 500, before });
		read.push(...page.entries.map(entry => entry.type === 'event' ? entry.content : ''));
		before = page.entries.at(-1)?.offset;
		more = page.more;
	}
	assert.deepEqual(read, contents.toReversed());
	assert.deepEqual([...log.recentRouteRuns(['ci', 'old'], 100).keys()], ['ci']);
	assert.deepEqual([...log.recentRouteRuns(['ci', 'old'], 5000).keys()], ['ci', 'old']);
});
