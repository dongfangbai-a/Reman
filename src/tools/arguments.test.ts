import assert from 'node:assert/strict';
import { test } from 'node:test';
import { temporaryDirectory, testRuntime } from '../testing.ts';
import type { IToolContext } from './tools.ts';

/** 拦在 registry 这一层（工具本身不管参数外的键），所以用运行时里的 tools 试。 */
test('参数里有多余的字段：报错并列出可用参数，工具不执行', async t => {
	const runtime = testRuntime(t);
	t.after(() => runtime.close());

	// 模型写错字段名（把 input 写成 command）走这条：解析阶段就拦下，不会真的动到终端。
	const parsed = runtime.tools.parse('terminal', JSON.stringify({ command: 'echo 不该被执行' }));
	assert.equal(parsed.ok, false);
	assert.match((parsed as { result: { output: string } }).result.output,
		/^没有这个参数：command。terminal 的参数是 terminal_id、input、/);

	// 脚本里调用工具走这条：执行前拦下。
	const tool = runtime.tools.get('terminal');
	assert.ok(tool);
	const context = { memberId: 'M_TEST', workingDirectory: temporaryDirectory(t) } as IToolContext;
	const run = await runtime.tools.runWithValue(tool, context, { command: 'echo 不该被执行' });
	assert.equal(run.result.isError, true);
	assert.match(run.result.output, /没有这个参数：command/);
	assert.equal(run.value, undefined);
});

test('参数名都对时照常放行；没声明参数名的工具不拦', async t => {
	const runtime = testRuntime(t);
	t.after(() => runtime.close());
	assert.equal(runtime.tools.parse('terminal', JSON.stringify({ input: 'echo hi\n' })).ok, true);
	assert.equal(runtime.tools.parse('more_tools', JSON.stringify({ action: 'describe', tool_name: 'view_image' })).ok, true);
});
