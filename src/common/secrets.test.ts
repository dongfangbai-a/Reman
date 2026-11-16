import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { temporaryDirectory } from '../testing.ts';
import { isEncrypted, Secrets } from './secrets.ts';

test('配置里的密钥：加密后能解开，每次的密文不同；空值和已加密的不再加密；换了钥匙、改坏了的解不开', () => {
	const secrets = Secrets.temporary();
	const first = secrets.encrypt('令牌-123');
	const second = secrets.encrypt('令牌-123');
	assert.ok(isEncrypted(first) && first.startsWith('enc:v1:'));
	assert.notEqual(first, second);
	assert.equal(secrets.decrypt(first), '令牌-123');
	assert.equal(secrets.encrypt(first), first);
	assert.equal(secrets.encrypt(''), '');
	assert.equal(secrets.decrypt('明文'), '明文');

	assert.equal(Secrets.temporary().decrypt(first), undefined);
	const index = 'enc:v1:'.length + 10;
	assert.equal(secrets.decrypt(`${first.slice(0, index)}${first[index] === 'A' ? 'B' : 'A'}${first.slice(index + 1)}`), undefined);
	assert.equal(secrets.decrypt('enc:v1:abc'), undefined);

	assert.deepEqual(secrets.encryptValues({ a: '', b: first }), undefined);
	const values = secrets.encryptValues({ a: '一', b: first, c: 1 })!;
	assert.deepEqual([secrets.decrypt(values['a'] as string), values['b'], values['c']], ['一', first, 1]);
});

test('配置里的密钥：钥匙第一次用到时生成，之后沿用；文件内容不是钥匙时报错，不覆盖', t => {
	const directory = temporaryDirectory(t);
	const path = join(directory, 'secret-key');
	const encrypted = Secrets.fromFile(path).encrypt('值');
	const saved = readFileSync(path, 'utf8');
	assert.equal(Secrets.fromFile(path).decrypt(encrypted), '值');
	assert.equal(readFileSync(path, 'utf8'), saved);

	writeFileSync(path, '不是钥匙');
	assert.throws(() => Secrets.fromFile(path), /不是有效的密钥文件/);
	assert.equal(readFileSync(path, 'utf8'), '不是钥匙');
});
