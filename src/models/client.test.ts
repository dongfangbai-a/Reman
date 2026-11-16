import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import { OpenAIModelClient, type IModelResponse, type ModelOutputStart } from './client.ts';

/** 本地的流式服务：按顺序发出这些事件，end 时随后正常结束连接（不报错），否则一直挂着。发完调 sent。 */
async function respondWith(
	t: TestContext, events: readonly Record<string, unknown>[], end: boolean, signal = new AbortController().signal, outputs: ModelOutputStart[] = [], sent = () => {},
): Promise<IModelResponse> {
	const server = createServer((_request, response) => {
		response.writeHead(200, { 'content-type': 'text/event-stream' });
		events.forEach((event, index) => response.write(`event: ${String(event['type'])}\ndata: ${JSON.stringify({ ...event, sequence_number: index })}\n\n`));
		if (end) response.end();
		sent();
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	t.after(() => {
		server.closeAllConnections();
		server.close();
	});
	const { port } = server.address() as AddressInfo;
	return new OpenAIModelClient().respond({
		connection: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'test' },
		model: 'test', reasoningEffort: null, promptCacheKey: 'test', input: [], tools: [],
	}, signal, () => {}, output => outputs.push(output));
}

const REASONING = { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: '想一想' }] } };

test('输出了一部分时被中止：按中止报错，不交回半截输出', async t => {
	// 先输出完一段思考，之后不再发，等着被中止。服务发完再计时：openai 包第一次用到时才加载，从调用开始计时可能请求还没发出。
	const controller = new AbortController();
	await assert.rejects(respondWith(t, [REASONING], false, controller.signal, [], () => setTimeout(() => controller.abort(new Error('运行已停止')), 50)), /运行已停止/);
});

test('没收到响应完成就断开：开始输出的每一项都收完了才接受，有一项没收完按中途断开处理', async t => {
	// 有的兼容服务不发响应完成：每一项都收完了就接受。
	const whole = await respondWith(t, [REASONING], true);
	assert.equal(whole.output.length, 1);
	// 思考收完了，正文写到一半连接就正常结束了：不交回只有思考的半截回复。
	const text = [
		{ type: 'response.output_item.added', output_index: 1, item: { type: 'message', id: 'msg_1', role: 'assistant', content: [] } },
		{ type: 'response.output_text.delta', output_index: 1, item_id: 'msg_1', content_index: 0, delta: '写到一半' },
	];
	await assert.rejects(respondWith(t, [REASONING, ...text], true), /模型输出中途断开/);
});

test('开始输出一项时说是思考、文字还是工具调用和工具名；不认识的项不说', async t => {
	const message = { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: '好', annotations: [] }] };
	const call = { type: 'function_call', id: 'fc_1', call_id: 'c1', name: 'write_file', arguments: '{"path":"a.md","content":"很长"}' };
	const search = { type: 'web_search_call', id: 'ws_1', status: 'completed' };
	const outputs: ModelOutputStart[] = [];
	const response = await respondWith(t, [
		{ type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_1', summary: [] } },
		REASONING,
		{ type: 'response.output_item.added', output_index: 1, item: { ...message, content: [] } },
		{ type: 'response.output_text.delta', output_index: 1, item_id: 'msg_1', content_index: 0, delta: '好' },
		{ type: 'response.output_item.done', output_index: 1, item: message },
		{ type: 'response.output_item.added', output_index: 2, item: { ...call, arguments: '' } },
		{ type: 'response.function_call_arguments.delta', output_index: 2, item_id: 'fc_1', delta: call.arguments },
		{ type: 'response.output_item.done', output_index: 2, item: call },
		{ type: 'response.output_item.added', output_index: 3, item: search },
		{ type: 'response.output_item.done', output_index: 3, item: search },
	], true, undefined, outputs);
	assert.equal(response.output.length, 4);
	assert.deepEqual(outputs, [{ type: 'reasoning' }, { type: 'text' }, { type: 'call', name: 'write_file' }]);
});

test('服务返回错误状态：说明里状态码只写一次，没有内容时只写状态码；按状态判断能不能重试', async t => {
	const replies: [number, string][] = [[401, JSON.stringify({ error: { message: 'Incorrect API key provided' } })], [503, '']];
	const server = createServer((_request, response) => {
		const [status, body] = replies.shift()!;
		response.writeHead(status, { 'content-type': 'application/json' });
		response.end(body);
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	t.after(() => {
		server.closeAllConnections();
		server.close();
	});
	const { port } = server.address() as AddressInfo;
	const request = () => new OpenAIModelClient().respond({
		connection: { baseUrl: `http://127.0.0.1:${port}`, apiKey: 'test' },
		model: 'test', reasoningEffort: null, promptCacheKey: 'test', input: [], tools: [],
	}, new AbortController().signal, () => {}, () => {});
	await assert.rejects(request(), { code: 'http_401', message: '模型服务返回 401：Incorrect API key provided', retryable: false });
	await assert.rejects(request(), { code: 'http_503', message: '模型服务返回 503', retryable: true });
});

test('流里报响应失败：原因开头带着状态码的照状态码算能不能重试，没带的能重试', async t => {
	const failed = (message: string) => [{ type: 'response.failed', response: { id: 'r', object: 'response', status: 'failed', output: [], error: { code: 'server_error', message } } }];
	const rejected = '<400> InternalError.Algo.InvalidParameter: This text.format type is unavailable now';
	await assert.rejects(respondWith(t, failed(rejected), true), { code: 'response_failed', message: `模型响应失败：${rejected}`, retryable: false });
	await assert.rejects(respondWith(t, failed('<429> Too many requests'), true), { retryable: true });
	await assert.rejects(respondWith(t, failed('服务繁忙'), true), { retryable: true });
});
