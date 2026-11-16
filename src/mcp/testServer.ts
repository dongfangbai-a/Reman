/**
 * 测试用的旧版（2025-06-18）stdio MCP 服务器：每行一条 JSON-RPC 消息。
 * 工具：echo（只读）、weather（结构化结果）、picture（返回图片）、fail（返回错误）、env（读环境变量）、add_tool（加一个工具并通知列表变了）、exit（回复后退出进程，像崩溃了）。
 * 环境变量 TEST_CHANNEL 为 1 时是外部事件的来源：声明 claude/channel 能力，emit 工具把给的事件逐个推送出去，stderr 工具把给的文字写到 stderr。
 * 环境变量 TEST_START_LOG 给了文件时，启动时把进程号追加进去，用来数启动了几个进程。
 */
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAABHNCSVQICAgIfAhkiAAAAAFzUkdCAK7OHOkAAAAUSURBVAiZY/zPwPCfgYGBgYkBCgAfFwICvtwYPAAAAABJRU5ErkJggg==';
const text = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] };
const empty = { type: 'object', properties: {} };
const tools: object[] = [
	{ name: 'echo', description: '原样返回文字', inputSchema: text, annotations: { readOnlyHint: true } },
	{
		name: 'weather', description: '查天气', inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
		outputSchema: { type: 'object', properties: { city: { type: 'string' }, temperature: { type: 'number' } }, required: ['city', 'temperature'] },
		annotations: { readOnlyHint: true },
	},
	{ name: 'picture', description: '返回一张图片', inputSchema: empty },
	{ name: 'fail', description: '总是失败', inputSchema: empty },
	{ name: 'env', description: '读环境变量 TEST_VALUE', inputSchema: empty, annotations: { readOnlyHint: true } },
	{ name: 'add_tool', description: '加一个工具', inputSchema: empty },
	{ name: 'exit', description: '回复后退出进程', inputSchema: empty },
];
const channel = process.env['TEST_CHANNEL'] === '1';
if (process.env['TEST_START_LOG']) appendFileSync(process.env['TEST_START_LOG'], `${process.pid}\n`);
if (channel) {
	tools.push(
		{ name: 'emit', description: '推送外部事件', inputSchema: { type: 'object', properties: { events: { type: 'array' } }, required: ['events'] } },
		{ name: 'stderr', description: '把文字写到 stderr', inputSchema: text },
	);
}

function send(message: object): void {
	process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}

function callTool(name: string, args: Record<string, unknown>): object {
	switch (name) {
		case 'echo':
			return { content: [{ type: 'text', text: `回声：${String(args['text'])}` }] };
		case 'weather': {
			const value = { city: String(args['city']), temperature: 21 };
			return { content: [{ type: 'text', text: `${value.city} 21 度` }], structuredContent: value };
		}
		case 'picture':
			return { content: [{ type: 'text', text: '一张图' }, { type: 'image', data: PNG, mimeType: 'image/png' }] };
		case 'fail':
			return { content: [{ type: 'text', text: '出错了' }], isError: true };
		case 'env':
			return { content: [{ type: 'text', text: process.env['TEST_VALUE'] ?? '没有' }] };
		case 'emit':
			for (const params of args['events'] as unknown[]) send({ method: 'notifications/claude/channel', params });
			return { content: [{ type: 'text', text: '推送了' }] };
		case 'stderr':
			process.stderr.write(String(args['text']));
			return { content: [{ type: 'text', text: '写了' }] };
		case 'exit':
			setTimeout(() => process.exit(1), 50);
			return { content: [{ type: 'text', text: '要退出了' }] };
		case 'add_tool':
			tools.push({ name: 'added', description: '新加的工具', inputSchema: empty });
			send({ method: 'notifications/tools/list_changed' });
			return { content: [{ type: 'text', text: '加好了' }] };
		default:
			throw new Error(`没有工具 ${name}`);
	}
}

process.stderr.write('测试服务器启动了\n');
createInterface({ input: process.stdin }).on('line', line => {
	if (!line.trim()) return;
	const message = JSON.parse(line) as { id?: number | string; method?: string; params?: Record<string, any> };
	if (message.id === undefined || !message.method) return;
	const { id, method, params = {} } = message;
	try {
		if (method === 'initialize') {
			send({ id, result: { protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: true }, ...channel ? { experimental: { 'claude/channel': {} } } : {} }, serverInfo: { name: 'test', version: '1' } } });
		} else if (method === 'ping') {
			send({ id, result: {} });
		} else if (method === 'tools/list') {
			send({ id, result: { tools } });
		} else if (method === 'tools/call') {
			send({ id, result: callTool(params['name'], params['arguments'] ?? {}) });
		} else {
			send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
		}
	} catch (error) {
		send({ id, error: { code: -32602, message: error instanceof Error ? error.message : String(error) } });
	}
});
