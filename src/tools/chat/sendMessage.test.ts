import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addAi, testRuntime } from '../../testing.ts';

test('发到群聊的结果只写点名了谁：具体成员、所有人、没有点名；发给谁不再写一遍', async t => {
	const runtime = testRuntime(t);
	const human = runtime.members.createHuman('张三');
	const host = addAi(runtime, '安和');
	const player = addAi(runtime, '北辰');
	const group = runtime.groups.create(host.memberId, '大群', [human.memberId, player.memberId]);
	const send = async (args: object) => (await runtime.tools.call(
		{ memberId: host.memberId, workingDirectory: process.cwd(), signal: new AbortController().signal }, 'send_message', JSON.stringify({ target: group.groupId, ...args }),
	)).output.replace(/\(((M|G)_[A-Z0-9]{4})\)/g, '');

	assert.deepEqual([
		await send({ text: '北辰，请发言。', mentions: [player.memberId] }),
		await send({ text: '请两位都说一下', mentions: [player.memberId, human.memberId] }),
		await send({ text: '天亮了', mentions: ['all'] }),
		await send({ text: '北辰，请发言。' }),
	], [
		'已发送，点名了北辰',
		'已发送，点名了北辰、张三',
		'已发送，点名了所有人',
		'已发送，未点名',
	]);
	await runtime.close();
});
