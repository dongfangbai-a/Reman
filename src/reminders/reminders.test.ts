import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatDuration, toInstant } from '../common/time.ts';
import type { IModelClient, IModelRequest, IModelResponse } from '../models/client.ts';
import { Describer } from '../runs/describe.ts';
import { addAi, testModels, testRuntime } from '../testing.ts';
import type { IModelOutputItem } from '../timeline/timeline.ts';
import { createManageRemindersTool } from '../tools/work/manageReminders.ts';
import { Reminders } from './reminders.ts';

const CHICAGO = 'America/Chicago';

class FakeModel implements IModelClient {
	readonly requests: IModelRequest[] = [];
	script: IModelOutputItem[][] = [];

	async respond(request: IModelRequest): Promise<IModelResponse> {
		this.requests.push(request);
		await Promise.resolve();
		return { output: this.script[this.requests.length - 1] ?? [], usage: undefined };
	}
}

function call(callId: string, name: string, args: object = {}): IModelOutputItem {
	return { type: 'function_call', call_id: callId, name, arguments: JSON.stringify(args) };
}

test('时区换算：夏令时开始那天不存在的时刻往后顺延，结束那天出现两次的时刻用第一次；时刻可以带秒', () => {
	assert.equal(toInstant({ year: 2026, month: 11, day: 2, hour: 6, minute: 0, second: 0 }, 'Asia/Shanghai'), Date.UTC(2026, 10, 1, 22, 0));
	assert.equal(toInstant({ year: 2026, month: 7, day: 1, hour: 7, minute: 0, second: 0 }, CHICAGO), Date.UTC(2026, 6, 1, 12, 0));
	assert.equal(toInstant({ year: 2026, month: 1, day: 1, hour: 7, minute: 0, second: 0 }, CHICAGO), Date.UTC(2026, 0, 1, 13, 0));
	// 2026-03-08 02:00 芝加哥拨快到 03:00，02:30 不存在，顺延到 03:30（CDT）。
	assert.equal(toInstant({ year: 2026, month: 3, day: 8, hour: 2, minute: 30, second: 0 }, CHICAGO), Date.UTC(2026, 2, 8, 8, 30));
	// 2026-11-01 02:00 芝加哥拨回 01:00，01:30 出现两次，用第一次（CDT）。
	assert.equal(toInstant({ year: 2026, month: 11, day: 1, hour: 1, minute: 30, second: 0 }, CHICAGO), Date.UTC(2026, 10, 1, 6, 30));
	assert.equal(formatDuration(2 * 3600_000 + 5 * 60_000 + 30_000), '2 小时 5 分钟');
	assert.equal(formatDuration(59_000), '');
	assert.equal(toInstant({ year: 2026, month: 7, day: 1, hour: 7, minute: 0, second: 30 }, CHICAGO), Date.UTC(2026, 6, 1, 12, 0, 30));
	assert.equal(formatDuration(140_000, true), '2 分钟 20 秒');
	assert.equal(formatDuration(59_000, true), '59 秒');
});

test('定时：新建、修改、取消；时间按定时自己的时区算，夏令时切换后重复的还是当地同一时刻', async t => {
	const runtime = testRuntime(t);
	t.after(() => runtime.close());
	const ai = addAi(runtime, '沈安');
	const other = addAi(runtime, '林');
	let now = Date.UTC(2026, 2, 7, 12, 0); // 芝加哥 3 月 7 日 06:00（CST）
	const reminders = new Reminders(runtime.db, runtime.events, runtime.timeline, () => now);

	const once = reminders.add(ai.memberId, { time: '2026-03-09 06:00', timezone: CHICAGO, note: '查天气，私聊告诉张三' });
	assert.match(once.reminderId, /^R_/);
	assert.deepEqual([once.when, once.nextAt], ['3 月 9 日 周一 06:00', Date.UTC(2026, 2, 9, 11, 0)]);
	assert.throws(() => reminders.add(ai.memberId, { time: '2026-03-07 05:00', timezone: CHICAGO, note: 'x' }), /该时间已过，America\/Chicago 当前时间为 3 月 7 日 周六 06:00/);
	assert.throws(() => reminders.add(ai.memberId, { time: '06:00', note: 'x' }), /2026-11-02 06:00/);
	assert.throws(() => reminders.add(ai.memberId, { time: '2026-02-30 06:00', note: 'x' }), /日期和时刻/);
	assert.throws(() => reminders.add(ai.memberId, { time: '2026-03-09 06:00', timezone: 'Mars/Base', note: 'x' }), /无法识别的时区/);
	assert.throws(() => reminders.add(ai.memberId, { time: '06:00', repeat: 'week', note: 'x' }), /week_days/);
	assert.throws(() => reminders.update(other.memberId, once.reminderId, { note: '改' }), /未找到你的定时/);

	// 时刻可以带秒；从现在起多久由这一刻起算，存下算出来的时刻。
	const precise = reminders.add(ai.memberId, { time: '2026-03-07 06:00:30', timezone: CHICAGO, note: '半分钟后' });
	assert.deepEqual([precise.time, precise.when, precise.nextAt], ['2026-03-07 06:00:30', '3 月 7 日 周六 06:00:30', Date.UTC(2026, 2, 7, 12, 0, 30)]);
	const delayed = reminders.add(ai.memberId, { delay_seconds: 90, timezone: CHICAGO, note: '一分半后' });
	assert.deepEqual([delayed.time, delayed.when, delayed.nextAt], ['2026-03-07 06:01:30', '3 月 7 日 周六 06:01:30', now + 90_000]);
	assert.equal(reminders.update(ai.memberId, delayed.reminderId, { repeat: 'day' }).when, '每天 06:01:30');
	assert.throws(() => reminders.add(ai.memberId, { time: '2026-03-09 06:00', delay_seconds: 60, note: 'x' }), /只能提供一个/);
	assert.throws(() => reminders.add(ai.memberId, { delay_seconds: 60, repeat: 'day', note: 'x' }), /仅用于一次性/);
	assert.throws(() => reminders.add(ai.memberId, { delay_seconds: 0, note: 'x' }), /1 到 31536000/);
	assert.throws(() => reminders.add(ai.memberId, { note: 'x' }), /须提供 time（如 2026-11-02 06:00）或 delay_seconds/);
	assert.throws(() => reminders.add(ai.memberId, { time: '06:00:60', repeat: 'day', note: 'x' }), /06:00:30/);
	reminders.cancel(precise.reminderId);
	reminders.cancel(delayed.reminderId);

	// 一次性改成每天：沿用原来的时刻。
	const daily = reminders.update(ai.memberId, once.reminderId, { repeat: 'day' });
	assert.deepEqual([daily.time, daily.when, daily.next, daily.nextAt], ['06:00', '每天 06:00', '3 月 8 日 周日 06:00', Date.UTC(2026, 2, 8, 11, 0)]);
	assert.throws(() => reminders.update(ai.memberId, once.reminderId, { repeat: 'none' }), /须提供 time/);
	const weekly = reminders.add(ai.memberId, { time: '7:30', repeat: 'week', week_days: [3, 1, 3], timezone: CHICAGO, note: '写周报\n发到群里' });
	assert.deepEqual([weekly.when, weekly.next], ['每周一、三 07:30', '3 月 9 日 周一 07:30']);
	assert.equal(reminders.add(ai.memberId, { time: '09:00', repeat: 'weekday', timezone: CHICAGO, note: '站会' }).next, '3 月 9 日 周一 09:00');
	assert.deepEqual(reminders.list(ai.memberId).map(item => item.when), ['每天 06:00', '每周一、三 07:30', '工作日 09:00']);
	// 列出时记下的事缩进写在定时下面，多行的每行都缩进。
	const listed = String(createManageRemindersTool(reminders).format!(reminders.list(ai.memberId)));
	assert.ok(listed.includes(`- ${weekly.reminderId}：每周一、三 07:30（America/Chicago），下次时间 3 月 9 日 周一 07:30\n  记录的事项：写周报\n  发到群里\n- R_`), listed);

	// 3 月 8 日夏令时开始，06:00 还是当地 06:00（UTC 早一小时）。
	now = Date.UTC(2026, 2, 8, 11, 0, 5);
	reminders.check();
	assert.equal(reminders.get(daily.reminderId)!.nextAt, Date.UTC(2026, 2, 9, 11, 0));
	const fired = runtime.timeline.all(ai.memberId).filter(item => item.kind === 'reminder');
	assert.deepEqual(fired.map(item => item.kind === 'reminder' && [item.wakes, item.reminder.time, item.reminder.repeat, item.reminder.next, item.reminder.lateMs]), [[true, '2026-03-08 06:00', '每天 06:00', '3 月 9 日 周一 06:00', 5000]]);

	reminders.cancel(weekly.reminderId);
	assert.throws(() => reminders.cancel(weekly.reminderId), /未找到定时/);
	// 用户取消时告诉成员，不唤醒；记录的事项太长时截断。成员自己取消的不说。
	const long = reminders.add(ai.memberId, { time: '10:00', repeat: 'day', timezone: CHICAGO, note: '甲'.repeat(101) });
	reminders.cancel(long.reminderId, ai.memberId);
	const notices = () => runtime.timeline.all(ai.memberId).flatMap(item => item.kind === 'change_notice' ? [{ ...item.notice, wakes: item.wakes }] : []);
	assert.deepEqual(notices().slice(-1), [{
		text: `用户取消了你的定时 ${weekly.reminderId}：每周一、三 07:30（America/Chicago），到时间后不会再提醒你。记录的事项：写周报
发到群里`,
		brief: '用户取消了定时：每周一、三 07:30', wakes: false,
	}]);
	const truncated = reminders.add(ai.memberId, { time: '10:00', repeat: 'day', timezone: CHICAGO, note: '乙'.repeat(101) });
	reminders.cancel(truncated.reminderId);
	assert.ok(notices().at(-1)!.text.endsWith(`记录的事项：${'乙'.repeat(100)}…`));
	for (let index = reminders.list(ai.memberId).length; index < 20; index++) reminders.add(ai.memberId, { time: '08:00', repeat: 'day', note: `第 ${index} 个` });
	assert.throws(() => reminders.add(ai.memberId, { time: '08:00', repeat: 'day', note: '多了' }), /最多 20 个/);
	// 成员删除后定时留着，恢复时继续；彻底删除时删掉。
	runtime.memberFolders.remove(ai.memberId);
	assert.equal(reminders.list(ai.memberId).length, 20);
	await runtime.purgeMember(ai.memberId);
	assert.deepEqual(reminders.list(ai.memberId), []);
});

test('定时：错过的只补一次并写明晚了多久；到点准时唤醒成员，成员按写下的事去做', async t => {
	const model = new FakeModel();
	const runtime = testRuntime(t, { models: testModels(), modelClient: model });
	t.after(() => runtime.close());
	const ai = addAi(runtime, '沈安');

	// 运行时停了三天：每天的定时只补一次，一次性的补完删掉。
	let now = Date.UTC(2026, 10, 1, 12, 0);
	const offline = new Reminders(runtime.db, runtime.events, runtime.timeline, () => now);
	const daily = offline.add(ai.memberId, { time: '07:00', repeat: 'day', timezone: CHICAGO, note: '报天气' });
	offline.add(ai.memberId, { time: '2026-11-02 06:00', timezone: CHICAGO, note: '叫我起床' });
	now = Date.UTC(2026, 10, 4, 15, 5);
	offline.check();
	const fired = runtime.timeline.all(ai.memberId).flatMap(item => item.kind === 'reminder' ? [item.reminder] : []);
	assert.deepEqual(fired.map(item => [item.note, item.time, item.next, formatDuration(item.lateMs)]), [
		['报天气', '2026-11-01 07:00', '11 月 5 日 周四 07:00', '3 天 2 小时 5 分钟'],
		['叫我起床', '2026-11-02 06:00', null, '2 天 3 小时 5 分钟'],
	]);
	// 上下文里标明是系统提示，写明原定时间、晚了多久、以后还来不来，最后是记下的事。
	const describer = new Describer(runtime.members, runtime.groups);
	assert.equal(describer.reminder(fired[0]!), [
		`系统提示：定时 ${daily.reminderId} 已到时间`, '原定时间：11 月 1 日 周日 07:00（America/Chicago），延迟 3 天 2 小时 5 分钟', '重复：每天 07:00，下次时间 11 月 5 日 周四 07:00', '你创建定时时记录的事项：', '报天气',
	].join('\n'));
	assert.match(describer.reminder(fired[1]!), /^系统提示：定时 R_\w+ 已到时间\n原定时间：11 月 2 日 周一 06:00（America\/Chicago），延迟 2 天 3 小时 5 分钟\n一次性定时，已结束\n你创建定时时记录的事项：\n叫我起床$/);
	assert.deepEqual(offline.list(ai.memberId).map(item => [item.reminderId, item.next]), [[daily.reminderId, '11 月 5 日 周四 07:00']]);
	offline.cancel(daily.reminderId);

	// 不到 1 小时的写到秒。
	const tool = createManageRemindersTool(runtime.reminders);
	const context = { memberId: ai.memberId, workingDirectory: '', signal: new AbortController().signal };
	const soon = await tool.execute(context, { action: 'add', delay_seconds: 150, note: '提醒张三' });
	assert.match(String(tool.format!(soon)), /^已新建定时 R_\w+：.+（[\w/]+），约 2 分钟 30 秒后到时间。届时系统会提醒你。$/);
	runtime.reminders.cancel((soon as { reminderId: string }).reminderId);

	// 成员自己建定时：结果写明还有多久；运行环境里有时间，不列定时。
	model.script = [[call('c1', 'manage_reminders', { action: 'add', time: '2099-01-01 06:00', timezone: CHICAGO, note: '查天气，私聊告诉张三' })]];
	runtime.runs.start();
	const human = runtime.members.createHuman('张三');
	runtime.messages.send(human.memberId, { kind: 'direct', memberId: ai.memberId }, '2099 年元旦早上 6 点查一下天气告诉我');
	await runtime.runs.idle();
	const input = JSON.stringify(model.requests.at(-1)!.input);
	assert.match(input, /已新建定时 R_\w+：2099 年 1 月 1 日 周四 06:00（America\/Chicago），约 \d+ 天[ \d小时分钟]*后到时间。届时系统会提醒你。/);
	// 新成员收到的第一条内容带完整的时间，写在编号后面。
	assert.match(input, /"\[内容编号 \d+\] 时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2} 周.（[\w/]+，UTC[+-]\d{2}:\d{2}）\\n系统提示：定时 R_\w+ 已到时间/);
	// note 只在建定时的调用里出现一次。
	assert.equal(input.split('查天气，私聊告诉张三').length, 2);

	// 计时器准时触发：把时钟拨到定时前 100 毫秒。
	const reminder = runtime.reminders.list(ai.memberId)[0]!;
	const offset = reminder.nextAt - 100 - Date.now();
	const timed = new Reminders(runtime.db, runtime.events, runtime.timeline, () => Date.now() + offset);
	t.after(() => timed.close());
	model.script.push([]);
	const before = model.requests.length;
	timed.start();
	const deadline = Date.now() + 5000;
	while (model.requests.length === before && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
	await runtime.runs.idle();
	const woke = JSON.stringify(model.requests.at(-1)!.input);
	const notice = [`系统提示：定时 ${reminder.reminderId} 已到时间`, '原定时间：1 月 1 日 周四 06:00（America/Chicago）', '一次性定时，已结束', '你创建定时时记录的事项：', '查天气，私聊告诉张三'].join('\n');
	assert.ok(woke.includes(JSON.stringify(notice).slice(1, -1)), woke);
	assert.deepEqual(runtime.reminders.list(ai.memberId), []);
});
