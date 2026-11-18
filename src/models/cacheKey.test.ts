import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cacheKeyFor } from './cacheKey.ts';

test('同一个盐和成员，算出来的 key 恒定', () => {
	assert.equal(cacheKeyFor('salt-a', 'M_ABC123'), cacheKeyFor('salt-a', 'M_ABC123'));
});

test('不同数据目录（盐不同）算出来的 key 不同', () => {
	// 成员 ID 在每个运行时都从 M_ 开头重新编号，不同数据目录必然撞名；盐就是用来把它们分开的。
	assert.notEqual(cacheKeyFor('salt-a', 'M_ABC123'), cacheKeyFor('salt-b', 'M_ABC123'));
});

test('同一个数据目录里不同成员的 key 不同', () => {
	assert.notEqual(cacheKeyFor('salt-a', 'M_ABC123'), cacheKeyFor('salt-a', 'M_ABC124'));
});

test('key 不带上游能看懂的成员 ID，长度在上游限的 64 个字符以内', () => {
	const key = cacheKeyFor('salt-a', 'M_ABC123');
	assert.ok(!key.includes('M_ABC123'), key);
	assert.ok(key.length <= 64, key);
	assert.match(key, /^reman-runtime:[0-9a-f]{32}$/);
});
