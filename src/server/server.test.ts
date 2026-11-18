import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request, type IncomingMessage } from 'node:http';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { Describer } from '../runs/describe.ts';
import type { IMemberActivity } from '../runs/runs.ts';
import { addAi, temporaryDirectory, testModels, testRuntime } from '../testing.ts';
import { RuntimeServer } from './server.ts';

test('客户端中途断开（手机退到后台、隧道重置）不算运行时的错，之后照旧能服务', async t => {
	const runtime = testRuntime(t);
	const server = new RuntimeServer(runtime, 'secret');
	const port = await server.listen();
	t.after(async () => {
		await server.close();
		await runtime.close();
	});

	// 请求头写完、body 只发一半就掐掉：Node 会抛 ECONNRESET / aborted。
	await new Promise<void>(resolve => {
		const socket = connect(port, '127.0.0.1', () => {
			socket.write('POST /v1/members HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer secret\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"type":');
			setTimeout(() => {
				socket.destroy();
				resolve();
			}, 100);
		});
		socket.on('error', () => {});
	});
	// SSE 也一样：连上就断。
	await new Promise<void>(resolve => {
		const socket = connect(port, '127.0.0.1', () => {
			socket.write('GET /v1/events HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer secret\r\n\r\n');
			setTimeout(() => {
				socket.destroy();
				resolve();
			}, 100);
		});
		socket.on('error', () => {});
	});

	// 断开之后运行时照旧服务（上面的错误如果变成了未捕获异常，这里会挂）。
	const state = await fetch(`http://127.0.0.1:${port}/v1/state`, { headers: { Authorization: 'Bearer secret' } });
	assert.equal(state.status, 200);
});

test('用量接口：没有请求时是零，按成员过滤，成员不存在、参数不是整数要报错', async t => {
	const runtime = testRuntime(t);
	const server = new RuntimeServer(runtime, 'secret');
	const base = `http://127.0.0.1:${await server.listen()}`;
	t.after(async () => {
		await server.close();
		await runtime.close();
	});
	const call = (query: string) => fetch(`${base}/v1/usage${query}`, { headers: { Authorization: 'Bearer secret' } });

	const empty = await call('');
	assert.equal(empty.status, 200);
	assert.deepEqual(await empty.json(), { usage: { requests: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, failedRequests: 0, since: null, until: null, groups: [] } });

	const human = runtime.members.createHuman('张三');
	assert.equal((await call(`?memberId=${human.memberId}`)).status, 200);
	assert.equal((await call(`?memberId=${human.memberId}&since=1000&until=2000`)).status, 200);
	assert.equal((await call('?memberId=M_NOPE')).status, 404);
	assert.equal((await call('?since=昨天')).status, 400);
	assert.equal((await call('?groupBy=member')).status, 200);
	assert.equal((await call('?groupBy=day')).status, 400);

	const window = await (await call('?since=1000&until=2000')).json() as { usage: { since: number; until: number } };
	assert.deepEqual([window.usage.since, window.usage.until], [1000, 2000]);
});

test('网页端：静态文件不要认证，令牌换 Cookie 后靠 Cookie 访问接口，Cookie 认证的修改请求要同源', async t => {
	const web = join(temporaryDirectory(t), 'dist');
	mkdirSync(join(web, 'assets'), { recursive: true });
	writeFileSync(join(web, 'index.html'), '<html>首页</html>');
	writeFileSync(join(web, 'assets', 'app.js'), 'console.log(1)');
	const runtime = testRuntime(t);
	const server = new RuntimeServer(runtime, 'secret', web);
	const base = `http://127.0.0.1:${await server.listen()}`;
	t.after(async () => {
		await server.close();
		await runtime.close();
	});

	assert.equal(await (await fetch(`${base}/chat/group/G_1`)).text(), '<html>首页</html>');
	assert.equal((await fetch(`${base}/assets/app.js`)).headers.get('content-type'), 'text/javascript; charset=utf-8');
	assert.equal((await fetch(`${base}/v1/members`)).status, 401);

	const session = await fetch(`${base}/v1/session`, { method: 'POST', headers: { Authorization: 'Bearer secret' } });
	const cookie = session.headers.get('set-cookie')!.split(';')[0]!;
	assert.match(session.headers.get('set-cookie')!, /HttpOnly; SameSite=Strict/);
	assert.equal((await fetch(`${base}/v1/members`, { headers: { Cookie: cookie } })).status, 200);

	const create = (origin: string) => fetch(`${base}/v1/members`, {
		method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'human', name: '张三' }),
	});
	assert.equal((await create('http://evil.example')).status, 403);
	assert.equal((await create(base)).status, 200);

	// 成员浏览器发来的（带标记头，包括经过开发服务器转发的）、用别的域名解析到本机来访问的，一律拒绝，静态文件也一样。
	assert.equal(runtime.serverPort, Number(new URL(base).port));
	const get = (headers: Record<string, string>) => new Promise<number>((resolve, reject) => {
		request(`${base}/v1/members`, { headers: { Authorization: 'Bearer secret', ...headers } }, response => {
			response.resume();
			resolve(response.statusCode!);
		}).on('error', reject).end();
	});
	assert.equal(await get({}), 200);
	assert.equal(await get({ Host: `localhost:5173` }), 200);
	assert.equal(await get({ 'X-Reman-Member-Browser': '1' }), 403);
	assert.equal(await get({ Host: `127.0.0.1.nip.io:${new URL(base).port}` }), 403);
	assert.equal((await fetch(`${base}/`, { headers: { 'X-Reman-Member-Browser': '1' } })).status, 403);
});

test('时间线接口往前翻页，消息条目带内容；成员状态一次查全部', async t => {
	const runtime = testRuntime(t);
	const server = new RuntimeServer(runtime, 'secret');
	const base = `http://127.0.0.1:${await server.listen()}`;
	t.after(async () => {
		await server.close();
		await runtime.close();
	});
	const human = runtime.members.createHuman('张三');
	const ai = addAi(runtime, '沈安', { directMessage: 'all' });
	for (const text of ['一', '二', '三']) runtime.messages.send(human.memberId, { kind: 'direct', memberId: ai.memberId }, text);
	const get = async (path: string): Promise<any> => (await fetch(`${base}${path}`, { headers: { Authorization: 'Bearer secret' } })).json();

	const latest = await get(`/v1/members/${ai.memberId}/timeline?before=${Number.MAX_SAFE_INTEGER}&limit=2`);
	assert.deepEqual(latest.items.map((item: { message: { text: string } }) => item.message.text), ['二', '三']);
	const older = await get(`/v1/members/${ai.memberId}/timeline?before=${latest.items[0].itemId}`);
	assert.deepEqual(older.items.map((item: { message: { text: string } }) => item.message.text), ['一']);
	// 收到的内容带着时间时有 time，不带时没有这一项。
	assert.deepEqual(Object.keys(older.items[0].time).sort(), ['at', 'full', 'text', 'timeZone']);
	assert.equal(older.items[0].time.full, true);
	assert.deepEqual(latest.items.map((item: object) => 'time' in item), [false, false]);
	assert.deepEqual((await get('/v1/member-states')).states, [{ memberId: ai.memberId, status: 'idle', error: null, activity: null }]);
});

test('「还有没有活」的接口：空闲的成员是 settled，成员不存在 404，参数不合法 400', async t => {
	const runtime = testRuntime(t);
	const server = new RuntimeServer(runtime, 'secret');
	const base = `http://127.0.0.1:${await server.listen()}`;
	t.after(async () => {
		await server.close();
		await runtime.close();
	});
	const ai = addAi(runtime, '沈安');
	const request = async (path: string) => {
		const response = await fetch(`${base}${path}`, { headers: { Authorization: 'Bearer secret' } });
		return { status: response.status, body: await response.json() as any };
	};

	const idle = await request(`/v1/members/${ai.memberId}/work`);
	assert.equal(idle.status, 200);
	assert.deepEqual([idle.body.work.settled, idle.body.work.busy, idle.body.work.status], [true, false, 'idle']);
	// 长轮询：已经停下来的，立刻返回。
	const waited = await request(`/v1/members/${ai.memberId}/work/wait?quietMs=100&timeoutMs=5000`);
	assert.equal(waited.body.work.settled, true);
	assert.equal((await request('/v1/members/M_NOPE0/work')).status, 404);
	assert.equal((await request(`/v1/members/${ai.memberId}/work?quietMs=abc`)).status, 400);
});

test('事件流重连时从 Last-Event-ID 接着补发，地址里旧的 after 不算', async t => {
	const runtime = testRuntime(t);
	const server = new RuntimeServer(runtime, 'secret');
	const base = `http://127.0.0.1:${await server.listen()}`;
	const abort = new AbortController();
	t.after(async () => {
		abort.abort();
		await server.close();
		await runtime.close();
	});
	for (let index = 0; index < 3; index++) runtime.events.emit({ type: 'memberSections.changed' });
	const { epoch } = runtime.events;
	const response = await fetch(`${base}/v1/events?after=${epoch}:1`, {
		headers: { Authorization: 'Bearer secret', 'Last-Event-ID': `${epoch}:2` }, signal: abort.signal,
	});
	const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
	let received = '';
	while (!received.includes(`id: ${epoch}:3\n`)) received += (await reader.read()).value ?? '';
	assert.ok(!received.includes(`id: ${epoch}:2\n`));
});

test('事件流连上时先发成员现在在做的事和流式输出到目前为止的内容；重试从头算，运行结束就不再发', async t => {
	const runtime = testRuntime(t);
	const server = new RuntimeServer(runtime, 'secret');
	const base = `http://127.0.0.1:${await server.listen()}`;
	const abort = new AbortController();
	t.after(async () => {
		abort.abort();
		await server.close();
		await runtime.close();
	});
	const events = runtime.events;
	const activity = { phase: 'requesting', since: 1 } as unknown as IMemberActivity;
	const delta = (attempt: number, kind: 'text' | 'reasoning', text: string) => events.delta({ type: 'run.delta', memberId: 'M_A', runId: 1, requestId: 5, attempt, kind, delta: text });
	events.delta({ type: 'member.activity', memberId: 'M_A', activity });
	delta(1, 'text', '旧的');
	delta(2, 'reasoning', '先想');
	delta(2, 'reasoning', '一想');
	delta(2, 'text', '答');
	assert.deepEqual(events.current(), [
		{ type: 'member.activity', memberId: 'M_A', activity },
		{ type: 'run.delta', memberId: 'M_A', runId: 1, requestId: 5, attempt: 2, kind: 'reasoning', delta: '先想一想' },
		{ type: 'run.delta', memberId: 'M_A', runId: 1, requestId: 5, attempt: 2, kind: 'text', delta: '答' },
	]);

	const response = await fetch(`${base}/v1/events`, { headers: { Authorization: 'Bearer secret' }, signal: abort.signal });
	const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
	let received = '';
	while (!received.includes('"delta":"答"')) received += (await reader.read()).value ?? '';
	assert.ok(received.indexOf('event: member.activity') < received.indexOf('"delta":"先想一想"'));

	events.delta({ type: 'member.activity', memberId: 'M_A', activity: null });
	assert.deepEqual(events.current(), []);
});

test('事件流：空闲时连上也马上收到响应头；不读的连接积压超过上限就断开', async t => {
	const runtime = testRuntime(t);
	const server = new RuntimeServer(runtime, 'secret', undefined, 64 * 1024);
	const port = await server.listen();
	const abort = new AbortController();
	t.after(async () => {
		abort.abort();
		await server.close();
		await runtime.close();
	});
	const started = Date.now();
	await fetch(`http://127.0.0.1:${port}/v1/events`, { headers: { Authorization: 'Bearer secret' }, signal: abort.signal });
	assert.ok(Date.now() - started < 5000);

	// 收到响应头后先不读，攒够了再接着读：读完已经发出来的就结束，说明运行时断开了。
	const response = await new Promise<IncomingMessage>(resolve => {
		const stuck = request({ host: '127.0.0.1', port, path: '/v1/events', headers: { Authorization: 'Bearer secret' } }, resolve);
		stuck.end();
	});
	response.pause();
	const chunk = '字'.repeat(10_000);
	for (let index = 0; index < 1000; index++) {
		runtime.events.delta({ type: 'run.delta', memberId: 'M_A', runId: 1, requestId: 1, attempt: 1, kind: 'text', delta: chunk });
		await new Promise(resolve => setImmediate(resolve));
	}
	const ended = new Promise(resolve => response.on('close', resolve));
	response.resume();
	await ended;
});

test('真人的备注可以设置和清空，太长或换行时报错；AI 成员的备注不走这个接口', async t => {
	const runtime = testRuntime(t);
	const server = new RuntimeServer(runtime, 'secret');
	const base = `http://127.0.0.1:${await server.listen()}`;
	t.after(async () => {
		await server.close();
		await runtime.close();
	});
	const human = runtime.members.createHuman('张三');
	const ai = addAi(runtime, '沈安');
	const put = async (memberId: string, description: string): Promise<any> => (await fetch(`${base}/v1/members/${memberId}/description`, {
		method: 'PUT', headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' }, body: JSON.stringify({ description }),
	})).json();

	assert.equal((await put(human.memberId, ' 产品经理 ')).member.description, '产品经理');
	assert.equal(runtime.members.get(human.memberId)!.description, '产品经理');
	assert.equal((await put(human.memberId, '')).member.description, '');
	assert.match((await put(human.memberId, '一\n二')).error.message, /备注不能换行/);
	assert.match((await put(human.memberId, '长'.repeat(31))).error.message, /备注过长/);
	assert.match((await put(ai.memberId, '测试工程师')).error.message, /成员文件中修改/);
});

test('记忆接口：读写 AI 成员的 memory.md，写入时整理空行和首尾空白，清空时删掉文件；真人没有记忆', async t => {
	const runtime = testRuntime(t);
	const server = new RuntimeServer(runtime, 'secret');
	const base = `http://127.0.0.1:${await server.listen()}`;
	t.after(async () => {
		await server.close();
		await runtime.close();
	});
	const human = runtime.members.createHuman('张三');
	const ai = addAi(runtime, '沈安');
	const call = async (method: string, memberId: string, body?: object): Promise<any> => (await fetch(`${base}/v1/members/${memberId}/memory`, {
		method, headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' }, body: body && JSON.stringify(body),
	})).json();
	const file = join(runtime.memberFolders.snapshot().folders.find(folder => folder.memberId === ai.memberId)!.path, 'memory.md');

	assert.deepEqual(await call('GET', ai.memberId), { memory: '', limit: 3000 });
	assert.deepEqual(await call('PUT', ai.memberId, { memory: '\n张三喜欢周五开会\r\n\r\n\r\n下周出差\n' }), { memory: '张三喜欢周五开会\n\n下周出差', limit: 3000 });
	assert.equal(readFileSync(file, 'utf8'), '张三喜欢周五开会\n\n下周出差\n');
	assert.deepEqual(await call('PUT', ai.memberId, { memory: '  ' }), { memory: '', limit: 3000 });
	assert.ok(!existsSync(file));
	assert.ok((await call('GET', human.memberId)).error);
});

test('只改成员文件里的模型和思考强度，其他字段原样保留；null 表示默认；有误时报错不改', async t => {
	const runtime = testRuntime(t, { models: testModels([{ model: 'fake' }, { model: 'other' }]) });
	const server = new RuntimeServer(runtime, 'secret');
	const base = `http://127.0.0.1:${await server.listen()}`;
	t.after(async () => {
		await server.close();
		await runtime.close();
	});
	const ai = addAi(runtime, '沈安', { description: '前端' });
	const put = async (body: object): Promise<any> => (await fetch(`${base}/v1/members/${ai.memberId}/model`, {
		method: 'PUT', headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
	})).json();
	const file = () => JSON.parse(readFileSync(join(runtime.memberFolders.directory, '沈安', 'member.json'), 'utf8'));

	const { member } = await put({ model: { provider: 'test', name: 'other' }, reasoning: 'high' });
	assert.deepEqual([member.model, member.reasoningEffort], [{ provider: 'test', model: 'other' }, 'high']);
	assert.deepEqual(file(), { description: '前端', model: { provider: 'test', name: 'other' }, reasoning: 'high' });

	await put({ model: null, reasoning: null });
	assert.deepEqual(file(), { description: '前端' });
	assert.match((await put({ model: null })).error.message, /须提供 model 和 reasoning/);
	assert.match((await put({ model: null, reasoning: '随便' })).error.message, /reasoning 只能是/);
	assert.match((await put({ model: { provider: 'test', name: '没有' }, reasoning: null })).error.message, /未添加模型/);
	assert.deepEqual(file(), { description: '前端' });
});

test('关注是成员的设置：不需要请求者，可以改任何 AI 成员的，改了记进它的时间线；它自己用工具改的不记；真人和不在群里的成员不能设置', async t => {
	const runtime = testRuntime(t);
	const server = new RuntimeServer(runtime, 'secret');
	const base = `http://127.0.0.1:${await server.listen()}`;
	t.after(async () => {
		await server.close();
		await runtime.close();
	});
	const human = runtime.members.createHuman('张三');
	const host = addAi(runtime, '安和');
	const player = addAi(runtime, '北辰', { tools: ['manage_group'] });
	const outsider = addAi(runtime, '星河');
	const group = runtime.groups.create(host.memberId, '大群', [player.memberId, human.memberId]);
	const put = async (memberId: string, watching: boolean): Promise<any> => (await fetch(`${base}/v1/groups/${group.groupId}/members/${memberId}/watching`, {
		method: 'PUT', headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' }, body: JSON.stringify({ watching }),
	})).json();
	const describer = new Describer(runtime.members, runtime.groups);
	const watchEvents = () => runtime.timeline.all(player.memberId).flatMap(item =>
		item.kind === 'group_event' && (item.event.type === 'watched' || item.event.type === 'unwatched') ? [{ text: describer.groupEvent(item.event), wakes: item.wakes }] : []);

	const { group: changed } = await put(player.memberId, true);
	assert.equal(changed.members.find((member: { memberId: string }) => member.memberId === player.memberId).watching, true);
	// 用户改的记进时间线，写明是用户改的、以后会怎样，不唤醒；没变时不记。
	await put(player.memberId, true);
	assert.deepEqual(watchEvents(), [{ text: `用户为你关注了群聊「大群」(${group.groupId})，此后该群的每条新消息都会提醒你处理`, wakes: false }]);
	await put(player.memberId, false);
	assert.equal(watchEvents()[1]!.text, `用户取消了你对群聊「大群」(${group.groupId})的关注，此后该群只有点名你的消息会提醒你`);

	// 成员自己用工具改的，工具结果里已经写了，不记。
	const context = { memberId: player.memberId, workingDirectory: '.', signal: new AbortController().signal };
	assert.match((await runtime.tools.call(context, 'manage_group', JSON.stringify({ action: 'watch', group_id: group.groupId }))).output, /已关注/);
	assert.equal(runtime.groups.require(group.groupId).members.find(member => member.memberId === player.memberId)!.watching, true);
	assert.equal(watchEvents().length, 2);

	assert.match((await put(human.memberId, true)).error.message, /只有 AI 成员/);
	assert.ok((await put(outsider.memberId, true)).error);
});

test('时间线里直接说话可以带附件：先上传拿到 ID，取回附件，网页附件按纯文本发；文字和附件都没有、附件太多、附件不存在时报错', async t => {
	const runtime = testRuntime(t);
	const server = new RuntimeServer(runtime, 'secret');
	const base = `http://127.0.0.1:${await server.listen()}`;
	t.after(async () => {
		await server.close();
		await runtime.close();
	});
	const ai = addAi(runtime, '沈安');
	const headers = { Authorization: 'Bearer secret' };
	const upload = async (name: string, body: Buffer): Promise<string> =>
		((await (await fetch(`${base}/v1/attachments?name=${name}`, { method: 'POST', headers, body })).json()) as { attachment: { attachmentId: string } }).attachment.attachmentId;
	const say = (body: object) => fetch(`${base}/v1/members/${ai.memberId}/timeline`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
	const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
	const image = await upload('a.png', png);
	const note = await upload('note.txt', Buffer.from('笔记'));
	const page = await upload('page.html', Buffer.from('<script>alert(1)</script>'));

	const { item } = await (await say({ attachments: [image, note, page] })).json() as { item: { itemId: number; input: { text: string; attachments: { name: string; kind: string }[] } } };
	assert.deepEqual([item.input.text, item.input.attachments.map(attachment => `${attachment.name}/${attachment.kind}`)], ['', ['a.png/image', 'note.txt/file', 'page.html/file']]);
	const file = await fetch(`${base}/v1/members/${ai.memberId}/timeline/${item.itemId}/attachments/1`, { headers });
	assert.equal(await file.text(), '笔记');
	// 成员写的网页不能在运行时的源里执行。
	const html = await fetch(`${base}/v1/members/${ai.memberId}/timeline/${item.itemId}/attachments/2`, { headers });
	assert.deepEqual([html.headers.get('content-type'), html.headers.get('x-content-type-options')], ['text/plain; charset=utf-8', 'nosniff']);
	assert.equal((await fetch(`${base}/v1/members/${ai.memberId}/timeline/${item.itemId}/attachments/3`, { headers })).status, 404);
	assert.deepEqual(Buffer.from(await (await fetch(`${base}/v1/members/${ai.memberId}/timeline/${item.itemId}/attachments/0`, { headers })).arrayBuffer()), png);

	assert.equal((await say({ text: ' ' })).status, 400);
	const tooMany = await say({ text: '多', attachments: Array.from({ length: 11 }, () => note) });
	assert.deepEqual([tooMany.status, ((await tooMany.json()) as { error: { message: string } }).error.message], [400, '一次最多 10 个附件']);
	assert.equal((await say({ text: '看', attachments: ['A_不存在'] })).status, 404);
	assert.equal(runtime.timeline.all(ai.memberId).filter(entry => entry.kind === 'user_input').length, 1);
});

test('换头像按内容判断格式，替换原来的头像；不是图片时报错', async t => {
	const runtime = testRuntime(t);
	const server = new RuntimeServer(runtime, 'secret');
	const base = `http://127.0.0.1:${await server.listen()}`;
	t.after(async () => {
		await server.close();
		await runtime.close();
	});
	const ai = addAi(runtime, '沈安');
	const put = (body: Buffer) => fetch(`${base}/v1/members/${ai.memberId}/avatar`, { method: 'PUT', headers: { Authorization: 'Bearer secret' }, body });
	const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
	const gif = Buffer.from('GIF89a-content');

	assert.notEqual(((await (await put(png)).json()) as { member: { avatar: string | null } }).member.avatar, null);
	await put(gif);
	const folder = join(runtime.memberFolders.directory, '沈安');
	assert.deepEqual(readdirSync(folder).filter(name => name.startsWith('avatar.')), ['avatar.gif']);
	assert.equal((await put(Buffer.from('不是图片'))).status, 400);
	await fetch(`${base}/v1/members/${ai.memberId}/avatar`, { method: 'DELETE', headers: { Authorization: 'Bearer secret' } });
	assert.equal(runtime.members.get(ai.memberId)!.avatar, null);
});

test('新建 AI 成员时一次给出工具、审批方式和工作目录；有误时什么都不建', async t => {
	const runtime = testRuntime(t);
	const server = new RuntimeServer(runtime, 'secret');
	const base = `http://127.0.0.1:${await server.listen()}`;
	t.after(async () => {
		await server.close();
		await runtime.close();
	});
	const headers = { Authorization: 'Bearer secret', 'Content-Type': 'application/json' };
	const { tools } = await (await fetch(`${base}/v1/tools`, { headers })).json() as { tools: { name: string; enabled: boolean; policy: string; builtinPolicy: string }[] };
	const shell = tools.find(tool => tool.name === 'shell')!;
	assert.deepEqual([shell.enabled, shell.policy], [true, shell.builtinPolicy]);

	const create = (extra: object) => fetch(`${base}/v1/members`, {
		method: 'POST', headers, body: JSON.stringify({ type: 'ai', name: '沈安', definition: { tools: ['shell'] }, ...extra }),
	});
	assert.equal((await create({ toolPolicies: { shell: '随便' } })).status, 400);
	assert.equal((await create({ workingDirectory: '相对路径' })).status, 400);
	assert.equal(runtime.members.findByName('沈安'), undefined);

	const { member } = await (await create({ toolPolicies: { shell: 'ask' }, workingDirectory: homedir() })).json() as { member: { memberId: string; workingDirectory: string } };
	assert.equal(member.workingDirectory, homedir());
	const list = runtime.tools.list(member.memberId);
	assert.equal(list.find(tool => tool.name === 'shell')!.policy, 'ask');
	assert.equal(list.find(tool => tool.name === 'files')!.enabled, false);
});

test('新成员的工具默认设置：存在文件里，新建时写明；改之前还在用默认值的成员先记下当前设置，不跟着变', async t => {
	const directory = temporaryDirectory(t);
	const toolDefaultsPath = join(directory, 'tool-defaults.json');
	const runtime = testRuntime(t, { toolDefaultsPath });
	const server = new RuntimeServer(runtime, 'secret');
	const base = `http://127.0.0.1:${await server.listen()}`;
	t.after(async () => {
		await server.close();
		await runtime.close();
	});
	const headers = { Authorization: 'Bearer secret', 'Content-Type': 'application/json' };
	const call = async (method: string, path: string, body?: object): Promise<any> => (await fetch(`${base}${path}`, { method, headers, body: body && JSON.stringify(body) })).json();
	const summary = (tools: { name: string; enabled: boolean; policy: string }[]) => tools.filter(tool => ['shell', 'terminal'].includes(tool.name)).map(tool => `${tool.name}/${tool.enabled}/${tool.policy}`);
	// manage_group 内置默认不启用：改成启用才记在文件里。
	const manageGroup = runtime.tools.list().find(tool => tool.name === 'manage_group')!;
	assert.deepEqual([manageGroup.enabled, manageGroup.builtinEnabled], [false, false]);
	await call('PUT', '/v1/tool-defaults/manage_group', { enabled: true });
	assert.deepEqual(JSON.parse(readFileSync(toolDefaultsPath, 'utf8')), { manage_group: { enabled: true } });
	await call('DELETE', '/v1/tool-defaults');
	const memberFile = (name: string) => JSON.parse(readFileSync(join(runtime.memberFolders.directory, name, 'member.json'), 'utf8'));
	// 手写的成员文件夹：没写 tools，审批方式也没设置过，一直用默认值。
	const old = addAi(runtime, '旧成员');
	assert.equal(memberFile('旧成员').tools, undefined);

	assert.match((await call('PUT', '/v1/tool-defaults/shell', { policy: '随便' })).error.message, /审批方式只能是/);
	assert.match((await call('PUT', '/v1/tool-defaults/send_message', { enabled: false })).error.message, /不支持该设置/);
	assert.equal(memberFile('旧成员').tools, undefined);

	await call('PUT', '/v1/tool-defaults/terminal', { enabled: true });
	const { tools } = await call('PUT', '/v1/tool-defaults/shell', { policy: 'ask' });
	assert.deepEqual(summary(tools), ['shell/true/ask', 'terminal/true/auto']);
	assert.deepEqual(JSON.parse(readFileSync(toolDefaultsPath, 'utf8')), { terminal: { enabled: true }, shell: { policy: 'ask' } });
	// 旧成员记下了改之前的设置。
	assert.ok(!memberFile('旧成员').tools.includes('terminal'));
	assert.deepEqual(summary(runtime.tools.list(old.memberId)), ['shell/true/auto', 'terminal/false/auto']);

	// 新建时写明现在的默认设置；给了的审批方式照给的。
	const { member } = await call('POST', '/v1/members', { type: 'ai', name: '新成员', toolPolicies: { terminal: 'allow' } });
	assert.ok(memberFile('新成员').tools.includes('terminal'));
	assert.deepEqual(summary(runtime.tools.list(member.memberId)), ['shell/true/ask', 'terminal/true/allow']);

	// 恢复内置默认，已有成员都不变；改回内置默认的项不记在文件里。
	assert.deepEqual(summary((await call('DELETE', '/v1/tool-defaults')).tools), ['shell/true/auto', 'terminal/false/auto']);
	assert.deepEqual(JSON.parse(readFileSync(toolDefaultsPath, 'utf8')), {});
	assert.deepEqual(summary(runtime.tools.list(old.memberId)), ['shell/true/auto', 'terminal/false/auto']);
	assert.deepEqual(summary(runtime.tools.list(member.memberId)), ['shell/true/ask', 'terminal/true/allow']);

	// 重启后从文件读回来。
	await call('PUT', '/v1/tool-defaults/shell', { policy: 'allow' });
	const restarted = testRuntime(t, { toolDefaultsPath });
	t.after(() => restarted.close());
	assert.deepEqual(summary(restarted.tools.list()), ['shell/true/allow', 'terminal/false/auto']);
});

test('新成员的默认技能：存在文件里，没写 skills 的成员用默认技能；改默认、删技能之前先写定还在用默认技能的成员', async t => {
	const directory = temporaryDirectory(t);
	const skillDefaultsPath = join(directory, 'skill-defaults.json');
	const runtime = testRuntime(t, { skillDefaultsPath });
	const server = new RuntimeServer(runtime, 'secret');
	const base = `http://127.0.0.1:${await server.listen()}`;
	t.after(async () => {
		await server.close();
		await runtime.close();
	});
	const headers = { Authorization: 'Bearer secret', 'Content-Type': 'application/json' };
	const call = async (method: string, path: string, body?: object): Promise<any> => (await fetch(`${base}${path}`, { method, headers, body: body && JSON.stringify(body) })).json();
	const memberFile = (name: string) => JSON.parse(readFileSync(join(runtime.memberFolders.directory, name, 'member.json'), 'utf8'));
	const enabled = (skills: { name: string; defaultEnabled: boolean }[]) => skills.filter(skill => skill.defaultEnabled).map(skill => skill.name);
	runtime.skills.create('notes', '记笔记', '# 笔记');
	runtime.skills.create('drafts', '写草稿', '# 草稿');
	// 内置默认一个都不启用。
	assert.deepEqual(enabled((await call('GET', '/v1/skills')).skills), []);
	const old = addAi(runtime, '旧成员');
	assert.deepEqual(old.skills, []);

	assert.match((await call('PUT', '/v1/skill-defaults/missing', { enabled: true })).error.message, /不存在技能 missing/);
	assert.match((await call('PUT', '/v1/skill-defaults/notes', { enabled: 'yes' })).error.message, /enabled 必须是/);
	assert.equal(memberFile('旧成员').skills, undefined);

	// 改之前旧成员写定当时的技能（没有技能），不跟着变。
	assert.deepEqual(enabled((await call('PUT', '/v1/skill-defaults/notes', { enabled: true })).skills), ['notes']);
	assert.deepEqual(JSON.parse(readFileSync(skillDefaultsPath, 'utf8')), ['notes']);
	assert.deepEqual(memberFile('旧成员').skills, []);
	assert.deepEqual(runtime.members.get(old.memberId)!.skills, []);

	// 手写的成员文件夹没写 skills：用默认技能，文件不动。
	const handwritten = addAi(runtime, '手写成员');
	assert.deepEqual(handwritten.skills, ['notes']);
	assert.equal(memberFile('手写成员').skills, undefined);
	// 接口新建的成员写明现在的默认技能；给了的照给的。
	await call('POST', '/v1/members', { type: 'ai', name: '新成员' });
	assert.deepEqual(memberFile('新成员').skills, ['notes']);
	await call('POST', '/v1/members', { type: 'ai', name: '不要技能', definition: { skills: [] } });
	assert.deepEqual(memberFile('不要技能').skills, []);

	await call('PUT', '/v1/skill-defaults/drafts', { enabled: true });
	assert.deepEqual(memberFile('手写成员').skills, ['notes']);
	assert.deepEqual(runtime.members.get(handwritten.memberId)!.skills, ['notes']);

	// 删除技能也从默认技能里去掉，还在用默认技能的成员先写定，删掉的技能留在它的配置里。
	const another = addAi(runtime, '再一个');
	assert.deepEqual(another.skills, ['drafts', 'notes']);
	assert.deepEqual(await call('DELETE', '/v1/skills/notes'), {});
	assert.deepEqual(JSON.parse(readFileSync(skillDefaultsPath, 'utf8')), ['drafts']);
	assert.deepEqual(memberFile('再一个').skills, ['drafts', 'notes']);
	// 默认技能里没有的技能删除时不改成员。
	const third = addAi(runtime, '第三个');
	await call('POST', '/v1/skills', { name: 'misc', description: '杂项', body: '正文' });
	await call('DELETE', '/v1/skills/misc');
	assert.equal(memberFile('第三个').skills, undefined);
	assert.deepEqual(runtime.members.get(third.memberId)!.skills, ['drafts']);

	// 覆盖内置的技能删除后内置的还在，默认启用的设置保留。
	await call('POST', '/v1/skills/import', { directory: runtime.skills.get('manage-members')!.directory });
	await call('PUT', '/v1/skill-defaults/manage-members', { enabled: true });
	await call('DELETE', '/v1/skills/manage-members');
	assert.deepEqual(enabled((await call('GET', '/v1/skills')).skills), ['manage-members', 'drafts']);

	// 重启后从文件读回来；技能目录里没有的名字忽略，有了以后又生效。
	writeFileSync(skillDefaultsPath, JSON.stringify(['drafts', 'gone', 'Bad Name', 3]));
	const restarted = testRuntime(t, { skillDefaultsPath, skillsDirectory: runtime.skills.directory });
	t.after(() => restarted.close());
	assert.deepEqual(restarted.skills.defaults(), ['drafts']);
	restarted.skills.create('gone', '回来了', '正文');
	assert.deepEqual(restarted.skills.defaults(), ['drafts', 'gone']);
});

test('浏览器禁止访问的网址：运行时的网页端总是禁止，用户加的整个替换、存在文件里；有一项不对时报错不改', async t => {
	const path = join(temporaryDirectory(t), 'browser-blocklist.json');
	const runtime = testRuntime(t, { browserBlocklistPath: path });
	const server = new RuntimeServer(runtime, 'secret');
	const port = await server.listen();
	t.after(async () => {
		await server.close();
		await runtime.close();
	});
	const headers = { Authorization: 'Bearer secret', 'Content-Type': 'application/json' };
	const call = async (method: string, body?: object): Promise<any> => (await fetch(`http://127.0.0.1:${port}/v1/browser-blocklist`, {
		method, headers, body: body && JSON.stringify(body),
	})).json();
	let changes = 0;
	runtime.events.subscribe(({ event }) => {
		if (event.type === 'browserBlocklist.changed') changes++;
	});

	assert.deepEqual(await call('GET'), { runtime: `127.0.0.1:${port}`, hosts: [] });
	assert.deepEqual(await call('PUT', { hosts: ['https://Example.com/a', 'localhost:8888', 'example.com'] }), { runtime: `127.0.0.1:${port}`, hosts: ['example.com', 'localhost:8888'] });
	assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), ['example.com', 'localhost:8888']);
	assert.match((await call('PUT', { hosts: ['a.com', ''] })).error.message, /「」格式有误：不能为空/);
	assert.deepEqual((await call('GET')).hosts, ['example.com', 'localhost:8888']);
	assert.equal(changes, 1);
	assert.equal(runtime.browsers.blocklist.reason(new URL('https://www.example.com/')), '用户禁止访问 example.com');
});

test('run_tool_script 只能开关、不用审批：没有审批方式可选，设置审批方式被拒绝', async t => {
	const runtime = testRuntime(t);
	const server = new RuntimeServer(runtime, 'secret');
	const base = `http://127.0.0.1:${await server.listen()}`;
	t.after(async () => {
		await server.close();
		await runtime.close();
	});
	const headers = { Authorization: 'Bearer secret', 'Content-Type': 'application/json' };
	const call = async (method: string, path: string, body?: object): Promise<any> => (await fetch(`${base}${path}`, { method, headers, body: body && JSON.stringify(body) })).json();
	const runCode = () => runtime.tools.list().find(tool => tool.name === 'run_tool_script')!;
	assert.deepEqual([runCode().configurable, runCode().policies, runCode().policy], [true, [], 'allow']);

	assert.match((await call('PUT', '/v1/tool-defaults/run_tool_script', { policy: 'ask' })).error.message, /无需审批/);
	assert.match((await call('POST', '/v1/members', { type: 'ai', name: '沈安', toolPolicies: { run_tool_script: 'ask' } })).error.message, /无需审批/);
	const member = addAi(runtime, '林舟');
	assert.match((await call('PUT', `/v1/members/${member.memberId}/tools/run_tool_script`, { policy: 'ask' })).error.message, /无需审批/);
	// 改默认设置时不给 run_tool_script 记审批方式。
	await call('PUT', '/v1/tool-defaults/run_tool_script', { enabled: false });
	assert.equal(runtime.db.get('SELECT policy FROM tool_policies WHERE tool_name = ?', 'run_tool_script'), undefined);
});

test('技能接口：技能目录里的技能可以新建、修改、删除，内置技能只读；导入复制整个文件夹，跳过隐藏文件', async t => {
	const runtime = testRuntime(t);
	const server = new RuntimeServer(runtime, 'secret');
	const base = `http://127.0.0.1:${await server.listen()}`;
	t.after(async () => {
		await server.close();
		await runtime.close();
	});
	const headers = { Authorization: 'Bearer secret', 'Content-Type': 'application/json' };
	const call = async (method: string, path: string, body?: object): Promise<any> => (await fetch(`${base}${path}`, { method, headers, body: body && JSON.stringify(body) })).json();
	const skillFile = (name: string) => readFileSync(join(runtime.skills.directory, name, 'SKILL.md'), 'utf8');

	const created = await call('POST', '/v1/skills', { name: 'notes', description: '记笔记: 方法', body: '# 笔记\r\n' });
	assert.deepEqual([created.skill.name, created.skill.source, created.skill.description, created.body], ['notes', 'data', '记笔记: 方法', '# 笔记\n']);
	assert.equal(skillFile('notes'), '---\nname: notes\ndescription: >-\n  记笔记: 方法\n---\n\n# 笔记\n');
	assert.match((await call('POST', '/v1/skills', { name: 'notes', description: '说明', body: '正文' })).error.message, /已存在技能 notes/);
	assert.match((await call('POST', '/v1/skills', { name: 'manage-members', description: '说明', body: '正文' })).error.message, /已存在技能 manage-members/);
	assert.match((await call('POST', '/v1/skills', { name: 'Notes', description: '说明', body: '正文' })).error.message, /只能包含小写英文字母/);
	assert.match((await call('POST', '/v1/skills', { name: 'empty', description: ' ', body: '正文' })).error.message, /说明不能为空/);

	// 修改只换说明和正文，开头的其他字段原样保留。
	writeFileSync(join(runtime.skills.directory, 'notes', 'SKILL.md'), '---\nname: notes\ndescription: |\n  旧说明\n  第二行\nlicense: MIT\n---\n旧正文\n');
	const updated = await call('PUT', '/v1/skills/notes', { description: '新说明', body: '新正文' });
	assert.deepEqual([updated.skill.description, updated.body], ['新说明', '新正文\n']);
	assert.equal(skillFile('notes'), '---\nname: notes\ndescription: 新说明\nlicense: MIT\n---\n\n新正文\n');
	assert.match((await call('PUT', '/v1/skills/manage-members', { description: '说明', body: '正文' })).error.message, /内置技能不能修改/);
	assert.match((await call('DELETE', '/v1/skills/manage-members')).error.message, /内置技能不能删除/);
	assert.match((await call('GET', '/v1/skills/missing')).error.message, /不存在技能 missing/);

	// 删除技能不改成员配置，成员文件夹的警告跟着更新。
	const member = addAi(runtime, '林舟', { skills: ['notes'] });
	assert.deepEqual(await call('DELETE', '/v1/skills/notes'), {});
	assert.deepEqual(runtime.members.get(member.memberId)!.skills, ['notes']);
	assert.equal(runtime.memberFolders.snapshot().folders[0]!.issues.join(), '技能「notes」不存在，无法读取');

	// 导入：列出文件夹里的技能，复制整个文件夹。
	const source = temporaryDirectory(t);
	const put = (path: string, content: string) => {
		mkdirSync(dirname(join(source, path)), { recursive: true });
		writeFileSync(join(source, path), content);
	};
	put('one/SKILL.md', '---\nname: one\ndescription: 第一个\n---\n\n正文\n');
	put('one/scripts/run.sh', 'echo 1\n');
	put('one/.git/config', '');
	put('Bad_Name/SKILL.md', '正文\n');
	put('two/readme.md', '没有 SKILL.md\n');
	const listed = (await call('GET', `/v1/skill-sources?path=${encodeURIComponent(source)}`)).sources[0];
	assert.deepEqual(listed.skills.map((skill: any) => `${skill.name}/${skill.description}/${skill.problem}/${skill.exists}`), [
		'Bad_Name//技能名「Bad_Name」只能包含小写英文字母、数字和横杠/false',
		'one/第一个/null/false',
	]);
	const imported = await call('POST', '/v1/skills/import', { directory: join(source, 'one') });
	assert.deepEqual([imported.skill.name, imported.files], ['one', ['scripts/run.sh']]);
	const again = await fetch(`${base}/v1/skills/import`, { method: 'POST', headers, body: JSON.stringify({ directory: join(source, 'one') }) });
	assert.equal(again.status, 409);
	put('one/SKILL.md', '---\ndescription: 改过的\n---\n\n正文\n');
	assert.equal((await call('POST', '/v1/skills/import', { directory: join(source, 'one'), overwrite: true })).skill.description, '改过的');
	assert.equal((await call('GET', `/v1/skill-sources?path=${encodeURIComponent(source)}`)).sources[0].skills[1].exists, true);
	assert.equal((await call('GET', `/v1/skill-sources?path=${encodeURIComponent(join(runtime.skills.directory, 'one'))}`)).sources[0].skills[0].problem, '已位于技能目录中');
	assert.match((await call('GET', '/v1/skill-sources?path=relative')).error.message, /绝对路径/);
	assert.deepEqual((await call('GET', '/v1/skill-sources')).sources.map((item: any) => item.label), ['~/.agents/skills', '~/.claude/skills', '~/.codex/skills']);

	// 内置技能复制为自己的，覆盖内置的；删掉后恢复用内置的。
	const builtin = runtime.skills.get('manage-members')!.directory;
	assert.equal((await call('POST', '/v1/skills/import', { directory: builtin })).skill.overridesBuiltin, true);
	assert.equal(readFileSync(join(runtime.skills.directory, 'manage-members', 'SKILL.md'), 'utf8'), readFileSync(join(builtin, 'SKILL.md'), 'utf8'));
	await call('DELETE', '/v1/skills/manage-members');
	assert.equal(runtime.skills.get('manage-members')!.source, 'builtin');
	assert.deepEqual(readdirSync(runtime.skills.directory).sort(), ['one']);
});

test('浏览目录：只列子目录、不含隐藏目录；不存在的目录给出原因；不给路径时只有用户目录和盘符', async t => {
	const runtime = testRuntime(t);
	const server = new RuntimeServer(runtime, 'secret');
	const base = `http://127.0.0.1:${await server.listen()}`;
	t.after(async () => {
		await server.close();
		await runtime.close();
	});
	const list = async (path?: string) => {
		const response = await fetch(`${base}/v1/directories${path === undefined ? '' : `?path=${encodeURIComponent(path)}`}`, { headers: { Authorization: 'Bearer secret' } });
		return { status: response.status, body: await response.json() as { path: string | null; parent: string | null; directories: { name: string; path: string }[]; error?: string; home: string; roots: string[] } };
	};
	const root = temporaryDirectory(t);
	for (const name of ['b', 'A', '.git']) mkdirSync(join(root, name));
	writeFileSync(join(root, 'file.txt'), '');

	const { body } = await list(root);
	assert.deepEqual(body.directories, [{ name: 'A', path: join(root, 'A') }, { name: 'b', path: join(root, 'b') }]);
	assert.equal(body.parent, dirname(root));
	assert.equal((await list(join(root, '没有'))).body.error, '目录不存在');
	assert.equal((await list('相对路径')).status, 400);
	const start = (await list()).body;
	assert.deepEqual([start.path, start.home, start.roots.length > 0], [null, homedir(), true]);
});

test('前端新建终端：不填起始目录时用用户目录，一开始由用户操作', async t => {
	const runtime = testRuntime(t);
	const server = new RuntimeServer(runtime, 'secret');
	const base = `http://127.0.0.1:${await server.listen()}`;
	t.after(async () => {
		await server.close();
		await runtime.close();
	});
	const response = await fetch(`${base}/v1/terminals`, { method: 'POST', headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' }, body: '{}' });
	const { terminal } = await response.json() as { terminal: { terminalId: string; cwd: string; createdBy: string | null; controller: string } };
	runtime.terminals.close(terminal.terminalId, 'user');
	assert.deepEqual([terminal.cwd, terminal.createdBy, terminal.controller], [homedir(), null, 'user']);
});

test('搜索消息和取单条消息的接口', async t => {
	const runtime = testRuntime(t);
	const server = new RuntimeServer(runtime, 'secret');
	const base = `http://127.0.0.1:${await server.listen()}`;
	t.after(async () => {
		await server.close();
		await runtime.close();
	});
	const human = runtime.members.createHuman('张三');
	const ai = addAi(runtime, '沈安');
	const sent = runtime.messages.send(human.memberId, { kind: 'direct', memberId: ai.memberId }, '明天 开会');
	const get = async (path: string): Promise<any> => (await fetch(`${base}${path}`, { headers: { Authorization: 'Bearer secret' } })).json();

	const found = await get(`/v1/members/${ai.memberId}/messages/search?q=${encodeURIComponent('开会 明天')}`);
	assert.deepEqual(found.messages.map((message: { messageId: number }) => message.messageId), [sent.messageId]);
	assert.equal((await get(`/v1/messages/${sent.messageId}`)).message.text, '明天 开会');
	const around = await get(`/v1/members/${human.memberId}/conversations/direct/${ai.memberId}/messages?around=${sent.messageId}`);
	assert.equal(around.messages[0].messageId, sent.messageId);
});

test('已删除的成员：时间线还能取，头像跟着成员文件夹没了；恢复、彻底删除的接口', async t => {
	const runtime = testRuntime(t);
	const server = new RuntimeServer(runtime, 'secret');
	const base = `http://127.0.0.1:${await server.listen()}`;
	t.after(async () => {
		await server.close();
		await runtime.close();
	});
	const ai = addAi(runtime, '沈安');
	const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
	runtime.memberFolders.setAvatar(ai.memberId, png);
	const call = (method: string, path: string) => fetch(`${base}${path}`, { method, headers: { Authorization: 'Bearer secret' } });

	assert.equal((await call('POST', `/v1/members/${ai.memberId}/purge`)).status, 400);
	const avatar = await call('GET', `/v1/members/${ai.memberId}/avatar`);
	assert.deepEqual([avatar.headers.get('content-type'), Buffer.from(await avatar.arrayBuffer())], ['image/png', png]);
	await call('DELETE', `/v1/members/${ai.memberId}`);
	assert.equal((await call('GET', `/v1/members/${ai.memberId}/avatar`)).status, 404);
	assert.equal((await call('GET', `/v1/members/${ai.memberId}/timeline`)).status, 200);
	const listed = ((await (await call('GET', '/v1/members')).json()) as { members: { memberId: string; deletedAt: number | null; purged: boolean }[] }).members;
	assert.ok(listed.some(member => member.memberId === ai.memberId && member.deletedAt !== null && !member.purged));

	const restored = (await (await call('POST', `/v1/members/${ai.memberId}/restore`)).json()) as { member: { deleted: boolean } };
	assert.equal(restored.member.deleted, false);
	await call('DELETE', `/v1/members/${ai.memberId}`);
	assert.equal((await call('POST', `/v1/members/${ai.memberId}/purge`)).status, 200);
	assert.equal((await call('GET', `/v1/members/${ai.memberId}/avatar`)).status, 404);
	assert.equal((await call('GET', `/v1/members/${ai.memberId}/timeline`)).status, 404);
});

test('成员页的分组：新建排在最后，名字不能为空、太长或重复；整个替换成员，去掉重复；调整先后要列全；删除分组不影响成员', async t => {
	const runtime = testRuntime(t);
	const server = new RuntimeServer(runtime, 'secret');
	const base = `http://127.0.0.1:${await server.listen()}`;
	t.after(async () => {
		await server.close();
		await runtime.close();
	});
	const human = runtime.members.createHuman('张三');
	const ai = addAi(runtime, '沈安');
	const call = async (method: string, path: string, body?: object): Promise<{ status: number; json: any }> => {
		const response = await fetch(`${base}${path}`, { method, headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
		return { status: response.status, json: await response.json() };
	};
	let changes = 0;
	runtime.events.subscribe(item => {
		if (item.event.type === 'memberSections.changed') changes++;
	});

	const first = (await call('POST', '/v1/member-sections', { name: ' 项目A ' })).json.section;
	assert.deepEqual(first, { sectionId: first.sectionId, name: '项目A', memberIds: [] });
	assert.match(first.sectionId, /^L_/);
	const second = (await call('POST', '/v1/member-sections', { name: '测试' })).json.section;
	assert.equal((await call('POST', '/v1/member-sections', { name: '  ' })).json.error.message, '分组名不能为空');
	assert.equal((await call('POST', '/v1/member-sections', { name: '一'.repeat(21) })).json.error.message, '分组名最多 20 个字');
	assert.equal((await call('POST', '/v1/member-sections', { name: 'project' })).status, 200);
	assert.equal((await call('POST', '/v1/member-sections', { name: 'PROJECT' })).json.error.message, '已存在名为「PROJECT」的分组');

	const updated = (await call('PUT', `/v1/member-sections/${first.sectionId}`, { memberIds: [ai.memberId, human.memberId, ai.memberId] })).json.section;
	assert.deepEqual(updated.memberIds, [ai.memberId, human.memberId]);
	assert.equal((await call('PUT', `/v1/member-sections/${first.sectionId}`, { memberIds: ['M_NOPE'] })).status, 404);
	assert.equal((await call('PUT', `/v1/member-sections/${first.sectionId}`, { name: '项目一' })).json.section.memberIds.length, 2);
	assert.equal((await call('PUT', `/v1/member-sections/${second.sectionId}`, { name: '项目一' })).status, 400);

	const sections = (await call('GET', '/v1/member-sections')).json.sections;
	assert.deepEqual(sections.map((section: { name: string }) => section.name), ['项目一', '测试', 'project']);
	const ids = sections.map((section: { sectionId: string }) => section.sectionId);
	assert.equal((await call('PUT', '/v1/member-section-order', { sectionIds: ids.slice(1) })).status, 400);
	const ordered = (await call('PUT', '/v1/member-section-order', { sectionIds: [ids[2], ids[0], ids[1]] })).json.sections;
	assert.deepEqual(ordered.map((section: { name: string }) => section.name), ['project', '项目一', '测试']);

	assert.equal((await call('DELETE', `/v1/member-sections/${first.sectionId}`)).status, 200);
	assert.deepEqual((await call('GET', '/v1/member-sections')).json.sections.map((section: { name: string }) => section.name), ['project', '测试']);
	assert.equal(runtime.members.list().length, 2);
	assert.equal((await call('DELETE', `/v1/member-sections/${first.sectionId}`)).status, 404);
	assert.equal(changes, 7);
});

test('成员页概览：AI 成员最近的结果和使用者看过没有，真人的未读；看到哪一条只往后记；彻底删除时去掉分组和看到哪一条', async t => {
	const runtime = testRuntime(t);
	const server = new RuntimeServer(runtime, 'secret');
	const base = `http://127.0.0.1:${await server.listen()}`;
	t.after(async () => {
		await server.close();
		await runtime.close();
	});
	const human = runtime.members.createHuman('张三');
	const ai = addAi(runtime, '沈安', { directMessage: 'all' });
	const call = async (method: string, path: string, body?: object): Promise<{ status: number; json: any }> => {
		const response = await fetch(`${base}${path}`, { method, headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
		return { status: response.status, json: await response.json() };
	};
	const overview = async () => {
		const members = (await call('GET', '/v1/member-overview')).json.members as Record<string, any>[];
		return new Map(members.map(member => [member['memberId'] as string, member]));
	};
	// 发出的消息按时间和看到的那一条比，隔开一点免得落在同一毫秒。
	const tick = () => new Promise(resolve => setTimeout(resolve, 5));

	let members = await overview();
	assert.deepEqual(members.get(ai.memberId), { memberId: ai.memberId, type: 'ai', lastActivityAt: null, lastResult: null, hasNewResult: false });
	assert.deepEqual(members.get(human.memberId), { memberId: human.memberId, type: 'human', unreadCount: 0, mentionCount: 0, lastUnreadAt: null });

	runtime.messages.send(human.memberId, { kind: 'direct', memberId: ai.memberId }, '帮我看看');
	const received = runtime.timeline.latestItemId(ai.memberId);
	await tick();
	const reply = runtime.messages.send(ai.memberId, { kind: 'direct', memberId: human.memberId }, '看完了，\n  没有问题。');
	members = await overview();
	assert.deepEqual(members.get(ai.memberId)!['lastResult'], { kind: 'message', at: reply.sentAt, target: { kind: 'direct', memberId: human.memberId }, text: '看完了， 没有问题。' });
	assert.equal(members.get(ai.memberId)!['hasNewResult'], true);
	assert.deepEqual(members.get(human.memberId), { memberId: human.memberId, type: 'human', unreadCount: 1, mentionCount: 0, lastUnreadAt: reply.sentAt });
	// 只要几个成员时只算这几个，不认识的 ID 不报错。
	const some = (await call('GET', `/v1/member-overview?memberIds=${human.memberId},M_NONE`)).json.members as Record<string, any>[];
	assert.deepEqual(some, [members.get(human.memberId)]);

	// 直接输出比发出的消息晚，成了最近的结果；只有空文字的输出不算。
	await tick();
	const runId = runtime.db.run(`INSERT INTO runs (member_id, kind, status, started_at) VALUES (?, 'response', 'completed', 0)`, ai.memberId).lastId;
	const requestId = runtime.db.run(`INSERT INTO model_requests (run_id, kind, provider, model, seen_through_item_id, status, started_at) VALUES (?, 'response', 'test', 'fake', 0, 'completed', 0)`, runId).lastId;
	runtime.timeline.appendModelOutputs(ai.memberId, requestId, [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `已经回复${'好'.repeat(120)}` }] }]);
	runtime.timeline.appendModelOutputs(ai.memberId, requestId, [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '' }] }]);
	const latest = runtime.timeline.latestItemId(ai.memberId);
	members = await overview();
	assert.equal(members.get(ai.memberId)!['lastResult'].kind, 'output');
	assert.equal(members.get(ai.memberId)!['lastResult'].text.length, 100);

	// 看到哪一条只往后记；看到最新的以后就没有新的结果了。
	const viewed: string[] = [];
	runtime.events.subscribe(item => {
		if (item.event.type === 'timeline.viewed') viewed.push(item.event.memberId);
	});
	assert.equal((await call('PUT', `/v1/members/${ai.memberId}/viewed`, { itemId: received })).json.viewedThroughItemId, received);
	assert.equal((await overview()).get(ai.memberId)!['hasNewResult'], true);
	assert.equal((await call('PUT', `/v1/members/${ai.memberId}/viewed`, { itemId: latest })).json.viewedThroughItemId, latest);
	assert.equal((await overview()).get(ai.memberId)!['hasNewResult'], false);
	assert.equal((await call('PUT', `/v1/members/${ai.memberId}/viewed`, { itemId: received })).json.viewedThroughItemId, latest);
	assert.deepEqual(viewed, [ai.memberId, ai.memberId]);
	assert.equal((await call('PUT', `/v1/members/${ai.memberId}/viewed`, { itemId: latest + 100 })).status, 404);
	assert.equal((await call('PUT', `/v1/members/${human.memberId}/viewed`, { itemId: latest })).status, 400);

	// 看过以后又发了消息：又有新的结果。
	await tick();
	runtime.messages.send(ai.memberId, { kind: 'direct', memberId: human.memberId }, '补充一句');
	assert.equal((await overview()).get(ai.memberId)!['hasNewResult'], true);

	// 删除后照旧留在分组里，彻底删除时去掉分组里的它和看到哪一条。
	const section = runtime.memberPage.createSection('项目A');
	runtime.memberPage.updateSection(section.sectionId, { memberIds: [ai.memberId, human.memberId] });
	await call('DELETE', `/v1/members/${ai.memberId}`);
	assert.deepEqual(runtime.memberPage.sections()[0]!.memberIds, [ai.memberId, human.memberId]);
	assert.ok((await overview()).has(ai.memberId));
	await call('POST', `/v1/members/${ai.memberId}/purge`);
	assert.deepEqual(runtime.memberPage.sections()[0]!.memberIds, [human.memberId]);
	assert.equal(runtime.db.get('SELECT 1 FROM timeline_views WHERE member_id = ?', ai.memberId), undefined);
	assert.equal((await overview()).has(ai.memberId), false);
});

test('本机文件：要完整路径，按范围取内容，HTML 按纯文本发，运行时的敏感文件不返回', async t => {
	const data = temporaryDirectory(t);
	const runtime = testRuntime(t, { dataDirectory: data });
	const server = new RuntimeServer(runtime, 'secret');
	const base = `http://127.0.0.1:${await server.listen()}`;
	t.after(async () => {
		await server.close();
		await runtime.close();
	});
	const directory = temporaryDirectory(t);
	const get = (path: string, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { headers: { Authorization: 'Bearer secret', ...headers } });
	const query = (path: string) => `?path=${encodeURIComponent(path)}`;

	const notes = join(directory, '笔记.md');
	writeFileSync(notes, '# 标题\n正文');
	const info = await (await get(`/v1/files${query(notes)}`)).json() as Record<string, unknown>;
	assert.deepEqual({ ...info, modifiedAt: 0 }, { path: notes, name: '笔记.md', kind: 'file', size: Buffer.byteLength('# 标题\n正文'), modifiedAt: 0, mime: 'text/markdown' });
	const part = await get(`/v1/files/content${query(notes)}`, { Range: 'bytes=0-1' });
	assert.equal(part.status, 206);
	assert.equal(await part.text(), '# ');

	const page = join(directory, 'page.html');
	writeFileSync(page, '<script>alert(1)</script>');
	const html = await get(`/v1/files/content${query(page)}`);
	assert.equal(html.headers.get('content-type'), 'text/plain; charset=utf-8');
	assert.equal(html.headers.get('x-content-type-options'), 'nosniff');
	// 认不出扩展名的看内容：文字按纯文本。
	writeFileSync(join(directory, 'Makefile'), 'all:\n\techo 好');
	assert.equal((await (await get(`/v1/files${query(join(directory, 'Makefile'))}`)).json() as { mime: string }).mime, 'text/plain');

	assert.equal((await get(`/v1/files${query('笔记.md')}`)).status, 400);
	if (process.platform === 'win32') assert.equal((await get(`/v1/files${query('//127.0.0.1/c$/a.md')}`)).status, 400);
	assert.equal((await get(`/v1/files${query(join(directory, '没有.md'))}`)).status, 404);
	writeFileSync(join(data, 'access-token'), 'secret');
	assert.equal((await get(`/v1/files${query(join(data, 'access-token'))}`)).status, 403);
});

test('Git 仓库：要完整路径；不是仓库时是 null；git 的报错原样返回；diff 不给看运行时的敏感文件', async t => {
	const data = temporaryDirectory(t);
	const runtime = testRuntime(t, { dataDirectory: data });
	const server = new RuntimeServer(runtime, 'secret');
	const base = `http://127.0.0.1:${await server.listen()}`;
	t.after(async () => {
		await server.close();
		await runtime.close();
	});
	const get = (path: string) => fetch(`${base}${path}`, { headers: { Authorization: 'Bearer secret' } });
	const directory = temporaryDirectory(t);

	assert.equal((await get(`/v1/git/repository?path=${encodeURIComponent('相对/路径')}`)).status, 400);
	if (process.platform === 'win32') assert.equal((await get(`/v1/git/status?path=${encodeURIComponent('//127.0.0.1/c$/repo')}`)).status, 400);
	if (!runtime.shells.git()) return;
	assert.deepEqual(await (await get(`/v1/git/repository?path=${encodeURIComponent(directory)}`)).json(), { available: true, repository: null });
	const status = await get(`/v1/git/status?path=${encodeURIComponent(directory)}`);
	assert.equal(status.status, 400);
	assert.match((await status.json() as { error: { message: string } }).error.message, /not a git repository/);
	writeFileSync(join(data, 'access-token'), 'secret');
	assert.equal((await get(`/v1/git/diff?path=${encodeURIComponent(data)}&file=access-token&area=untracked`)).status, 403);
});

test('网页端新建终端：只差最后一级时先问，上级目录也不存在时照常报错', async t => {
	const runtime = testRuntime(t);
	const server = new RuntimeServer(runtime, 'secret');
	const base = `http://127.0.0.1:${await server.listen()}`;
	t.after(async () => {
		await server.close();
		await runtime.close();
	});
	const create = async (cwd: string) => (await (await fetch(`${base}/v1/terminals`, {
		method: 'POST', headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd }),
	})).json() as { error: { code: string } }).error.code;
	const directory = temporaryDirectory(t);
	assert.equal(await create(join(directory, 'new')), 'directory_missing');
	assert.equal(existsSync(join(directory, 'new')), false);
	assert.equal(await create(join(directory, 'a', 'b')), 'invalid_argument');
});

test('公网访问：配置的域名能访问，写请求接受 https 的 Origin，经 https 进来时 Cookie 带 Secure', async t => {
	const runtime = testRuntime(t, { remoteSettingsPath: join(temporaryDirectory(t), 'remote.json') });
	const server = new RuntimeServer(runtime, 'secret');
	const base = `http://127.0.0.1:${await server.listen()}`;
	t.after(async () => {
		await server.close();
		await runtime.close();
	});
	runtime.tunnel.update({ hostname: 'human.example.com', token: 'tok-1234', enabled: true });

	// fetch 改不了 Host，这里直接发 http 请求。
	const call = (path: string, headers: Record<string, string>, body?: string) => new Promise<{ status: number; cookie: string | undefined }>((resolve, reject) => {
		const outgoing = request(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? headers : { 'Content-Length': String(Buffer.byteLength(body)), ...headers } }, response => {
			response.resume();
			response.on('end', () => resolve({ status: response.statusCode!, cookie: response.headers['set-cookie']?.[0] }));
		});
		outgoing.on('error', reject);
		outgoing.end(body);
	});

	assert.equal((await call('/v1/members', { Authorization: 'Bearer secret', Host: 'human.example.com' })).status, 200);
	assert.equal((await call('/v1/members', { Authorization: 'Bearer secret', Host: 'other.example.com' })).status, 403);

	// 经隧道进来时 Cloudflare 带这个头：Cookie 要加 Secure。
	const session = await call('/v1/session', { Authorization: 'Bearer secret', Host: 'human.example.com', 'X-Forwarded-Proto': 'https' }, '');
	assert.match(session.cookie!, /HttpOnly; SameSite=Strict; Secure/);
	const cookie = session.cookie!.split(';')[0]!;

	// Cookie 认证的写请求：Origin 是 https://域名 也认，别的域名照旧拒绝。
	const create = (origin: string, name: string, host = 'human.example.com') => call('/v1/members', { Cookie: cookie, Origin: origin, Host: host, 'Content-Type': 'application/json' }, JSON.stringify({ type: 'human', name }));
	assert.equal((await create('https://human.example.com', '张三')).status, 200);
	assert.equal((await create('https://evil.example.com', '李四')).status, 403);
	// Host 里带了默认端口（有的代理这样转发）也认；同一个主机名的别的端口不认。
	assert.equal((await create('https://human.example.com', '王五', 'human.example.com:443')).status, 200);
	assert.equal((await create('https://human.example.com:8443', '赵六')).status, 403);
	assert.equal((await create('http://human.example.com:6002', '孙七')).status, 403);

	// 关掉开关以后，那个域名也不再接受。
	runtime.tunnel.update({ enabled: false });
	assert.equal((await call('/v1/members', { Authorization: 'Bearer secret', Host: 'human.example.com' })).status, 403);

	// 「公网访问」里配的额外域名（Tailscale）：不开隧道也接受，写请求照样要同源。
	runtime.tunnel.update({ hostnames: ['human.tail1234.ts.net'] });
	assert.equal((await call('/v1/members', { Authorization: 'Bearer secret', Host: 'human.tail1234.ts.net' })).status, 200);
	assert.equal((await call('/v1/members', { Authorization: 'Bearer secret', Host: 'human.tail9999.ts.net' })).status, 403);
	const tailSession = await call('/v1/session', { Authorization: 'Bearer secret', Host: 'human.tail1234.ts.net', 'X-Forwarded-Proto': 'https' }, '');
	assert.match(tailSession.cookie!, /HttpOnly; SameSite=Strict; Secure/, 'tailscale serve 会带 x-forwarded-proto');
	const tailCookie = tailSession.cookie!.split(';')[0]!;
	assert.equal((await call('/v1/members', { Cookie: tailCookie, Origin: 'https://human.tail1234.ts.net', Host: 'human.tail1234.ts.net', 'Content-Type': 'application/json' }, JSON.stringify({ type: 'human', name: '周八' }))).status, 200);
	assert.equal((await call('/v1/members', { Cookie: tailCookie, Origin: 'https://evil.example.com', Host: 'human.tail1234.ts.net', 'Content-Type': 'application/json' }, JSON.stringify({ type: 'human', name: '吴九' }))).status, 403);
	// 链接只给配过的域名
	runtime.tunnel.update({ hostnames: [] });
	assert.equal((await call('/v1/members', { Authorization: 'Bearer secret', Host: 'human.tail1234.ts.net' })).status, 403);
});

test('不用接管的接口：缺成员时 400，终端不在了也照常返回', async t => {
	const runtime = testRuntime(t);
	const server = new RuntimeServer(runtime, 'secret');
	const base = `http://127.0.0.1:${await server.listen()}`;
	t.after(async () => {
		await server.close();
		await runtime.close();
	});
	const post = (body: unknown) => fetch(`${base}/v1/terminals/T_NOPE/decline`, { method: 'POST', headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
	assert.equal((await post({})).status, 400);
	const response = await post({ memberId: 'M_NONE' });
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), {});
});

test('终端上限的设置接口：读默认值、改完立刻生效、越界报错', async t => {
	const directory = temporaryDirectory(t);
	const runtime = testRuntime(t, { terminalSettingsPath: join(directory, 'terminals.json') });
	const server = new RuntimeServer(runtime, 'secret');
	const base = `http://127.0.0.1:${await server.listen()}`;
	t.after(async () => {
		await server.close();
		await runtime.close();
	});
	const limits = async () => (await (await fetch(`${base}/v1/terminals/limits`, { headers: { Authorization: 'Bearer secret' } })).json()) as { limits: { maxAiTerminals: number } };
	const put = (value: number) => fetch(`${base}/v1/terminals/limits`, {
		method: 'PUT', headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' }, body: JSON.stringify({ maxAiTerminals: value }),
	});
	assert.equal((await limits()).limits.maxAiTerminals, 16);
	assert.deepEqual(await (await put(4)).json(), { limits: { maxAiTerminals: 4, problem: null } });
	assert.equal((await limits()).limits.maxAiTerminals, 4);
	runtime.terminals.setMaxAiTerminals(16);
	assert.equal((await put(99)).status, 400);
	assert.equal((await limits()).limits.maxAiTerminals, 16);
});
