import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { Describer } from '../../runs/describe.ts';
import { addAi, leaveContext, testRuntime } from '../../testing.ts';
import { createSearchHistoryTool, timeBoundary, type ISearchResult } from './searchHistory.ts';

test('查历史：关键词、限定对话和发送者、条数和顺序，包括自己的工具结果', async t => {
	const runtime = testRuntime(t);
	const human = runtime.members.createHuman('张三');
	const host = addAi(runtime, '沈安');
	const alice = addAi(runtime, '陈屿');
	const group = runtime.groups.create(human.memberId, '大厅', [host.memberId, alice.memberId]);
	const groupTarget = { kind: 'group', groupId: group.groupId } as const;
	runtime.messages.send(human.memberId, groupTarget, '今晚谁是狼人？');
	runtime.messages.send(alice.memberId, groupTarget, '我觉得顾宁是狼人', [host.memberId]);
	runtime.messages.send(host.memberId, groupTarget, '天亮了');
	runtime.messages.send(human.memberId, { kind: 'direct', memberId: host.memberId }, '狼人杀规则发你了');
	await sleep(5);
	const runId = runtime.db.run(`INSERT INTO runs (member_id, kind, status, started_at) VALUES (?, 'response', 'completed', 0)`, host.memberId).lastId;
	const requestId = runtime.db.run(`INSERT INTO model_requests (run_id, kind, provider, model, seen_through_item_id, status, started_at) VALUES (?, 'response', 'test', 'fake', 0, 'completed', 0)`, runId).lastId;
	runtime.timeline.appendToolResult(host.memberId, requestId, { callId: 'c1', name: 'shell', output: '狼人.txt', isError: false });
	leaveContext(runtime, host.memberId);

	const search = async (args: object) => (await runtime.tools.call({ memberId: host.memberId, workingDirectory: process.cwd(), signal: new AbortController().signal }, 'search_history', JSON.stringify(args))).output
		.replace(/\(((M|G)_[A-Z0-9]{4})\)/g, '').replace(/\[\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\] /g, '')
		// 开头写一次时区和偏移，这里只看格式。
		.replace(/，时区为 [\w/]+（UTC[+-]\d\d:\d\d）：/, '：');

	assert.deepEqual([
		await search({ keywords: ['狼人'] }),
		await search({ conversation: group.groupId, sender: alice.memberId }),
		await search({ keywords: ['天亮', '规则'], match: 'any', order: 'oldest', limit: 1 }),
		await search({ keywords: ['不存在'] }),
	], [
		[
			'找到 4 条：',
			'工具 shell 的结果：\n狼人.txt',
			'张三 私聊你：\n狼人杀规则发你了',
			'群聊「大厅」 陈屿 点名了你：\n我觉得顾宁是狼人',
			'群聊「大厅」 张三：\n今晚谁是狼人？',
		].join('\n\n'),
		'找到 1 条：\n\n群聊「大厅」 陈屿 点名了你：\n我觉得顾宁是狼人',
		'共找到 2 条，显示前 1 条：\n\n你在群聊「大厅」中发送的消息：\n天亮了',
		'未找到匹配的历史记录。本工具只查找你已看不到原文的早期内容（已被摘要代替或删除的内容），你现在仍能看到原文的内容不会被查找。',
	]);
	await runtime.close();
});

test('查历史分批扫：每批只扫一条消息、一条时间线时，结果和一次扫完一样', async t => {
	const runtime = testRuntime(t);
	const human = runtime.members.createHuman('张三');
	const host = addAi(runtime, '沈安');
	const other = addAi(runtime, '陈屿');
	const group = runtime.groups.create(human.memberId, '大厅', [host.memberId, other.memberId]);
	for (const text of ['狼人一', '平民', '狼人二']) runtime.messages.send(human.memberId, { kind: 'group', groupId: group.groupId }, text);
	// 看不到的消息夹在中间：别人之间的私聊。
	runtime.messages.send(human.memberId, { kind: 'direct', memberId: other.memberId }, '狼人是谁');
	runtime.messages.send(human.memberId, { kind: 'direct', memberId: host.memberId }, '狼人三');
	runtime.timeline.appendUserInput(host.memberId, { text: '狼人四' });
	leaveContext(runtime, host.memberId);
	const context = { memberId: host.memberId, workingDirectory: process.cwd(), signal: new AbortController().signal };
	const whole = runtime.tools.get('search_history')!;
	const batched = createSearchHistoryTool(runtime.messages, runtime.timeline, new Describer(runtime.members, runtime.groups), { messageSpan: 1, timelineItems: 1 });
	for (const args of [{ keywords: ['狼人'] }, { keywords: ['狼人'], order: 'oldest', limit: 2 }, {}, { conversation: group.groupId }]) {
		assert.deepEqual(await batched.execute(context, args), await whole.execute(context, args));
	}
	assert.equal((await batched.execute(context, { keywords: ['狼人'] })).total, 4);
	await runtime.close();
});

test('查历史：每条默认返回全文，合计最多 2.5 万字，放不下的整条不返回并注明；max_chars_per_entry 截取每条；第一条就超过时只截这一条', async t => {
	const runtime = testRuntime(t);
	const human = runtime.members.createHuman('张三');
	const host = addAi(runtime, '沈安');
	const direct = { kind: 'direct', memberId: host.memberId } as const;
	for (const index of [1, 2, 3]) runtime.messages.send(human.memberId, direct, `长文${index} ${'字'.repeat(12_000)}`);
	runtime.messages.send(human.memberId, direct, `超长 ${'字'.repeat(29_000)}`);
	leaveContext(runtime, host.memberId);
	const context = { memberId: host.memberId, workingDirectory: process.cwd(), signal: new AbortController().signal };
	const tool = runtime.tools.get('search_history')!;
	const search = (args: Record<string, unknown>) => tool.execute(context, args) as Promise<ISearchResult>;

	const whole = await search({ keywords: ['长文'] });
	assert.deepEqual([whole.total, whole.entries.length, whole.omitted], [3, 2, 1]);
	assert.ok(whole.entries.every(entry => entry.text.endsWith('字'.repeat(12_000))));
	assert.match(tool.format!(whole) as string, /\n\n（另有 1 条因合计超过 2\.5 万字未返回；.+max_chars_per_entry.+）$/);

	const heads = await search({ keywords: ['长文'], max_chars_per_entry: 10 });
	assert.equal(heads.omitted, 0);
	assert.deepEqual(heads.entries.map(entry => entry.text.split('\n')[1]),[3, 2, 1].map(index => `长文${index} ${'字'.repeat(6)}……（已截断，共 12004 字）`));

	const huge = await search({ keywords: ['超长'] });
	assert.deepEqual([huge.entries.length, huge.omitted], [1, 0]);
	assert.ok(huge.entries[0]!.text.endsWith('……（已截断，共 29003 字）') && huge.entries[0]!.text.length < 25_100);
	await assert.rejects(search({ max_chars_per_entry: 0 }), /max_chars_per_entry 必须是正整数/);
	await runtime.close();
});

const CHICAGO = 'America/Chicago';
const at = (iso: string) => Date.parse(iso);

test('时间范围的一端按给的时区算：开始是这一段的第一刻，结束是最后一刻，省略的秒或时刻算在这一段里', () => {
	assert.equal(timeBoundary('2026-11-05 10:02', false, CHICAGO), at('2026-11-05T16:02:00Z'));
	assert.equal(timeBoundary('2026-11-05 10:02', true, CHICAGO), at('2026-11-05T16:03:00Z') - 1);
	assert.equal(timeBoundary('2026-11-05 10:02:15', true, CHICAGO), at('2026-11-05T16:02:16Z') - 1);
	assert.equal(timeBoundary('2026-11-05', false, 'Asia/Shanghai'), at('2026-11-04T16:00:00Z'));
	assert.equal(timeBoundary('2026-11-05', true, 'Asia/Shanghai'), at('2026-11-05T16:00:00Z') - 1);
	assert.equal(timeBoundary('2026-02-30', false, CHICAGO), undefined);
	assert.equal(timeBoundary('2026-11-05 24:00', false, CHICAGO), undefined);
	assert.equal(timeBoundary('2026/11/05', false, CHICAGO), undefined);
});

test('夏令时：出现两次的时刻开始按第一次、结束按第二次；跳过的时刻开始从切换起、结束到切换前为止；一天按实际长短算', () => {
	// 2026-11-01 两点往回拨到一点，01:30 先按 UTC-05:00 出现一次，再按 UTC-06:00 出现一次。
	assert.equal(timeBoundary('2026-11-01 01:30', false, CHICAGO), at('2026-11-01T06:30:00Z'));
	assert.equal(timeBoundary('2026-11-01 01:30', true, CHICAGO), at('2026-11-01T07:31:00Z') - 1);
	// 这一天有 25 小时。
	assert.equal(timeBoundary('2026-11-01', true, CHICAGO)! - timeBoundary('2026-11-01', false, CHICAGO)!, 25 * 3_600_000 - 1);
	// 2027-03-14 两点往前拨到三点，02:30 不存在，切换在 UTC 08:00。
	assert.equal(timeBoundary('2027-03-14 02:30', false, CHICAGO), at('2027-03-14T08:00:00Z'));
	assert.equal(timeBoundary('2027-03-14 02:30', true, CHICAGO), at('2027-03-14T08:00:00Z') - 1);
	assert.equal(timeBoundary('2027-03-14 03:00', false, CHICAGO), at('2027-03-14T08:00:00Z'));
});

test('查历史按给的时区：结果的时间按它写，开头写一次时区；几条偏移不同时每条带自己的偏移；不认识的时区报错', async t => {
	const runtime = testRuntime(t);
	const human = runtime.members.createHuman('张三');
	const host = addAi(runtime, '沈安');
	const send = (text: string, sentAt: number) => {
		const message = runtime.messages.send(human.memberId, { kind: 'direct', memberId: host.memberId }, text);
		runtime.db.run('UPDATE messages SET sent_at = ? WHERE message_id = ?', sentAt, message.messageId);
	};
	send('第一次一点半', at('2026-11-01T06:30:00Z'));
	send('第二次一点半', at('2026-11-01T07:30:00Z'));
	send('上午十点', at('2026-11-01T16:00:00Z'));
	leaveContext(runtime, host.memberId);
	const context = { memberId: host.memberId, workingDirectory: process.cwd(), signal: new AbortController().signal };
	const search = async (args: object) => (await runtime.tools.call(context, 'search_history', JSON.stringify(args))).output.replace(/\(M_[A-Z0-9]{4}\)/g, '');

	// 01:30 当结束时间也包含第二次的 01:30。
	assert.equal(await search({ start_time: '2026-11-01 01:30', end_time: '2026-11-01 01:30', timezone: CHICAGO, order: 'oldest' }), [
		'找到 2 条，时区为 America/Chicago：',
		'[2026-11-01 01:30:00 UTC-05:00] 张三 私聊你：\n第一次一点半',
		'[2026-11-01 01:30:00 UTC-06:00] 张三 私聊你：\n第二次一点半',
	].join('\n\n'));
	assert.equal(await search({ start_time: '2026-11-01 10:00', end_time: '2026-11-01 10:00', timezone: CHICAGO }),
		'找到 1 条，时区为 America/Chicago（UTC-06:00）：\n\n[2026-11-01 10:00:00] 张三 私聊你：\n上午十点');
	// 同一时刻按别的时区写。
	assert.equal(await search({ start_time: '2026-11-02', end_time: '2026-11-02', timezone: 'Asia/Shanghai' }),
		'找到 1 条，时区为 Asia/Shanghai（UTC+08:00）：\n\n[2026-11-02 00:00:00] 张三 私聊你：\n上午十点');
	const result = await runtime.tools.call(context, 'search_history', JSON.stringify({ timezone: 'Mars/Base' }));
	assert.equal(result.isError, true);
	assert.match(result.output, /无法识别的时区「Mars\/Base」，须为 IANA 时区名/);
	await runtime.close();
});
