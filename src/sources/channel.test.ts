import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { addAi, temporaryDirectory, testRuntime } from '../testing.ts';

const CHANNEL = new URL('./channel.ts', import.meta.url).href;

test('来源的工具：声明了 claude/channel 的服务器同时提供工具，参数按 JSON Schema 检查，出错时返回错误', async t => {
	const directory = temporaryDirectory(t);
	const script = join(directory, 'demo.ts');
	writeFileSync(script, `import { Channel } from '${CHANNEL}';
const channel = new Channel('demo', [{
	name: 'reply', description: '回复', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
	call: async args => { if (args.text === '坏') throw new Error('发不出去'); return '已发送：' + args.text; },
}]);
await channel.start();
`);
	const mcpPath = join(directory, 'mcp.json');
	writeFileSync(mcpPath, JSON.stringify({ mcpServers: { demo: { command: process.execPath, args: ['--disable-warning=ExperimentalWarning', script] } } }));
	const runtime = testRuntime(t, { mcpPath });
	t.after(() => runtime.close());
	const ai = addAi(runtime, '沈安', { tools: ['mcp:demo'] });
	const deadline = Date.now() + 30_000;
	while (runtime.mcp.snapshot().servers[0]?.status === 'connecting') {
		if (Date.now() > deadline) throw new Error('一直没连上');
		await new Promise(resolve => setTimeout(resolve, 20));
	}
	const call = async (args: object) => (await runtime.tools.call({ memberId: ai.memberId, workingDirectory: '.', signal: new AbortController().signal }, 'demo__reply', JSON.stringify(args))).output;

	assert.equal(await call({ text: '你好' }), '已发送：你好');
	assert.match(String(await call({ text: '坏' })), /发不出去/);
	assert.match(String(await call({ text: 1 })), /text/);
	const info = runtime.mcp.snapshot().servers[0]!;
	assert.deepEqual([info.channel, info.tools.map(tool => tool.name)], [true, ['reply']]);
});
