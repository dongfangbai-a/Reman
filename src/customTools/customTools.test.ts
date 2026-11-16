import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { addAi, temporaryDirectory, testModels, testRuntime } from '../testing.ts';

/** 1×1 的 png。 */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

function writeTool(root: string, name: string, definition: object, scripts: Record<string, string>): void {
	mkdirSync(join(root, name), { recursive: true });
	writeFileSync(join(root, name, 'tool.json'), JSON.stringify(definition));
	for (const [file, content] of Object.entries(scripts)) writeFileSync(join(root, name, file), content);
}

const ECHO = {
	label: '回显',
	defaultPolicy: 'allow',
	config: [
		{ name: 'service', type: 'service', label: '服务', required: true },
		{ name: 'model', type: 'text', label: '模型名', required: true },
		{ name: 'token', type: 'secret', label: '令牌' },
	],
	tools: [{
		name: 'echo_args', label: '回显参数', description: '回显', script: 'echo.mjs', returns: '{ text: string; config: unknown }',
		parameters: { type: 'object', properties: { text: { type: 'string' } } },
	}],
};

// 把收到的参数和配置写回去，带一张图片和结构化结果。
const ECHO_SCRIPT = `
let input = '';
for await (const chunk of process.stdin) input += chunk;
const { arguments: args, config } = JSON.parse(input);
process.stdout.write(JSON.stringify({
	content: [{ type: 'text', text: args.text + ' ' + config.model + ' ' + config.service.baseUrl + ' ' + config.service.apiKey }, { type: 'image', data: '${PNG}', mimeType: 'image/png' }],
	structuredContent: { text: args.text, config },
}));
`;

test('自定义工具：未配置、停用时成员照常有这些工具，调用时返回原因；填好配置后能调用，脚本拿到参数和配置，结果的文字、图片和结构化结果照 MCP 的方式交出', async t => {
	const builtin = temporaryDirectory(t);
	writeTool(builtin, 'echo', ECHO, { 'echo.mjs': ECHO_SCRIPT });
	const runtime = testRuntime(t, { models: testModels(), builtinCustomToolsDirectory: builtin });
	const ai = addAi(runtime, '沈安', { tools: ['custom:echo'] });
	const info = () => runtime.tools.list(ai.memberId).find(tool => tool.name === 'custom:echo')!;
	assert.equal(info().customTool?.problem, '缺少服务、模型名');
	assert.deepEqual(info().policies, ['ask', 'allow']);
	assert.equal(info().policy, 'allow');
	assert.ok(runtime.tools.available(ai.memberId).some(tool => tool.name === 'echo_args'));
	const context = { memberId: ai.memberId, workingDirectory: process.cwd(), signal: new AbortController().signal };
	const call = (text: string) => runtime.tools.call(context, 'echo_args', JSON.stringify({ text }));
	assert.deepEqual(await call('你好'), { output: '自定义工具 echo 不可用：缺少服务、模型名', isError: true });

	// 不全也能保存。
	runtime.customTools.setConfig('echo', { model: 'm1' });
	assert.equal(info().customTool?.problem, '缺少服务');
	runtime.customTools.setConfig('echo', { model: 'm1', service: { provider: 'test' }, token: 'secret-value' });
	assert.equal(info().customTool?.problem, null);
	const snapshot = runtime.customTools.snapshot().tools[0]!;
	assert.deepEqual(snapshot.values['token'], { type: 'secret', key: { set: true, undecryptable: false } });
	assert.deepEqual(snapshot.values['service'], { type: 'service', provider: 'test', baseUrl: null, key: { set: false, undecryptable: false } });

	// 停用后照常有这个工具，调用返回已停用；启用后配置还在。
	runtime.customTools.setDisabled('echo', true);
	assert.equal(info().customTool?.disabled, true);
	assert.ok(runtime.tools.available(ai.memberId).some(tool => tool.name === 'echo_args'));
	assert.deepEqual(await call('你好'), { output: '自定义工具 echo 已停用', isError: true });
	runtime.customTools.setDisabled('echo', false);

	const result = await call('你好');
	assert.equal(result.isError, false);
	assert.match(result.output, /^你好 m1 http:\/\/127\.0\.0\.1:1 test\n\[图片 1，文件位于 .+\.png\]$/);
	assert.equal(result.images?.length, 1);
	const tool = runtime.tools.get('echo_args')!;
	const value = await tool.execute(context, { text: '脚本' }) as { text: string; config: { token: string } };
	assert.equal(value.text, '脚本');
	assert.equal(value.config.token, 'secret-value');

	// 不给 key 时沿用原来的；改成单独填的地址和 key。
	runtime.customTools.setConfig('echo', { model: 'm2', service: { baseUrl: 'https://example.com', apiKey: 'k2' }, token: null });
	assert.match((await runtime.tools.call(context, 'echo_args', JSON.stringify({ text: '再来' }))).output, /^再来 m2 https:\/\/example\.com k2\n/);
	assert.equal((await tool.execute(context, {}) as { config: { token: string } }).config.token, 'secret-value');
});

test('自定义工具：新成员默认不启用，审批方式按 tool.json；默认设置能改，改之前把还在用默认值的成员固定下来', async t => {
	const builtin = temporaryDirectory(t);
	writeTool(builtin, 'echo', ECHO, { 'echo.mjs': ECHO_SCRIPT });
	const toolDefaultsPath = join(temporaryDirectory(t), 'tool-defaults.json');
	const runtime = testRuntime(t, { models: testModels(), builtinCustomToolsDirectory: builtin, toolDefaultsPath });
	const ai = addAi(runtime, '沈安');
	const info = (memberId?: string) => runtime.tools.list(memberId).find(tool => tool.name === 'custom:echo')!;
	assert.deepEqual([info().enabled, info().policy], [false, 'allow']);

	runtime.setToolDefault('custom:echo', { enabled: true, policy: 'ask' });
	assert.deepEqual([info().enabled, info().policy], [true, 'ask']);
	assert.ok(runtime.tools.defaultEnabledNames().includes('custom:echo'));
	assert.deepEqual(JSON.parse(readFileSync(toolDefaultsPath, 'utf8')), { 'custom:echo': { enabled: true, policy: 'ask' } });
	// 已有成员照旧。
	assert.deepEqual([info(ai.memberId).enabled, info(ai.memberId).policy], [false, 'allow']);

	runtime.setToolDefault('custom:echo', { enabled: false, policy: 'allow' });
	assert.deepEqual(JSON.parse(readFileSync(toolDefaultsPath, 'utf8')), {});
});

// 先写收到的存文件目录建好没有，再写 3 万字和 12 张图片。
const BIG_SCRIPT = `
import { existsSync } from 'node:fs';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const { outputDirectory } = JSON.parse(input);
const text = '目录：' + outputDirectory + (existsSync(outputDirectory) ? '，已建好' : '，不存在') + '\\n' + '头'.repeat(15000) + '中'.repeat(10000) + '尾'.repeat(5000);
const image = { type: 'image', data: '${PNG}', mimeType: 'image/png' };
process.stdout.write(JSON.stringify({ content: [{ type: 'text', text }, ...Array(12).fill(image)] }));
`;

test('自定义工具：脚本收到建好的存文件目录；直接调用时文字超过 2 万字保留开头和结尾，完整内容存成文件；图片最多附 10 张', async t => {
	const builtin = temporaryDirectory(t);
	const big = { label: '大结果', tools: [{ name: 'big_result', label: '返回大结果', description: '返回大结果', script: 'big.mjs', parameters: { type: 'object' } }] };
	writeTool(builtin, 'big_result', big, { 'big.mjs': BIG_SCRIPT });
	const outputs = join(temporaryDirectory(t), 'tool-outputs');
	const runtime = testRuntime(t, { builtinCustomToolsDirectory: builtin, toolOutputsDirectory: outputs });
	const context = { memberId: addAi(runtime, '沈安').memberId, workingDirectory: process.cwd(), signal: new AbortController().signal };
	const result = await runtime.tools.call(context, 'big_result', '{}');
	assert.equal(result.isError, false);
	assert.equal(result.images?.length, 10);
	const directory = join(outputs, 'custom', 'big_result');
	assert.ok(result.output.startsWith(`目录：${directory}，已建好\n${'头'.repeat(100)}`));
	assert.match(result.output, /\[图片 11，文件位于 .+\.png，未附上\]/);
	assert.match(result.output, /\[最多附上 10 张图片，另有 2 张未附上，需要时可用 view_image 查看\]$/);
	const path = /……（中间省略 \d+ 字，完整内容已保存到 (.+)）……/.exec(result.output)?.[1] ?? '';
	assert.ok(path.startsWith(directory));
	assert.ok(readFileSync(path, 'utf8').includes('中'.repeat(10000)));
	assert.ok(result.output.length < 21_000);
});

test('自定义工具：structuredContent 不是对象时返回格式错误；Windows 上 command 能执行 .cmd，脚本在其他盘符时不加载', async t => {
	const builtin = temporaryDirectory(t);
	const nullStructured = { label: '空结构', tools: [{ name: 'null_structured', label: '空结构', description: '空结构', script: 'a.mjs', returns: '{}', parameters: { type: 'object' } }] };
	writeTool(builtin, 'null_structured', nullStructured, { 'a.mjs': 'process.stdout.write(JSON.stringify({ content: [{ type: "text", text: "文字" }], structuredContent: null }));' });
	writeTool(builtin, 'run_cmd', { label: '批处理', tools: [{ name: 'run_cmd', label: '批处理', description: '批处理', command: ['run.cmd', 'a b'], parameters: { type: 'object' } }] }, {
		'run.cmd': '@echo {"content":[{"type":"text","text":"cmd %~1"}]}\r\n',
	});
	writeTool(builtin, 'other_drive', { label: '其他盘', tools: [{ name: 'other_drive', label: '其他盘', description: '其他盘', script: 'Z:/x/evil.js', parameters: { type: 'object' } }] }, {});
	const runtime = testRuntime(t, { builtinCustomToolsDirectory: builtin });
	const context = { memberId: addAi(runtime, '沈安').memberId, workingDirectory: process.cwd(), signal: new AbortController().signal };
	assert.deepEqual(await runtime.tools.call(context, 'null_structured', '{}'), { output: '自定义工具 null_structured 出错：structuredContent 须为对象或数组', isError: true });
	if (process.platform !== 'win32') return;
	assert.deepEqual(await runtime.tools.call(context, 'run_cmd', '{}'), { output: 'cmd a b', isError: false });
	assert.deepEqual(runtime.customTools.snapshot().issues.map(issue => [issue.name, issue.message]), [['other_drive', 'tools[0].script 须位于工具文件夹内']]);
});

test('自定义工具：数据目录里同名的覆盖内置的；读不出来的、工具名和内置工具重名的不加载；写了 progressive 的是渐进式工具；脚本出错时附上标准错误', async t => {
	const builtin = temporaryDirectory(t);
	writeTool(builtin, 'echo', ECHO, { 'echo.mjs': ECHO_SCRIPT });
	const runtime = testRuntime(t, { models: testModels(), builtinCustomToolsDirectory: builtin });
	const own = runtime.customTools.directory!;
	const fails = { label: '出错', tools: [{ name: 'always_fail', label: '出错', description: '出错', script: 'fail.mjs', parameters: { type: 'object' }, progressive: true }] };
	writeTool(own, 'echo', fails, { 'fail.mjs': 'console.error("第一行\\n出错的原因"); process.exit(2);' });
	writeTool(own, 'broken', { label: '坏的', tools: [] }, {});
	writeTool(own, 'clash', { label: '重名', tools: [{ name: 'shell', label: '重名', description: '重名', script: 'a.mjs', parameters: { type: 'object' } }] }, { 'a.mjs': '' });
	runtime.customTools.reload();
	const snapshot = runtime.customTools.snapshot();
	assert.deepEqual(snapshot.tools.map(tool => [tool.name, tool.origin, tool.overridesBuiltin]), [['echo', 'own', true]]);
	assert.deepEqual(snapshot.issues.map(issue => [issue.name, issue.message]), [
		['broken', 'tools 必须是非空数组'],
		['clash', '工具名 shell 与内置工具重名'],
	]);

	const ai = addAi(runtime, '沈安', { tools: ['custom:echo'] });
	const names = runtime.tools.definitions(ai.memberId).map(tool => tool.name);
	assert.ok(!names.includes('always_fail') && names.includes('more_tools'));
	const context = { memberId: ai.memberId, workingDirectory: process.cwd(), signal: new AbortController().signal };
	const result = await runtime.tools.call(context, 'always_fail', '{}');
	assert.equal(result.isError, true);
	assert.equal(result.output, '自定义工具 always_fail 出错：退出码 2\n标准错误的最后几行：\n第一行\n出错的原因');
});
