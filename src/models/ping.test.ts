import assert from 'node:assert/strict';
import { test } from 'node:test';
import { testModels } from '../testing.ts';
import { ModelError, requestBody, type IModelClient, type IModelRequest, type IModelResponse } from './client.ts';
import { pingModel } from './ping.ts';

/** 假的客户端：记下请求，开始输出时报一次，按给的结果返回或报错。 */
function fakeClient(result: IModelResponse | Error, requests: IModelRequest[] = []): IModelClient {
	return {
		async respond(request, _signal, onDelta, onOutput) {
			requests.push(request);
			if (result instanceof Error) throw result;
			onOutput({ type: 'text' });
			onDelta('text', 'po');
			return result;
		},
	};
}

/** 每次调用往后走 100 毫秒的时钟。 */
function clock(): () => number {
	let time = 0;
	return () => (time += 100);
}

const ref = { provider: 'test', model: 'fake' };

test('测试模型：用已保存的地址和 key 发一次英文的 ping，不带工具、不设思考强度；回了什么、用时和用量都交回', async () => {
	const requests: IModelRequest[] = [];
	const client = fakeClient({
		output: [{ type: 'reasoning', summary: [] }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: ' Pong! ' }] }],
		usage: { inputTokens: 20, cachedTokens: 0, outputTokens: 3 },
	}, requests);
	assert.deepEqual(await pingModel(testModels(), client, ref, 'test-salt', clock()), {
		ok: true, reply: 'Pong!', firstOutputMs: 100, totalMs: 200, usage: { inputTokens: 20, cachedTokens: 0, outputTokens: 3 },
	});
	const [request] = requests;
	// 地址怎么解析一起带过去：不写 endpointMode 时是 auto。
	assert.deepEqual(request?.connection, { baseUrl: 'http://127.0.0.1:1', endpointMode: 'auto', apiKey: 'test' });
	assert.equal(request?.model, 'fake');
	assert.equal(request?.reasoningEffort, null);
	assert.deepEqual(request?.input.map(item => (item as { role: string; content: { text: string }[] })).map(item => `${item.role}: ${item.content[0]!.text}`), [
		'developer: This is a connectivity test. Reply with only: pong', 'user: ping',
	]);
	// 没有工具时请求体里不发工具列表和并行调用的开关；有工具时照常发。
	const body = requestBody(request!);
	assert.equal('tools' in body || 'parallel_tool_calls' in body, false);
	assert.equal('reasoning' in body, false);
	// 输出上限没配就不发；配了就按字段名发出去。
	assert.equal('max_output_tokens' in body, false);
	assert.equal(requestBody({ ...request!, maxOutputTokens: 32_768 })['max_output_tokens'], 32_768);
	const tool = { type: 'function', name: 'x', description: '', parameters: {}, strict: false } as const;
	assert.deepEqual(requestBody({ ...request!, tools: [tool] })['tools'], [tool]);
	assert.equal(requestBody({ ...request!, tools: [tool] })['parallel_tool_calls'], true);
});

test('测试模型：回复里没有文字时 reply 为空；服务没报告开始输出和用量时是 null', async () => {
	const client: IModelClient = { respond: async () => ({ output: [{ type: 'reasoning', summary: [] }], usage: undefined }) };
	assert.deepEqual(await pingModel(testModels(), client, ref, 'test-salt', clock()), { ok: true, reply: '', firstOutputMs: null, totalMs: 100, usage: null });
});

test('测试模型：请求出错、供应商或模型不存在时正常返回原因，不抛出', async () => {
	const failing = fakeClient(new ModelError('http_401', '模型服务返回 401：Incorrect API key', false));
	assert.deepEqual(await pingModel(testModels(), failing, ref, 'test-salt'), { ok: false, error: '模型服务返回 401：Incorrect API key' });
	const unused = fakeClient(new Error('不该请求'));
	assert.deepEqual(await pingModel(testModels(), unused, { provider: 'test', model: 'other' }, 'test-salt'), { ok: false, error: '供应商 test 未添加模型 other' });
	assert.deepEqual(await pingModel(testModels(), unused, { provider: 'nope', model: 'fake' }, 'test-salt'), { ok: false, error: 'models.json 中不存在供应商 nope' });
});
