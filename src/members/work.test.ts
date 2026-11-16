import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { runtimeDirectories } from '../dataDirectory.ts';
import type { IModelClient, IModelRequest, IModelResponse } from '../models/client.ts';
import { Runtime, type IRuntimeOptions } from '../runtime.ts';
import type { IModelOutputItem } from '../timeline/timeline.ts';
import type { ITool } from '../tools/tools.ts';
import { addAi, temporaryDirectory, testModels } from '../testing.ts';
import { DEFAULT_QUIET_MS, type IWorkSnapshot } from './work.ts';

/** 假的模型：按脚本返回输出，第一次请求可以拦住不放（用来观察「正在跑」）。 */
class FakeModel implements IModelClient {
	readonly requests: IModelRequest[] = [];
	script: (index: number) => IModelOutputItem[] = () => [];
	blocked: Promise<void> | undefined;
	release: () => void = () => undefined;

	async respond(request: IModelRequest): Promise<IModelResponse> {
		const index = this.requests.length;
		this.requests.push(request);
		await this.blocked;
		return { output: this.script(index), usage: undefined };
	}

	/** 拦住下一次（以及之后所有）请求，直到 release()。 */
	hold(): void {
		this.blocked = new Promise<void>(resolve => this.release = () => {
			this.blocked = undefined;
			resolve();
		});
	}
}

function say(text: string): IModelOutputItem {
	return { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] };
}

function call(callId: string, name: string, args: unknown = {}): IModelOutputItem {
	return { type: 'function_call', call_id: callId, name, arguments: JSON.stringify(args) };
}

/** 测试用的运行时：真实时钟（静默窗口要看时间），内存数据库，目录放临时目录里。 */
function setup(t: TestContext, model: FakeModel, options: Partial<IRuntimeOptions> = {}) {
	const directories = runtimeDirectories(temporaryDirectory(t));
	const runtime = new Runtime(':memory:', { ...directories, models: testModels([{ model: 'fake' }]), modelClient: model, portableGitDirectory: null, ...options });
	const human = runtime.members.createHuman('张三');
	const ai = addAi(runtime, '沈安');
	const send = (text: string) => runtime.messages.send(human.memberId, { kind: 'direct', memberId: ai.memberId }, text);
	return { runtime, human, ai, send };
}

test('没在干活就是 settled；定时提醒不算工作', async t => {
	const model = new FakeModel();
	const { runtime, ai } = setup(t, model);
	await t.test('刚建好的成员', () => {
		const work = runtime.work.snapshot(ai.memberId);
		assert.deepEqual([work.settled, work.busy, work.run, work.pendingWake, work.runningTasks], [true, false, false, false, 0]);
	});
	await t.test('排了未来的定时也不算在工作', () => {
		runtime.reminders.add(ai.memberId, { delay_seconds: 3600, note: '一小时后提醒我' });
		const work = runtime.work.snapshot(ai.memberId);
		assert.equal(work.busy, false);
		assert.equal(work.settled, true);
	});
	await runtime.close();
});

test('运行期间是 busy，结束后要静默够久才算 settled；wait 会等到那一刻', async t => {
	const model = new FakeModel();
	const { runtime, ai, send } = setup(t, model);
	model.hold();
	model.script = () => [say('做完了')];
	runtime.runs.start();
	send('做点事');
	await until(() => model.requests.length === 1);

	const whileRunning = runtime.work.snapshot(ai.memberId);
	assert.deepEqual([whileRunning.busy, whileRunning.run, whileRunning.settled], [true, true, false]);

	model.release();
	await runtime.runs.idle();
	// 用默认的 2 秒静默窗口：刚结束就查，不能算停下来（用 30 毫秒的话，机器慢一点就可能已经过了）。
	const justFinished = runtime.work.snapshot(ai.memberId);
	assert.equal(justFinished.busy, false);
	assert.equal(justFinished.settled, false, '刚才还在跑，不能立刻算停下来');

	const settled = await runtime.work.wait(ai.memberId, { quietMs: 30, timeoutMs: 5_000 });
	assert.equal(settled.settled, true);
	assert.ok(settled.quietMs >= 30);
	assert.equal(runtime.work.waiting, 0, '等到了就别再占着定时器');
	await runtime.close();
});

test('后台任务结束、成员被唤醒的那一瞬间不能算 settled', async t => {
	let release: (output: string) => void = () => undefined;
	const slow: ITool = {
		name: 'slow', description: '很慢的工具', background: true,
		parameters: { type: 'object', properties: {}, additionalProperties: false },
		execute: () => new Promise<string>(resolve => release = resolve),
	};
	const model = new FakeModel();
	const { runtime, ai, send } = setup(t, model, { extraTools: [slow], backgroundAfterMs: 10 });
	model.script = index => [index === 0 ? call('c1', 'slow') : say('收到结果了')];
	runtime.runs.start();
	send('做个慢活');
	await until(() => runtime.tasks.list(ai.memberId, { runningOnly: true }).length === 1);
	await runtime.runs.idle();

	const withTask = runtime.work.snapshot(ai.memberId);
	assert.deepEqual([withTask.busy, withTask.runningTasks, withTask.run], [true, 1, false]);

	// 任务结束的那一下：结果进时间线并唤醒成员。就在这一刻取快照，必须是 busy。
	let atTaskEnd: IWorkSnapshot | undefined;
	const unsubscribe = runtime.events.subscribe(({ event }) => {
		if (atTaskEnd || event.type !== 'timeline.appended' || event.memberId !== ai.memberId) return;
		if (runtime.tasks.list(ai.memberId, { runningOnly: true }).length > 0) return;
		atTaskEnd = runtime.work.snapshot(ai.memberId, 0);
	});
	release('慢活的结果');
	await runtime.tasks.idle();
	unsubscribe();
	await runtime.runs.idle();

	assert.ok(atTaskEnd, '应该看到了任务结束后的那次时间线变化');
	assert.equal(atTaskEnd.busy, true, '任务刚结束、成员正被唤醒，不能算停下来');
	assert.equal(atTaskEnd.settled, false);
	assert.ok(atTaskEnd.pendingWake || atTaskEnd.run);

	const settled = await runtime.work.wait(ai.memberId, { quietMs: 30, timeoutMs: 5_000 });
	assert.equal(settled.settled, true);
	await runtime.close();
});

test('等审批也算在工作：工具调用还没返回', async t => {
	const guarded: ITool = {
		name: 'guarded', description: '需要审批的工具', defaultPolicy: 'ask',
		parameters: { type: 'object', properties: {}, additionalProperties: false },
		execute: () => '做完了',
	};
	const model = new FakeModel();
	const { runtime, ai, send } = setup(t, model, { extraTools: [guarded], approvalTimeoutMs: 30_000 });
	model.script = index => [index === 0 ? call('c1', 'guarded') : say('好的')];
	let duringApproval: IWorkSnapshot | undefined;
	const unsubscribe = runtime.events.subscribe(({ event }) => {
		if (duringApproval || event.type !== 'approval.changed') return;
		const pending = runtime.approvals.list({ pendingOnly: true });
		if (pending.length === 0) return;
		duringApproval = runtime.work.snapshot(ai.memberId, 0);
		runtime.approvals.approve(pending[0]!.approvalId);
	});
	runtime.runs.start();
	send('用需要审批的工具做点事');
	await until(() => duringApproval !== undefined);
	unsubscribe();
	await runtime.runs.idle();

	assert.ok(duringApproval);
	assert.deepEqual([duringApproval.busy, duringApproval.run, duringApproval.settled], [true, true, false]);
	await runtime.close();
});

test('wait 等到超时就返回那一刻的快照，settled 是 false', async t => {
	let release: (output: string) => void = () => undefined;
	const hang: ITool = {
		name: 'hang', description: '一直不结束的工具', background: true,
		parameters: { type: 'object', properties: {}, additionalProperties: false },
		execute: () => new Promise<string>(resolve => release = resolve),
	};
	const model = new FakeModel();
	const { runtime, ai, send } = setup(t, model, { extraTools: [hang], backgroundAfterMs: 10 });
	// 只有第一次请求去调它：每次都调的话，转后台一次、模型再要一次，会堆出一串任务。
	model.script = index => [index === 0 ? call('c1', 'hang') : say('等着')];
	runtime.runs.start();
	send('跑个不会结束的活');
	await until(() => runtime.tasks.list(ai.memberId, { runningOnly: true }).length === 1);
	await runtime.runs.idle();

	const started = Date.now();
	const snapshot = await runtime.work.wait(ai.memberId, { quietMs: 30, timeoutMs: 400 });
	assert.equal(snapshot.settled, false);
	assert.deepEqual([snapshot.busy, snapshot.runningTasks], [true, 1]);
	assert.ok(Date.now() - started >= 350, '要等满 timeoutMs 才返回');

	release('结束了');
	await runtime.tasks.idle();
	await runtime.close();
});

test('成员不存在时报错，长轮询也跟着拒掉', async t => {
	const model = new FakeModel();
	const { runtime } = setup(t, model);
	assert.throws(() => runtime.work.snapshot('M_NOPE0'), /成员不存在/);
	await assert.rejects(() => runtime.work.wait('M_NOPE0'), /成员不存在/);
	await runtime.close();
});

test('默认静默窗口是 2 秒', () => {
	assert.equal(DEFAULT_QUIET_MS, 2_000);
});

/** 等到条件成立，最多等 5 秒；不用死等固定时间，测试快一点也不会 flaky。 */
async function until(condition: () => boolean): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error('等太久了');
		await new Promise(resolve => setTimeout(resolve, 5));
	}
}
