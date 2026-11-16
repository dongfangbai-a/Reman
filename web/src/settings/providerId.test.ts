import assert from 'node:assert/strict';
import { test } from 'node:test';
import { suggestProviderId } from './providerId.ts';

test('标识取域名的主体，跳过 api 这类前缀和 com.cn 这类后缀', () => {
	const none = new Set<string>();
	assert.equal(suggestProviderId('https://api.deepseek.com', none), 'deepseek');
	assert.equal(suggestProviderId('https://open.bigmodel.cn/api/paas', none), 'bigmodel');
	assert.equal(suggestProviderId('https://api.example.com.cn', none), 'example');
	assert.equal(suggestProviderId(' https://API.Moonshot.cn/ ', none), 'moonshot');
});

test('IP 地址、本机、没写完的地址和只剩通用前缀的域名取不出标识', () => {
	const none = new Set<string>();
	for (const url of ['http://192.168.9.102:18450', 'http://localhost:8080', 'http://[::1]:8080', 'https://', 'api.deepseek', 'https://api.com']) {
		assert.equal(suggestProviderId(url, none), '', url);
	}
});

test('标识重名时加数字', () => {
	assert.equal(suggestProviderId('https://api.deepseek.com', new Set(['deepseek'])), 'deepseek-2');
	assert.equal(suggestProviderId('https://api.deepseek.com', new Set(['deepseek', 'deepseek-2'])), 'deepseek-3');
});
