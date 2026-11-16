import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apiEndpoint, modelsEndpoint } from './endpoint.ts';

/**
 * 两种模式：auto 按 OpenAI 的约定补，exact 一个字符都不动。
 * 地址末尾的斜杠不算地址的一部分，去掉再比。
 */
const cases: readonly { readonly url: string; readonly auto: string; readonly exact: string }[] = [
	{ url: 'https://host', auto: 'https://host/v1/responses', exact: 'https://host' },
	{ url: 'https://host/', auto: 'https://host/v1/responses', exact: 'https://host' },
	{ url: 'https://host:8443', auto: 'https://host:8443/v1/responses', exact: 'https://host:8443' },
	{ url: 'https://host/v1', auto: 'https://host/v1/responses', exact: 'https://host/v1' },
	{ url: 'https://host/v1/', auto: 'https://host/v1/responses', exact: 'https://host/v1' },
	{ url: 'https://host/V1', auto: 'https://host/V1/responses', exact: 'https://host/V1' },
	{ url: 'https://host/v2', auto: 'https://host/v2/responses', exact: 'https://host/v2' },
	{ url: 'https://host/v1beta', auto: 'https://host/v1beta/responses', exact: 'https://host/v1beta' },
	{ url: 'https://host/api/v1beta', auto: 'https://host/api/v1beta/responses', exact: 'https://host/api/v1beta' },
	{ url: 'https://host/api/openai', auto: 'https://host/api/openai', exact: 'https://host/api/openai' },
	{ url: 'https://host/api/v1', auto: 'https://host/api/v1/responses', exact: 'https://host/api/v1' },
	{ url: 'https://host/api/v1/responses', auto: 'https://host/api/v1/responses', exact: 'https://host/api/v1/responses' },
	{ url: 'https://host/openai/responses', auto: 'https://host/openai/responses', exact: 'https://host/openai/responses' },
];

test('回复接口的地址：域名和版本段自动补，完整地址原样', () => {
	for (const item of cases) {
		assert.equal(apiEndpoint(item.url, 'auto'), item.auto, `auto ${item.url}`);
		assert.equal(apiEndpoint(item.url, 'exact'), item.exact, `exact ${item.url}`);
		// 不写模式按 auto 算：老配置里没有这个字段。
		assert.equal(apiEndpoint(item.url), item.auto, `默认 ${item.url}`);
	}
});

test('模型列表的地址和回复接口同一个前缀：把末尾的 /responses 换成 /models', () => {
	assert.equal(modelsEndpoint('https://host'), 'https://host/v1/models');
	assert.equal(modelsEndpoint('https://host/v1'), 'https://host/v1/models');
	assert.equal(modelsEndpoint('https://host/api/v1/responses'), 'https://host/api/v1/models');
	assert.equal(modelsEndpoint('https://host/api/openai', 'exact'), 'https://host/api/openai/models');
});

test('地址里带查询或锚点时算不出来：那是填错了，不该悄悄丢掉', () => {
	assert.throws(() => apiEndpoint('https://host/v1?key=1'), /查询或锚点/);
	assert.throws(() => apiEndpoint('https://host/v1#top'), /查询或锚点/);
});
