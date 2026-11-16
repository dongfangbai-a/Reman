import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newId, wrongKind } from './ids.ts';

test('ID 的长度按会有多少个定：成员、群聊、分组 4 位，终端、后台任务、定时、附件 5 位', () => {
	for (const prefix of ['M', 'G', 'L'] as const) assert.match(newId(prefix, () => false), new RegExp(`^${prefix}_[A-HJ-NP-Z2-9]{4}$`));
	for (const prefix of ['T', 'B', 'R', 'A'] as const) assert.match(newId(prefix, () => false), new RegExp(`^${prefix}_[A-HJ-NP-Z2-9]{5}$`));
});

test('生成的 ID 被用过时重新抽；一直撞说明快用满了，报错', () => {
	const tried: string[] = [];
	const id = newId('M', candidate => {
		tried.push(candidate);
		return tried.length < 3;
	});
	assert.equal(tried.length, 3);
	assert.equal(id, tried[2]);
	assert.throws(() => newId('G', () => true), /群聊的 ID 快用满了/);
});

test('给错了类型的 ID 时说明它是什么', () => {
	assert.equal(wrongKind('T_7KQ2M', 'B'), 'T_7KQ2M 是终端，不是后台任务');
	assert.equal(wrongKind('B_7KQ2M', 'B'), undefined);
	assert.equal(wrongKind('X_7KQ2M', 'B'), undefined);
	assert.equal(wrongKind('随便写的', 'B'), undefined);
});
