import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IModelClient, IModelRequest, IModelResponse } from '../models/client.ts';
import { addAi, testModels, testRuntime } from '../testing.ts';
import type { IModelOutputItem } from '../timeline/timeline.ts';
import { planNoteText, readPlanItems, type IPlanItem } from './plans.ts';

/** 假的模型：第 n 次请求返回 script[n]，并记下每次请求。 */
class FakeModel implements IModelClient {
	readonly requests: IModelRequest[] = [];
	script: IModelOutputItem[][] = [];

	async respond(request: IModelRequest): Promise<IModelResponse> {
		this.requests.push(request);
		await Promise.resolve();
		return { output: this.script[this.requests.length - 1] ?? [], usage: undefined };
	}
}

function call(callId: string, name: string, args: object): IModelOutputItem {
	return { type: 'function_call', call_id: callId, name, arguments: JSON.stringify(args) };
}

const PLAN: readonly IPlanItem[] = [{ text: '订会议室', status: 'in_progress' }, { text: '发通知', status: 'pending' }];

test('检查计划：写明是第几项、哪里不对；去掉首尾空白后算字数', () => {
	assert.deepEqual(readPlanItems([{ text: ' 订会议室 ', status: 'pending' }]), [{ text: '订会议室', status: 'pending' }]);
	assert.deepEqual(readPlanItems([]), []);
	assert.throws(() => readPlanItems('订会议室'), /items 必须是数组/);
	assert.throws(() => readPlanItems(Array.from({ length: 21 }, () => ({ text: '甲', status: 'pending' }))), /计划最多 20 项，本次有 21 项/);
	assert.throws(() => readPlanItems([{ text: '甲', status: 'pending' }, '乙']), /第 2 项必须是包含 text 和 status 的对象/);
	assert.throws(() => readPlanItems([{ text: 1, status: 'pending' }]), /第 1 项的 text 必须是字符串/);
	assert.throws(() => readPlanItems([{ text: '  ', status: 'pending' }]), /第 1 项的 text 不能为空/);
	assert.doesNotThrow(() => readPlanItems([{ text: `${'甲'.repeat(60)} `, status: 'pending' }]));
	assert.throws(() => readPlanItems([{ text: '甲', status: 'pending' }, { text: '乙'.repeat(61), status: 'pending' }]), /第 2 项有 61 字，每项最多 60 字/);
	assert.throws(() => readPlanItems([{ text: '甲', status: 'done' }]), /第 1 项的 status 只能是 pending、in_progress、completed/);
});

test('update_plan：整份替换，空列表清空，全部完成时也清空，出错时不改；每次更新推送 plan.changed；运行规则里总有「计划」一节', async t => {
	const model = new FakeModel();
	const runtime = testRuntime(t, { models: testModels(), modelClient: model });
	const ai = addAi(runtime, '沈安');
	// 每次推送 plan.changed 时的计划：各项的状态。
	const changes: string[] = [];
	runtime.events.subscribe(({ event }) => event.type === 'plan.changed' && changes.push(runtime.plans.get(event.memberId).items.map(item => item.status).join(',')));
	const half = [{ text: '订会议室', status: 'completed' }, { text: '发通知', status: 'in_progress' }];
	const done = half.map(item => ({ ...item, status: 'completed' }));
	model.script = [
		[call('c1', 'update_plan', { items: PLAN })],
		[call('c2', 'update_plan', { items: [...half, { text: '', status: 'pending' }] })],
		[call('c3', 'update_plan', { items: half })],
		[call('c4', 'update_plan', { items: done })],
		[call('c5', 'update_plan', { items: PLAN })],
		[call('c6', 'update_plan', { items: [] })],
		[],
	];
	assert.deepEqual(runtime.plans.get(ai.memberId), { items: [], updatedAt: null });
	runtime.runs.start();
	runtime.timeline.appendUserInput(ai.memberId, { text: '订会议室，再发个通知' });
	await runtime.runs.idle();

	const results = runtime.timeline.all(ai.memberId).flatMap(item => item.kind === 'tool_result' ? [`${item.result.isError ? '错误' : '结果'}:${item.result.output}`] : []);
	assert.deepEqual(results, ['结果:计划已更新。', '错误:第 3 项的 text 不能为空', '结果:计划已更新。', '结果:全部事项已完成，计划已清空。', '结果:计划已更新。', '结果:计划已清空。']);
	assert.deepEqual(changes, ['in_progress,pending', 'completed,in_progress', '', 'in_progress,pending', '']);
	const cleared = runtime.plans.get(ai.memberId);
	assert.deepEqual(cleared.items, []);
	assert.ok(cleared.updatedAt !== null);
	const rules = JSON.stringify(model.requests[0]!.input[0]);
	assert.ok(rules.includes('\\n# 计划\\n任务需要多个步骤，或同时有几项任务时，用 update_plan 列出要做的事项'));
	await runtime.close();
});

test('用户清空计划：计划清空、推送 plan.changed，时间线末尾追加不唤醒的变动说明，成员下次请求时看到；本来就是空的时不做什么', async t => {
	const model = new FakeModel();
	const runtime = testRuntime(t, { models: testModels(), modelClient: model });
	const { plans, timeline } = runtime;
	const ai = addAi(runtime, '沈安');
	const changes: string[] = [];
	runtime.events.subscribe(({ event }) => event.type === 'plan.changed' && changes.push(event.memberId));
	model.script = [[call('c1', 'update_plan', { items: PLAN })], [], []];
	runtime.runs.start();
	timeline.appendUserInput(ai.memberId, { text: '订会议室，再发个通知' });
	await runtime.runs.idle();
	assert.equal(plans.get(ai.memberId).items.length, 2);

	plans.clear(ai.memberId);
	plans.clear(ai.memberId);
	await runtime.runs.idle();
	assert.deepEqual(plans.get(ai.memberId).items, []);
	assert.deepEqual(changes, [ai.memberId, ai.memberId]);
	const notices = timeline.all(ai.memberId).flatMap(item => item.kind === 'change_notice' ? [{ ...item.notice, wakes: item.wakes }] : []);
	assert.deepEqual(notices, [{ text: '用户清空了你的计划。', brief: '用户清空了计划', wakes: false }]);
	assert.equal(model.requests.length, 2);

	timeline.appendUserInput(ai.memberId, { text: '会议改到明天了' });
	await runtime.runs.idle();
	assert.equal(model.requests.length, 3);
	assert.ok(JSON.stringify(model.requests[2]!.input).includes('用户清空了你的计划。'));
	await runtime.close();
});

test('放回计划：计划没做完、最近一份计划原文不在上下文里时才放回；在脚本里更新的总要放回；放回的计划说明之后就是最近一份原文', async t => {
	const model = new FakeModel();
	const runtime = testRuntime(t, { models: testModels(), modelClient: model });
	const { plans, timeline } = runtime;
	const ai = addAi(runtime, '沈安', { tools: ['run_tool_script'] });
	const done = PLAN.map(item => ({ ...item, status: 'completed' }));
	model.script = [
		[call('c1', 'update_plan', { items: PLAN })],
		[],
		[call('c2', 'update_plan', { items: done })],
		[],
		[call('c3', 'run_tool_script', { script: `await tools.update_plan({ items: ${JSON.stringify(PLAN)} });` })],
		[],
	];
	const say = async (text: string) => {
		timeline.appendUserInput(ai.memberId, { text });
		await runtime.runs.idle();
	};
	const callItem = (callId: string) => timeline.all(ai.memberId).find(item => item.kind === 'model_output' && item.output['call_id'] === callId)!.itemId;
	const notes = () => timeline.all(ai.memberId).filter(item => item.kind === 'plan');
	runtime.runs.start();
	await say('订会议室，再发个通知');

	// 调用还在上下文里：不放回。
	plans.restore(ai.memberId);
	assert.equal(notes().length, 0);
	// 调用被处理掉了：放回一条计划说明，原样写着计划。
	timeline.setContextState(ai.memberId, [callItem('c1')], 'pruned', null);
	plans.restore(ai.memberId);
	assert.deepEqual(notes().map(item => item.kind === 'plan' && item.plan.items), [PLAN]);
	assert.equal(timeline.all(ai.memberId).at(-1)!.kind, 'plan');
	// 计划说明还在：不再放回。
	plans.restore(ai.memberId);
	assert.equal(notes().length, 1);

	// 全部完成后计划已清空：调用被处理掉了也不放回。
	await say('都办完了吗');
	timeline.setContextState(ai.memberId, [callItem('c2')], 'pruned', null);
	plans.restore(ai.memberId);
	assert.equal(notes().length, 1);

	// 在脚本里更新的：参数可能是算出来的，调用还在也放回。
	await say('再来一遍');
	assert.deepEqual(plans.get(ai.memberId).items, PLAN);
	plans.restore(ai.memberId);
	assert.equal(notes().length, 2);
	assert.equal(planNoteText(PLAN), '上下文已整理。以下是你用 update_plan 写下的当前计划：\n{"items":[{"text":"订会议室","status":"in_progress"},{"text":"发通知","status":"pending"}]}');
	await runtime.close();
});
