import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { Secrets } from '../common/secrets.ts';
import { addAi, temporaryDirectory, testRuntime } from '../testing.ts';
import type { IModelClient, IModelRequest, IModelResponse } from './client.ts';
import { ModelConfig } from './config.ts';
import { fetchUpstreamModels } from './upstream.ts';

class FakeModel implements IModelClient {
	readonly requests: IModelRequest[] = [];

	async respond(request: IModelRequest): Promise<IModelResponse> {
		this.requests.push(request);
		return { output: [], usage: undefined };
	}
}

test('多个供应商：成员按供应商用对应的地址和 key；修改配置不给 key 时沿用原来的，列表里不返回 key', async t => {
	let stored: unknown = {
		defaultModel: { provider: 'first', model: 'a' },
		providers: [
			{ id: 'first', baseUrl: 'http://first.test', apiKey: 'key-first-0000000', models: [{ model: 'a' }] },
			{ id: 'second', name: '第二家', baseUrl: 'http://second.test', apiKey: 'key-second', models: [{ model: 'b', contextWindow: 200_000 }] },
		],
	};
	const config = new ModelConfig(() => stored, value => stored = value);
	const model = new FakeModel();
	const runtime = testRuntime(t, { models: config, modelClient: model });
	const human = runtime.members.createHuman('张三');
	const host = addAi(runtime, '沈安');
	const guest = addAi(runtime, '陈屿', { model: { provider: 'second', name: 'b' } });
	runtime.runs.start();
	runtime.messages.send(human.memberId, { kind: 'direct', memberId: host.memberId }, '你好');
	await runtime.runs.idle();
	runtime.messages.send(human.memberId, { kind: 'direct', memberId: guest.memberId }, '你好');
	await runtime.runs.idle();
	assert.deepEqual(model.requests.map(request => [request.connection.baseUrl, request.connection.apiKey, request.model]), [
		['http://first.test', 'key-first-0000000', 'a'],
		['http://second.test', 'key-second', 'b'],
	]);

	assert.throws(() => config.update({ defaultModel: { provider: 'second', model: 'b' }, providers: [] }), /默认模型不存在/);
	const list = config.update({
		defaultModel: { provider: 'first', model: 'a' },
		providers: [{ id: 'first', baseUrl: 'http://first.test', models: [{ model: 'a', vision: true }] }],
	});
	assert.deepEqual(list.providers.map(provider => [provider.id, provider.apiKey]), [['first', { preview: '…0000', undecryptable: false }]]);
	assert.equal(config.resolve(null).provider.apiKey, 'key-first-0000000');
	assert.throws(() => config.update({ providers: [{ id: 'new', baseUrl: 'http://new.test', models: [] }] }), /apiKey 不能为空/);
	await runtime.close();
});

test('key 加密保存：读到明文的 key 加密写回，用的时候解密；换了钥匙时解不开，列表标出来，用到时报错，修改时原样留着；文件开头有 BOM 也能读', t => {
	const directory = temporaryDirectory(t);
	const path = join(directory, 'models.json');
	const secrets = Secrets.temporary();
	const providers = [
		{ id: 'first', baseUrl: 'http://first.test', apiKey: 'key-first-0000000', models: [{ model: 'a' }] },
		{ id: 'second', baseUrl: 'http://second.test', apiKey: 'key-second', models: [{ model: 'b' }] },
	];
	writeFileSync(path, `\uFEFF${JSON.stringify({ defaultModel: { provider: 'first', model: 'a' }, providers })}`);
	const config = ModelConfig.fromFile(path, secrets);
	assert.equal(config.resolve(null).provider.apiKey, 'key-first-0000000');
	const stored = () => (JSON.parse(readFileSync(path, 'utf8')) as { providers: { apiKey: string }[] }).providers.map(provider => provider.apiKey);
	const [first, second] = stored();
	assert.ok(first!.startsWith('enc:v1:') && second!.startsWith('enc:v1:'));
	assert.equal(secrets.decrypt(first!), 'key-first-0000000');
	assert.equal(config.list().providers[0]!.apiKey.preview, '…0000');

	// 网页端换了 key：加密后保存；没给 key 的沿用原来的密文。
	config.update({ defaultModel: { provider: 'first', model: 'a' }, providers: [{ ...providers[0], apiKey: 'key-new-11111111' }, { ...providers[1], apiKey: undefined }] });
	assert.equal(secrets.decrypt(stored()[0]!), 'key-new-11111111');
	assert.equal(stored()[1], second);

	// 换了钥匙：解不开的当作没填。
	const other = ModelConfig.fromFile(path, Secrets.temporary());
	assert.deepEqual(other.list().providers.map(provider => provider.apiKey), [
		{ preview: '', undecryptable: true },
		{ preview: '', undecryptable: true },
	]);
	assert.throws(() => other.resolve(null), /供应商 first 的 key 已加密保存，但无法用当前数据目录的密钥解密，须重新填写/);
	assert.throws(() => other.provider('second'), /须重新填写/);
	other.update({ defaultModel: { provider: 'first', model: 'a' }, providers: [{ ...providers[0], apiKey: 'key-again-2222222' }, { ...providers[1], apiKey: undefined }] });
	assert.equal(other.resolve(null).provider.apiKey, 'key-again-2222222');
	assert.equal(stored()[1], second);
	assert.equal(secrets.decrypt(stored()[1]!), 'key-second');
});

test('没有 models.json 时没有供应商，第一次保存时写出文件', t => {
	const config = ModelConfig.fromFile(join(temporaryDirectory(t), 'models.json'), Secrets.temporary());
	assert.deepEqual(config.list(), { defaultModel: undefined, providers: [], error: undefined });
	config.update({ providers: [{ id: 'first', baseUrl: 'http://first.test', apiKey: 'key-first-0000000', models: [] }] });
	assert.deepEqual(config.list().providers.map(provider => provider.id), ['first']);
});

test('拉取上游模型列表：带上 key，认出上下文长度和看图能力，标出已经添加的', async t => {
	let authorization: string | undefined;
	const server = createServer((request, response) => {
		authorization = request.headers.authorization;
		response.writeHead(200, { 'Content-Type': 'application/json' });
		response.end(JSON.stringify({
			object: 'list',
			data: [
				{ id: 'plain', object: 'model', owned_by: 'x' },
				{ id: 'rich', context_length: 131072, architecture: { input_modalities: ['text', 'image'] } },
			],
		}));
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	t.after(() => server.close());
	const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const models = await fetchUpstreamModels({ id: 'local', name: 'local', baseUrl, apiKey: 'secret', models: [{ model: 'plain', displayName: 'plain', contextWindow: undefined, maxOutputTokens: undefined, vision: false }] });
	assert.equal(authorization, 'Bearer secret');
	assert.deepEqual(models, [
		{ model: 'plain', contextWindow: undefined, vision: undefined, added: true },
		{ model: 'rich', contextWindow: 131072, vision: true, added: false },
	]);
});
test('模型可以写输出上限：请求里带上 max_output_tokens；写错了是配置错误', async t => {
	let stored: unknown = {
		defaultModel: { provider: 'only', model: 'a' },
		providers: [{
			id: 'only', baseUrl: 'http://only.test', apiKey: 'key-only-000000',
			models: [{ model: 'a', contextWindow: 285_000, maxOutputTokens: 32_768 }],
		}],
	};
	const config = new ModelConfig(() => stored, value => stored = value);
	const model = new FakeModel();
	const runtime = testRuntime(t, { models: config, modelClient: model });
	const human = runtime.members.createHuman('张三');
	const ai = addAi(runtime, '沈安');
	runtime.runs.start();
	runtime.messages.send(human.memberId, { kind: 'direct', memberId: ai.memberId }, '你好');
	await runtime.runs.idle();
	assert.equal(model.requests[0]?.maxOutputTokens, 32_768);

	assert.throws(
		() => config.update({ providers: [{ id: 'only', baseUrl: 'http://only.test', models: [{ model: 'a', maxOutputTokens: 0 }] }] }),
		/maxOutputTokens 必须是正整数/,
	);
});
