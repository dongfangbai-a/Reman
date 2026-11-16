import assert from 'node:assert/strict';
import { test } from 'node:test';
import { networkAllows, parseNetwork, serializeNetwork } from './network.ts';

test('网络设置：整理名单，本机地址和写错的项报错', () => {
	assert.deepEqual(parseNetwork({ allow: ['GitHub.com', 'https://registry.npmjs.org/pkg', '192.168.1.10:8080', 'github.com'] }), {
		mode: 'allow', hosts: ['github.com', 'registry.npmjs.org', '192.168.1.10:8080'],
	});
	assert.deepEqual(serializeNetwork(parseNetwork('all')), undefined);
	assert.throws(() => parseNetwork({ deny: ['localhost:5432'] }), /本机地址始终允许连接/);
	assert.throws(() => parseNetwork({ deny: ['*.example.com'] }), /通配符/);
	assert.throws(() => parseNetwork({ allow: 'github.com' }), /字符串数组/);
	assert.throws(() => parseNetwork(true), /只能是/);
});

test('网络设置：子域名、端口、IP 的其他写法，本机地址总是能连', () => {
	const allow = parseNetwork({ allow: ['github.com', '10.0.0.5:8080'] });
	assert.equal(networkAllows(allow, 'api.github.com', 443), true);
	assert.equal(networkAllows(allow, 'notgithub.com', 443), false);
	assert.equal(networkAllows(allow, '10.0.0.5', 8080), true);
	assert.equal(networkAllows(allow, '10.0.0.5', 22), false);
	assert.equal(networkAllows(allow, 'localhost', 5432), true);

	const deny = parseNetwork({ deny: ['169.254.169.254', 'Example.com'] });
	assert.equal(networkAllows(deny, '2852039166', 80), false);
	assert.equal(networkAllows(deny, 'WWW.EXAMPLE.COM.', 443), false);
	assert.equal(networkAllows(deny, 'github.com', 443), true);

	assert.equal(networkAllows(parseNetwork('none'), 'github.com', 443), false);
	assert.equal(networkAllows(parseNetwork('none'), '127.0.0.1', 3000), true);
});
