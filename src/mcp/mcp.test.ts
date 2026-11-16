import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Secrets } from '../common/secrets.ts';
import type { IModelClient, IModelRequest, IModelResponse } from '../models/client.ts';
import type { Runtime } from '../runtime.ts';
import { addAi, temporaryDirectory, testModels, testRuntime, withoutNumbers } from '../testing.ts';
import type { IModelOutputItem } from '../timeline/timeline.ts';

const SERVER = fileURLToPath(new URL('./testServer.ts', import.meta.url));
const COMMAND = { command: process.execPath, args: ['--disable-warning=ExperimentalWarning', SERVER] };

class FakeModel implements IModelClient {
	readonly requests: IModelRequest[] = [];
	script: IModelOutputItem[][] = [];

	async respond(request: IModelRequest): Promise<IModelResponse> {
		this.requests.push(request);
		await Promise.resolve();
		return { output: this.script[this.requests.length - 1] ?? [], usage: undefined };
	}
}

function call(callId: string, name: string, args: object = {}): IModelOutputItem {
	return { type: 'function_call', call_id: callId, name, arguments: JSON.stringify(args) };
}

/** 等所有服务器连好或失败。 */
async function settled(runtime: Runtime): Promise<void> {
	const deadline = Date.now() + 30_000;
	while (runtime.mcp.snapshot().servers.some(server => server.status === 'connecting')) {
		if (Date.now() > deadline) throw new Error('MCP 服务器一直没连上');
		await new Promise(resolve => setTimeout(resolve, 20));
	}
}

test('MCP：读配置连接服务器，每个服务器是一组工具；成员按服务器启用，只读工具可以不审批；结构化结果、图片和错误', async t => {
	const directory = temporaryDirectory(t);
	const mcpPath = join(directory, 'mcp.json');
	writeFileSync(mcpPath, JSON.stringify({ mcpServers: { demo: { ...COMMAND, env: { TEST_VALUE: '秘密' } }, 'bad name': { command: 'x' }, old: { type: 'sse', url: 'http://x' } } }));
	const model = new FakeModel();
	const runtime = testRuntime(t, { mcpPath, models: testModels([{ model: 'fake', vision: true }]), modelClient: model });
	t.after(() => runtime.close());
	await settled(runtime);

	const snapshot = runtime.mcp.snapshot();
	assert.deepEqual(snapshot.servers.map(server => [server.name, server.status, server.error?.split('\n')[0] ?? null]), [
		['demo', 'connected', null],
		['bad name', 'failed', '配置有误：MCP 服务器名「bad name」只能包含英文字母、数字、横杠和下划线'],
		['old', 'failed', '配置有误：不支持旧版 HTTP+SSE 传输，请改用 Streamable HTTP 地址'],
	]);
	const demo = snapshot.servers[0]!;
	assert.deepEqual([demo.envNames, demo.undecryptableNames], [['TEST_VALUE'], []]);
	assert.equal(JSON.stringify(snapshot).includes('秘密'), false);
	// 明文的值加密后写回文件。
	assert.equal(readFileSync(mcpPath, 'utf8').includes('秘密'), false);
	assert.deepEqual(demo.tools.map(tool => `${tool.toolName}${tool.readOnly ? '（只读）' : ''}`), [
		'demo__echo（只读）', 'demo__weather（只读）', 'demo__picture', 'demo__fail', 'demo__env（只读）', 'demo__add_tool', 'demo__exit',
	]);

	// 没连上过的服务器没有工具，成员页不列。
	assert.deepEqual(runtime.tools.list().filter(tool => tool.mcpServer !== null).map(tool => [tool.mcpServer, tool.withoutTools]), [['demo', false], ['bad name', true], ['old', true]]);

	// 新成员默认不启用 MCP；成员写了不存在的服务器只给警告，写了配置了但还没有工具的服务器不算错。
	const other = addAi(runtime, '林');
	assert.equal(runtime.tools.list(other.memberId).find(tool => tool.name === 'mcp:demo')!.enabled, false);
	const ai = addAi(runtime, '沈安', { tools: ['run_tool_script', 'mcp:demo', 'mcp:missing', 'mcp:old'] });
	const folder = runtime.memberFolders.snapshot().folders.find(item => item.name === '沈安')!;
	assert.deepEqual(folder.issues, ['不存在 MCP 服务器「missing」，无法使用其工具']);
	const entry = runtime.tools.list(ai.memberId).find(tool => tool.name === 'mcp:demo')!;
	assert.deepEqual([entry.enabled, entry.policy, entry.policies, entry.mcpServer], [true, 'ask', ['ask', 'auto', 'allow'], 'demo']);
	assert.throws(() => runtime.tools.setPolicy(ai.memberId, 'demo__echo', 'allow'), /mcp:demo/);
	runtime.tools.setPolicy(ai.memberId, 'mcp:demo', 'auto');

	const approved: string[] = [];
	runtime.events.subscribe(({ event }) => {
		if (event.type !== 'approval.changed') return;
		for (const approval of runtime.approvals.list({ pendingOnly: true })) {
			approved.push(approval.toolName);
			runtime.approvals.approve(approval.approvalId);
		}
	});
	const code = [
		'const weather = await tools.demo__weather({ city: "杭州" });',
		'const result = await tools.demo__echo({ text: "你好" });',
		'console.log(weather.temperature + 1, result.text, (await tools.demo__env({})).text);',
	].join('\n');
	model.script = [
		[call('c1', 'demo__echo', { text: '一' })],
		[call('c2', 'demo__fail')],
		[call('c3', 'demo__picture')],
		[call('c4', 'run_tool_script', { script: code })],
		[call('c5', 'demo__weather', { city: '北京' })],
	];
	runtime.runs.start();
	const human = runtime.members.createHuman('张三');
	runtime.messages.send(human.memberId, { kind: 'direct', memberId: ai.memberId }, '开始');
	await runtime.runs.idle();

	assert.deepEqual(approved, ['demo__fail', 'demo__picture']);
	const outputs = withoutNumbers(model.requests.at(-1)!.input).filter(item => (item as Record<string, unknown>)['type'] === 'function_call_output').map(item => (item as Record<string, unknown>)['output']);
	assert.equal(outputs[0], '回声：一');
	assert.equal(outputs[1], '出错了');
	assert.ok(Array.isArray(outputs[2]) && JSON.stringify(outputs[2]).includes('input_image'));
	const pictureText = (outputs[2] as { type: string; text?: string }[]).find(part => part.type === 'input_text')!.text!;
	const picturePath = /^一张图\n\[图片 1，文件位于 (.+)\]$/.exec(pictureText)?.[1];
	assert.ok(picturePath && existsSync(picturePath), pictureText);
	assert.equal(outputs[3], '22 回声：你好 秘密');
	assert.equal(outputs[4], '北京 21 度');
	const runCode = model.requests[0]!.tools.find(tool => tool.name === 'run_tool_script')!.description;
	assert.match(runCode, /还可调用以下工具.*demo__echo、demo__weather/);
	assert.match(model.requests[0]!.tools.find(tool => tool.name === 'more_tools')!.description, /\n- demo__echo：原样返回文字\n- demo__weather：查天气\n/);
	assert.equal(runtime.tools.get('demo__weather')!.returns, '{\n\tcity: string;\n\ttemperature: number;\n}');
	assert.equal(runtime.tools.get('demo__echo')!.returns, '{ text: string; images: InputImage[] }');
});

test('MCP：服务器通知工具变了时更新；修改配置时空着的环境变量沿用原来的值，新填的加密保存；删除服务器', async t => {
	const directory = temporaryDirectory(t);
	const mcpPath = join(directory, 'mcp.json');
	writeFileSync(mcpPath, JSON.stringify({ other: 1, mcpServers: {} }));
	const secrets = Secrets.temporary();
	const runtime = testRuntime(t, { mcpPath, secrets });
	t.after(() => runtime.close());
	let changes = 0;
	runtime.events.subscribe(({ event }) => event.type === 'mcp.changed' && changes++);

	runtime.mcp.update('demo', { ...COMMAND, env: { TEST_VALUE: '一' } });
	assert.throws(() => runtime.mcp.update('Demo', COMMAND), /仅大小写、横杠或下划线不同/);
	assert.throws(() => runtime.mcp.update('x', { url: 'ftp://x' }), /http/);
	await settled(runtime);
	assert.ok(changes > 0);
	assert.equal(runtime.mcp.snapshot().servers[0]!.status, 'connected');
	assert.ok(runtime.tools.names().configurable.has('mcp:demo'));

	const ai = addAi(runtime, '沈安', { tools: ['mcp:demo'] });
	const tool = (name: string) => runtime.tools.available(ai.memberId).find(item => item.name === name);
	const context = { memberId: ai.memberId, signal: new AbortController().signal } as Parameters<NonNullable<ReturnType<typeof tool>>['execute']>[0];
	await tool('demo__add_tool')!.execute(context, {});
	const deadline = Date.now() + 10_000;
	while (!tool('demo__added') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
	assert.ok(tool('demo__added'));

	const before = JSON.parse(readFileSync(mcpPath, 'utf8')).mcpServers.demo.env.TEST_VALUE as string;
	runtime.mcp.update('demo', { ...COMMAND, env: { TEST_VALUE: null, OTHER: '二' } });
	const saved = JSON.parse(readFileSync(mcpPath, 'utf8'));
	assert.deepEqual(saved, { other: 1, mcpServers: { demo: { ...COMMAND, env: { TEST_VALUE: before, OTHER: saved.mcpServers.demo.env.OTHER } } } });
	assert.deepEqual([secrets.decrypt(before), secrets.decrypt(saved.mcpServers.demo.env.OTHER)], ['一', '二']);
	await settled(runtime);
	assert.deepEqual(await tool('demo__env')!.execute(context, {}), { text: '一', images: [] });

	runtime.mcp.remove('demo');
	assert.deepEqual(JSON.parse(readFileSync(mcpPath, 'utf8')), { other: 1, mcpServers: {} });
	assert.equal(tool('demo__env'), undefined);
	assert.deepEqual(runtime.memberFolders.snapshot().folders.find(item => item.name === '沈安')!.issues, ['不存在 MCP 服务器「demo」，无法使用其工具']);
});

test('MCP：stdio 服务器每次连接只启动一个进程，不为试探协议版本多起一个', async t => {
	const directory = temporaryDirectory(t);
	const starts = join(directory, 'starts.log');
	const mcpPath = join(directory, 'mcp.json');
	writeFileSync(mcpPath, JSON.stringify({ mcpServers: { demo: { ...COMMAND, env: { TEST_START_LOG: starts } } } }));
	const runtime = testRuntime(t, { mcpPath });
	t.after(() => runtime.close());
	await settled(runtime);
	assert.equal(runtime.mcp.snapshot().servers[0]!.status, 'connected');
	assert.equal(readFileSync(starts, 'utf8').trim().split('\n').length, 1);
});

test('MCP：加密保存的值解不开时当作没填，不启动，写明哪些要重新填写；在文件里写上新的明文就能用', async t => {
	const directory = temporaryDirectory(t);
	const starts = join(directory, 'starts.log');
	const mcpPath = join(directory, 'mcp.json');
	const lost = Secrets.temporary().encrypt('旧的');
	writeFileSync(mcpPath, JSON.stringify({ mcpServers: { demo: { ...COMMAND, env: { TEST_VALUE: lost, TEST_START_LOG: starts } } } }));
	const runtime = testRuntime(t, { mcpPath });
	t.after(() => runtime.close());
	await settled(runtime);
	const demo = runtime.mcp.snapshot().servers[0]!;
	assert.deepEqual([demo.status, demo.error, demo.undecryptableNames], ['failed', 'TEST_VALUE 已加密保存，但无法用当前数据目录的密钥解密，须重新填写', ['TEST_VALUE']]);
	assert.equal(existsSync(starts), false);
	// 解不开的值不自动清掉。
	assert.equal(JSON.parse(readFileSync(mcpPath, 'utf8')).mcpServers.demo.env.TEST_VALUE, lost);

	const config = JSON.parse(readFileSync(mcpPath, 'utf8'));
	config.mcpServers.demo.env.TEST_VALUE = '新的';
	writeFileSync(mcpPath, JSON.stringify(config));
	runtime.mcp.reload();
	await settled(runtime);
	assert.deepEqual([runtime.mcp.snapshot().servers[0]!.status, runtime.mcp.snapshot().servers[0]!.undecryptableNames], ['connected', []]);
	assert.equal(readFileSync(mcpPath, 'utf8').includes('新的'), false);
	const ai = addAi(runtime, '沈安', { tools: ['mcp:demo'] });
	const env = runtime.tools.available(ai.memberId).find(tool => tool.name === 'demo__env')!;
	const context = { memberId: ai.memberId, signal: new AbortController().signal } as Parameters<typeof env.execute>[0];
	assert.deepEqual(await env.execute(context, {}), { text: '新的', images: [] });
});
