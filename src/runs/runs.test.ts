import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ModelError, type IModelClient, type IModelRequest, type IModelResponse, type OutputListener } from '../models/client.ts';
import { addAi, memberOfRequest, memoryOf, testRuntime, testModels, timelineOf, withoutNumbers } from '../testing.ts';
import type { IModelOutputItem } from '../timeline/timeline.ts';
import { distribute } from './optimizer.ts';
import type { IContextUsageInfo } from './runs.ts';
import type { ContextSnapshots } from './snapshots.ts';
import { estimateTokens } from './tokens.ts';

type Script = (memberId: string, index: number, request: IModelRequest) => IModelOutputItem[] | IModelResponse;

/** 假的模型：按脚本返回输出，并记下每次请求。 */
class FakeModel implements IModelClient {
	readonly requests: (IModelRequest & { memberId: string })[] = [];
	script: Script = () => [];

	async respond(request: IModelRequest): Promise<IModelResponse> {
		const memberId = memberOfRequest(request);
		const index = this.requests.filter(item => item.memberId === memberId).length;
		this.requests.push({ ...request, memberId });
		await Promise.resolve();
		const result = this.script(memberId, index, request);
		return Array.isArray(result) ? { output: result, usage: undefined } : result;
	}
}

function sendCall(callId: string, target: string, text: string): IModelOutputItem {
	return { type: 'function_call', call_id: callId, name: 'send_message', arguments: JSON.stringify({ target, text }) };
}

function say(text: string): IModelOutputItem {
	return { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] };
}

function think(id: string): IModelOutputItem {
	return { type: 'reasoning', id, summary: [], encrypted_content: `加密的${id}` };
}

/** 把请求的输入写成便于对比的短字符串（去掉编号、开头的规则、末尾的通讯录和 ID）。收到的内容只留来源说明下面的第二行，只有一行时留这一行。 */
function describe(input: readonly object[]): string[] {
	return withoutNumbers(timelineOf(input)).map(raw => {
		const item = raw as Record<string, any>;
		const lines = item['role'] === 'user' ? String(item['content'][0].text).split('\n') : [];
		const text = item['type'] === 'function_call'
			? `调用:${JSON.parse(item['arguments']).text}`
			: item['type'] === 'function_call_output' ? `结果:${item['output']}`
				: item['role'] === 'user' ? `收到:${lines[1] ?? lines[0]}` : `输出:${item['content'][0].text}`;
		return text.replace(/\(((M|G)_[A-Z0-9]{4})\)/g, '');
	});
}

test('唤醒后发消息，运行中收到的消息在下一次请求带上，结束后还有唤醒就再运行一次', async t => {
	const model = new FakeModel();
	const config = testModels([{ model: 'fake' }]);
	const runtime = testRuntime(t, { models: config, modelClient: model });
	const human = runtime.members.createHuman('张三');
	const host = addAi(runtime, '沈安', { directMessage: 'all' });
	const alice = addAi(runtime, '陈屿', { directMessage: 'all' });
	const fromHuman = (text: string) => runtime.messages.send(human.memberId, { kind: 'direct', memberId: host.memberId }, text);

	model.script = (memberId, index) => {
		// 陈屿没什么要说，只给思考和空文字：这一轮记进时间线，但不带回上下文。
		if (memberId === alice.memberId) return [{ type: 'reasoning', summary: [], encrypted_content: 'x' }, say('')];
		switch (index) {
			case 0:
				fromHuman('带上电脑');
				return [sendCall('c1', alice.memberId, '下午开会')];
			case 1:
				fromHuman('谢谢');
				return [say('已通知')];
			default:
				return [];
		}
	};
	runtime.runs.start();
	fromHuman('通知陈屿下午开会');
	await runtime.runs.idle();

	assert.deepEqual(model.requests.map(request => `${runtime.members.get(request.memberId)!.name}: ${describe(request.input).join(' | ')}`), [
		'沈安: 收到:通知陈屿下午开会',
		'陈屿: 收到:下午开会',
		'沈安: 收到:通知陈屿下午开会 | 调用:下午开会 | 结果:已发送 | 收到:带上电脑',
		'沈安: 收到:通知陈屿下午开会 | 调用:下午开会 | 结果:已发送 | 收到:带上电脑 | 输出:已通知 | 收到:谢谢',
	]);
	assert.deepEqual([host, alice].map(member => runtime.runs.list(member.memberId).map(run => `${run.status}/${run.requestCount}`)), [
		['completed/1', 'completed/2'],
		['completed/1'],
	]);
	assert.equal(runtime.timeline.hasPendingWake(host.memberId), false);
	assert.deepEqual(runtime.timeline.all(alice.memberId).map(item => item.kind), ['message', 'model_output', 'model_output']);
	const roles = (input: readonly object[]) => input.map(raw => (raw as Record<string, unknown>)['role']);
	assert.deepEqual([0, 1, -1].map(index => roles(model.requests[0]!.input).at(index)), ['developer', 'user', 'user']);
	await runtime.close();
});

test('请求直接用判断要不要压缩时拼好的上下文：拼完以后、请求发出前到的消息不算这次看到过，留到下一次请求', async t => {
	const model = new FakeModel();
	const runtime = testRuntime(t, { models: testModels([{ model: 'fake' }]), modelClient: model });
	const human = runtime.members.createHuman('张三');
	const host = addAi(runtime, '沈安', { directMessage: 'all' });
	const fromHuman = (text: string) => runtime.messages.send(human.memberId, { kind: 'direct', memberId: host.memberId }, text);
	// 第一次请求拼完上下文、等快照准备的时候来一条消息。
	const snapshots = (runtime.runs as unknown as { snapshots: ContextSnapshots }).snapshots;
	const prepare = snapshots.prepare.bind(snapshots);
	let sent = false;
	snapshots.prepare = async member => {
		if (!sent) {
			sent = true;
			fromHuman('顺便带上电脑');
		}
		await prepare(member);
	};
	model.script = (_, index) => [say(index === 0 ? '好的' : '收到')];
	runtime.runs.start();
	fromHuman('下午开会');
	await runtime.runs.idle();

	assert.deepEqual(model.requests.map(request => describe(request.input).join(' | ')), [
		'收到:下午开会',
		'收到:下午开会 | 输出:好的 | 收到:顺便带上电脑',
	]);
	await runtime.close();
});

test('没有实际产出的一轮记进时间线，但不带回上下文；什么都没返回时代它记一条空文字', async t => {
	const model = new FakeModel();
	const runtime = testRuntime(t, { models: testModels([{ model: 'fake' }]), modelClient: model });
	const human = runtime.members.createHuman('张三');
	const host = addAi(runtime, '沈安');
	const replies = [[think('rs_1'), say('')], [], [say('好')]];
	model.script = (_, index) => replies[index]!;
	runtime.runs.start();
	for (const text of ['在吗', '还在吗', '说句话']) {
		runtime.messages.send(human.memberId, { kind: 'direct', memberId: host.memberId }, text);
		await runtime.runs.idle();
	}

	assert.deepEqual(model.requests.map(request => describe(request.input).join(' | ')), [
		'收到:在吗',
		'收到:在吗 | 收到:还在吗',
		'收到:在吗 | 收到:还在吗 | 收到:说句话',
	]);
	assert.deepEqual(runtime.timeline.all(host.memberId).map(item => item.kind === 'model_output' ? `${item.output.type}/${item.contextState}` : item.kind), [
		'message', 'reasoning/unreturned', 'message/unreturned', 'message', 'message/unreturned', 'message', 'message/visible',
	]);
	const empty = runtime.timeline.all(host.memberId)[4];
	assert.deepEqual(empty?.kind === 'model_output' && empty.output, { type: 'message', role: 'assistant', content: [] });
	await runtime.close();
});

test('没看过的内容攒到上下文长度的三成时，不唤醒的内容也开始运行；暂停时不运行，恢复后运行', async t => {
	const model = new FakeModel();
	const runtime = testRuntime(t, { models: testModels([{ model: 'fake', contextWindow: 100_000 }]), modelClient: model });
	const human = runtime.members.createHuman('张三');
	const host = addAi(runtime, '沈安');
	const group = runtime.groups.create(human.memberId, '讨论', [host.memberId]);
	// 没点名、没关注这个群，每条都不唤醒。
	const chat = () => runtime.messages.send(human.memberId, { kind: 'group', groupId: group.groupId }, '讨论'.repeat(1000));
	const received = (request: IModelRequest) => timelineOf(request.input).filter(item => (item as Record<string, unknown>)['role'] === 'user').length;
	runtime.runs.start();
	let sent = 0;
	while (model.requests.length === 0 && sent < 50) {
		chat();
		sent++;
		await runtime.runs.idle();
	}
	// 一条大约 1500 token，攒到 3 万才运行，攒下的一起看到（前面还有一条被拉进群聊）。
	assert.ok(sent > 10 && sent < 30, `发了 ${sent} 条才运行`);
	assert.equal(received(model.requests[0]!), sent + 1);
	assert.equal(runtime.runs.hasPendingWake(host.memberId), false);

	runtime.runs.pause(host.memberId);
	for (let index = 0; index < sent; index++) chat();
	await runtime.runs.idle();
	assert.equal(model.requests.length, 1);
	assert.equal(runtime.timeline.hasPendingWake(host.memberId), false);
	assert.equal(runtime.runs.hasPendingWake(host.memberId), true);
	runtime.runs.resume(host.memberId);
	await runtime.runs.idle();
	assert.equal(model.requests.length, 2);
	assert.equal(received(model.requests[1]!), 2 * sent + 1);
	assert.equal(runtime.runs.hasPendingWake(host.memberId), false);
	assert.deepEqual(runtime.runs.list(host.memberId).map(run => run.status), ['completed', 'completed']);
	await runtime.close();
});

test('用户直接输入唤醒成员，上下文里只有正文，运行规则说明这是用户直接说的话', async t => {
	const model = new FakeModel();
	const runtime = testRuntime(t, { models: testModels([{ model: 'fake' }]), modelClient: model });
	const host = addAi(runtime, '沈安');
	model.script = () => [say('明白')];
	runtime.runs.start();
	runtime.timeline.appendUserInput(host.memberId, { text: '以后不用在群里说你在等' });
	await runtime.runs.idle();

	const users = model.requests.map(request => timelineOf(request.input).filter(raw => (raw as Record<string, unknown>)['role'] === 'user'));
	const [input] = runtime.timeline.all(host.memberId);
	assert.deepEqual(users, [[{ type: 'message', role: 'user', content: [{ type: 'input_text', text: `[内容编号 ${input!.itemId}] ${input!.time!.text}\n以后不用在群里说你在等` }] }]]);
	assert.deepEqual(runtime.timeline.all(host.memberId).map(item => item.kind), ['user_input', 'model_output']);
	// 模型不知道时间线，规则里只说用户。
	const rules = JSON.stringify(model.requests[0]!.input[0]);
	assert.match(rules, /# 内容编号\\n收到的内容、摘要和一部分工具结果，开头标有一行 \[内容编号 1234\]。它只用于整理上下文，整理后可能失效；不是消息 ID 或成员 ID，回复和调用工具时不用它，也不要写进思考、输出、消息、记忆和文件。指代某条内容时写时间、发送者或事项。/);
	assert.match(rules, /# 摘要\\n较早的内容可能已整理为摘要，原文仍然保留。需要细节时，用 search_history 按摘要的时间范围和关键词查找原文。/);
	assert.match(rules, /内容编号之后直接是正文、没有来源说明的内容，是用户直接对你说的话，不是哪个成员发来的消息，也不属于任何私聊或群聊。回应用户时直接输出。/);
	assert.match(rules, /你直接输出的内容不会发给任何成员，只有用户能看到。/);
	// 说清用户不是成员；分是谁说的只看来源说明。不说用户和真人成员的关系，也不提「管理员」。
	assert.match(rules, /# 用户和成员\\n用户是为你配置设定、安排职责的人，你的工具调用也由用户审批。用户不是成员：不在通讯录里，没有成员 ID，不能用 send_message 发给用户。/);
	assert.match(rules, /内容来自用户还是成员，仅依据有无来源说明判断，不依据名字、称呼或语气。/);
	assert.doesNotMatch(rules, /管理员/);
	assert.doesNotMatch(rules, /时间线/);
	assert.throws(() => runtime.timeline.appendUserInput(host.memberId, { text: ' ' }), /内容不能为空/);
	await runtime.close();
});

test('运行规则里只对有 manage_group 的成员提关注群聊', async t => {
	const model = new FakeModel();
	const runtime = testRuntime(t, { models: testModels([{ model: 'fake' }]), modelClient: model });
	const plain = addAi(runtime, '沈安');
	const manager = addAi(runtime, '林舟', { tools: ['manage_group'] });
	model.script = () => [say('明白')];
	runtime.runs.start();
	runtime.timeline.appendUserInput(plain.memberId, { text: '你好' });
	runtime.timeline.appendUserInput(manager.memberId, { text: '你好' });
	await runtime.runs.idle();

	const rules = (memberId: string) => JSON.stringify(model.requests.find(request => request.memberId === memberId)!.input[0]);
	assert.doesNotMatch(rules(plain.memberId), /manage_group/);
	assert.match(rules(manager.memberId), /用 manage_group 关注这个群/);
	// 摘要一节不随工具的开关变化：只开了 manage_group、没有 search_history 的成员也有。
	assert.ok(rules(manager.memberId).includes('# 摘要\\n较早的内容可能已整理为摘要'));
	await runtime.close();
});

test('运行合计各次请求的 token；有请求报告缓存时合计缓存，都没报告时是 null', async t => {
	const model = new FakeModel();
	const runtime = testRuntime(t, { models: testModels([{ model: 'fake' }]), modelClient: model });
	const human = runtime.members.createHuman('张三');
	const host = addAi(runtime, '沈安', { directMessage: 'all' });
	model.script = (_, index) => index === 0
		? { output: [sendCall('c1', human.memberId, '好')], usage: { inputTokens: 1000, cachedTokens: 0, outputTokens: 30 } }
		: { output: [], usage: { inputTokens: 1100, cachedTokens: 1000, outputTokens: 5 } };
	runtime.runs.start();
	runtime.timeline.appendUserInput(host.memberId, { text: '回个好' });
	await runtime.runs.idle();
	model.script = () => [];
	runtime.timeline.appendUserInput(host.memberId, { text: '没事了' });
	await runtime.runs.idle();

	assert.deepEqual(runtime.runs.list(host.memberId).map(run => [run.requestCount, run.inputTokens, run.cachedTokens, run.outputTokens]), [
		[1, 0, null, 0],
		[2, 2100, 1000, 35],
	]);
	await runtime.close();
});

test('用量接口：按模型合计上游返回的 token，可以只看一个成员、一段时间，失败的请求单独计数', async t => {
	const model = new FakeModel();
	const runtime = testRuntime(t, { models: testModels([{ model: 'fake' }]), modelClient: model });
	const human = runtime.members.createHuman('张三');
	const host = addAi(runtime, '沈安', { directMessage: 'all' });
	const other = addAi(runtime, '陈屿', { directMessage: 'all' });
	model.script = (_, index) => index === 0
		? { output: [sendCall('c1', human.memberId, '好')], usage: { inputTokens: 1000, cachedTokens: 200, outputTokens: 30 } }
		: { output: [], usage: { inputTokens: 1100, cachedTokens: 1000, outputTokens: 5 } };
	runtime.runs.start();
	runtime.timeline.appendUserInput(host.memberId, { text: '回个好' });
	runtime.timeline.appendUserInput(other.memberId, { text: '也说一句' });
	await runtime.runs.idle();

	// 两个成员各两次请求，合计四次的 token。
	const all = runtime.runs.usage();
	assert.deepEqual([all.requests, all.inputTokens, all.cachedTokens, all.outputTokens, all.failedRequests], [4, 4200, 2400, 70, 0]);
	assert.deepEqual(all.groups.map(item => [item.key, item.provider, item.model, item.requests, item.inputTokens]), [['test/fake', 'test', 'fake', 4, 4200]]);
	assert.equal(all.since, null);
	assert.equal(all.until, null);

	// 按成员分组：两个成员各两次请求，数字完全一样（成员 ID 是随机的，两边都排一下再比）。
	const byMember = runtime.runs.usage({ groupBy: 'member' });
	assert.deepEqual(byMember.groups.map(item => [item.memberId, item.requests, item.inputTokens, item.outputTokens]).sort(), [
		[host.memberId, 2, 2100, 35],
		[other.memberId, 2, 2100, 35],
	].sort());
	assert.equal(byMember.groups.every(item => item.provider === undefined && item.memberId !== undefined), true);

	// 只看一个成员。
	const one = runtime.runs.usage({ memberId: host.memberId });
	assert.deepEqual([one.requests, one.inputTokens, one.outputTokens], [2, 2100, 35]);

	// 时间窗：含头不含尾。请求的时间都是真实时间，取运行开始前一分钟、前一分半两个边界。
	const startedAt = runtime.runs.list(host.memberId)[0]!.startedAt;
	assert.equal(runtime.runs.usage({ since: startedAt - 60_000 }).requests, 4);
	assert.equal(runtime.runs.usage({ until: startedAt - 60_000 }).requests, 0);
	assert.equal(runtime.runs.usage({ since: startedAt - 60_000, until: startedAt - 30_000 }).requests, 0);

	// 请求失败的那次不算进合计，单独计数。
	model.script = () => { throw new ModelError('internal', '模型服务出错', false); };
	runtime.timeline.appendUserInput(host.memberId, { text: '再来' });
	await runtime.runs.idle();
	const afterFailure = runtime.runs.usage({ memberId: host.memberId });
	assert.deepEqual([afterFailure.requests, afterFailure.inputTokens, afterFailure.failedRequests], [2, 2100, 1]);
	// 失败数也按时间窗筛：把窗口放到失败请求之前，就数不到它。
	assert.equal(runtime.runs.usage({ memberId: host.memberId, until: startedAt - 60_000 }).failedRequests, 0);
	await runtime.close();
});

test('用量：还在跑的请求不算失败，成功后进合计', async t => {
	// 模型一直不返回：第一次请求停在运行中。
	let release: (() => void) | undefined;
	const hanging: IModelClient = {
		respond: async () => await new Promise<IModelResponse>(resolve => {
			release = () => resolve({ output: [], usage: { inputTokens: 500, cachedTokens: 100, outputTokens: 20 } });
		}),
	};
	const runtime = testRuntime(t, { models: testModels([{ model: 'fake' }]), modelClient: hanging });
	const host = addAi(runtime, '沈安', { directMessage: 'all' });
	runtime.runs.start();
	runtime.timeline.appendUserInput(host.memberId, { text: '算一下' });
	// 等到这一次请求真的发出去了（运行中的请求已经记下来了）。
	while (!release) await new Promise(resolve => setTimeout(resolve, 5));

	const running = runtime.runs.usage();
	assert.deepEqual([running.requests, running.inputTokens, running.failedRequests], [0, 0, 0]);

	release();
	await runtime.runs.idle();
	const done = runtime.runs.usage();
	assert.deepEqual([done.requests, done.inputTokens, done.outputTokens, done.failedRequests], [1, 500, 20, 0]);
	await runtime.close();
});

test('运行中推送正在做什么：请求模型、执行工具（参数截短）、执行完去掉，运行结束推送 null', async t => {
	const model = new FakeModel();
	const runtime = testRuntime(t, { models: testModels([{ model: 'fake' }]), modelClient: model });
	const human = runtime.members.createHuman('张三');
	const host = addAi(runtime, '沈安', { directMessage: 'all' });
	const steps: string[] = [];
	runtime.events.subscribe(({ event }) => {
		if (event.type !== 'member.activity' || event.memberId !== host.memberId) return;
		const { activity } = event;
		steps.push(activity ? `${activity.phase}:${activity.calls.map(call => `${call.name}/${(call.args as { text: string }).text.length}`).join(',')}` : 'null');
		if (activity) assert.equal(runtime.runs.activity(host.memberId), activity);
	});
	model.script = (_, index) => index === 0 ? [sendCall('c1', human.memberId, '长'.repeat(500))] : [];
	runtime.runs.start();
	runtime.timeline.appendUserInput(host.memberId, { text: '说点长的' });
	await runtime.runs.idle();

	assert.deepEqual(steps, ['model:', 'model:', 'tools:send_message/202', 'tools:', 'model:', 'null']);
	assert.equal(runtime.runs.activity(host.memberId), undefined);
	await runtime.close();
});

test('请求模型时推送模型正在输出哪一项：开始输出另一项不算换了一步，同样的不重复推送；重试时回到 null', async t => {
	let attempts = 0;
	let human = '';
	const client: IModelClient = {
		async respond(_request: IModelRequest, _signal: AbortSignal, _onDelta: unknown, onOutput: OutputListener): Promise<IModelResponse> {
			await Promise.resolve();
			attempts++;
			onOutput({ type: 'reasoning' });
			// 第一次请求输出到一半断了，重试一次。
			if (attempts === 1) throw new ModelError('stream_error', '模型服务报错：断了', true);
			if (attempts > 2) return { output: [], usage: undefined };
			onOutput({ type: 'text' });
			onOutput({ type: 'call', name: 'send_message' });
			onOutput({ type: 'call', name: 'send_message' });
			return { output: [say('好'), sendCall('c1', human, '一'), sendCall('c2', human, '二')], usage: undefined };
		},
	};
	const runtime = testRuntime(t, { models: testModels([{ model: 'fake' }]), modelClient: client });
	human = runtime.members.createHuman('张三').memberId;
	const host = addAi(runtime, '沈安', { directMessage: 'all' });
	const steps: string[] = [];
	const since: number[] = [];
	runtime.events.subscribe(({ event }) => {
		if (event.type !== 'member.activity' || event.memberId !== host.memberId) return;
		const { activity } = event;
		const output = activity?.output;
		steps.push(activity ? `${activity.phase}:${output ? output.type === 'call' ? `call/${output.name}` : output.type : ''}` : 'null');
		if (activity?.phase === 'model') since.push(activity.since);
	});
	runtime.runs.start();
	runtime.timeline.appendUserInput(host.memberId, { text: '发两条' });
	await runtime.runs.idle();

	assert.deepEqual(steps, ['model:', 'model:', 'model:reasoning', 'model:', 'model:reasoning', 'model:text', 'model:call/send_message', 'tools:', 'tools:', 'tools:', 'model:', 'model:reasoning', 'null']);
	// 第一次请求里开始输出的每一项，这一步开始的时间都和这次请求开始时一样。
	assert.equal(new Set(since.slice(1, 7)).size, 1);
	await runtime.close();
});

test('中止的运行记下原因：暂停时是「已暂停」，删除成员时是「成员被删除」', async t => {
	let requested = () => {};
	// 请求一直等到被中止。
	const model: IModelClient = {
		respond: (_request, signal) => new Promise((_resolve, reject) => {
			requested();
			signal.addEventListener('abort', () => reject(signal.reason), { once: true });
		}),
	};
	const runtime = testRuntime(t, { models: testModels(), modelClient: model });
	const host = addAi(runtime, '沈安');
	const stopWhileRequesting = async (stop: () => unknown) => {
		const reached = new Promise<void>(resolve => { requested = resolve; });
		runtime.timeline.appendUserInput(host.memberId, { text: '在吗' });
		await reached;
		stop();
		await runtime.runs.idle();
		const [run] = runtime.runs.list(host.memberId);
		return `${run!.status}:${run!.error}`;
	};
	runtime.runs.start();

	assert.equal(await stopWhileRequesting(() => runtime.runs.pause(host.memberId)), 'stopped:已暂停');
	runtime.runs.resume(host.memberId);
	assert.equal(await stopWhileRequesting(() => runtime.memberFolders.remove(host.memberId)), 'stopped:成员被删除');
	await runtime.close();
});

const ORDER = '订周五下午两点到四点的会议室，十个人，要有投影仪和白板，订好后发我确认';
const ORDER_REPLY = '好的，我这就去订周五下午两点到四点的会议室，十个人，带投影仪和白板';
/** 摘要和说明里的时间范围：两端到分钟，后面跟一次时区和 UTC 偏移（测试里不跨夏令时，只有一个偏移）。 */
const RANGE_TEXT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} 到 \d{4}-\d{2}-\d{2} \d{2}:\d{2}（[^，（）]+，UTC[+-]\d{2}:\d{2}）$/;

function proposal(ops: readonly object[]): IModelOutputItem[] {
	return [say(JSON.stringify({ ops }))];
}

/** 上下文里每条内容的第一行：收到的内容和工具结果是编号（去掉编号后面带的时间），自己的输出不加编号。 */
function heads(input: readonly object[]): string[] {
	return timelineOf(input).map(raw => {
		const item = raw as Record<string, any>;
		if (item['type'] === 'function_call') return `调用:${item['name']}`;
		if (item['type'] === 'reasoning') return '思考';
		if (item['type'] === 'function_call_output') return String(typeof item['output'] === 'string' ? item['output'] : item['output'][0].text).split('\n')[0]!;
		const text = typeof item['content'] === 'string' ? item['content'] : String(item['content'][0].text);
		return item['role'] === 'user' ? text.split('\n')[0]!.replace(/ 时间：.*$/, '') : `输出:${text}`;
	});
}

/** 压缩请求的任务说明。 */
function taskOf(request: IModelRequest): string {
	return String((request.input.find(raw => String((raw as any).content?.[0]?.text ?? '').startsWith('【上下文压缩任务】')) as any).content[0].text);
}

/** 压缩请求里可以处理的编号：任务说明写了「内容编号 N 及排在其后的内容」不能处理时，只到它前面。 */
function processable(request: IModelRequest): number[] {
	const boundary = /- 内容编号 (\d+) 及排在其后的内容/.exec(taskOf(request))?.[1];
	const numbers: number[] = [];
	for (const head of heads(request.input)) {
		const number = /^\[内容编号 (\d+)\]$/.exec(head)?.[1];
		if (!number) continue;
		if (number === boundary) break;
		numbers.push(Number(number));
	}
	return numbers;
}

test('输入到了七成时压缩：运行结束时马上压缩；编号写在正常的上下文里，压缩请求只在最后加任务说明；摘要放在原来的位置；最近看过的一组不能处理', async t => {
	const model = new FakeModel();
	const runtime = testRuntime(t, { models: testModels([{ model: 'fake', contextWindow: 100_000 }]), modelClient: model, recentRatio: 0 });
	const human = runtime.members.createHuman('张三');
	const host = addAi(runtime, '沈安');
	const fromHuman = async (text: string) => {
		runtime.messages.send(human.memberId, { kind: 'direct', memberId: host.memberId }, text);
		await runtime.runs.idle();
	};
	model.script = (_, index, request) => {
		if (request.textFormat) return proposal([{ op: 'summarize', ids: ['[内容编号 1]'], summary: '张三让我订周五会议室，我答应了' }]);
		// 第二次回复报告的输入到了七成：运行结束时马上压缩。
		return { output: index === 0 ? [say(ORDER_REPLY)] : index === 1 ? [say('已订好')] : [], usage: { inputTokens: index === 1 ? 75_000 : 1_000, cachedTokens: 0, outputTokens: 10 } };
	};
	runtime.runs.start();
	await fromHuman(ORDER);
	await fromHuman('订好了吗');

	const [, second, optimization] = model.requests;
	assert.equal(optimization!.toolChoice, 'none');
	// 前面和正常请求一样（末尾的运行环境和通讯录每次重新生成），能命中缓存；没调用工具的回复没有编号，跟着前面的编号。
	assert.deepEqual(optimization!.input.slice(0, second!.input.length - 2), second!.input.slice(0, -2));
	assert.deepEqual(heads(optimization!.input), ['[内容编号 1]', `输出:${ORDER_REPLY}`, '[内容编号 3]', '输出:已订好', '【上下文压缩任务】本次不是正常对话，只输出压缩方案。']);
	// 没有没看过的内容，最近看过的一组（订好了吗和回答）不能处理。
	assert.ok(taskOf(optimization!).includes('- 内容编号 3 及排在其后的内容是最近的内容，本次不得处理。'));
	assert.doesNotMatch(taskOf(optimization!), /只提供了其中一部分/);

	await fromHuman('再订下周一的');
	const last = model.requests.at(-1)!;
	// 摘要用它代替的最早那条内容的编号，不用自己的条目 ID（6，前面是压缩记录）：排在最前面，编号也最小。
	assert.deepEqual(heads(last.input), ['[内容编号 1]', '[内容编号 3]', '输出:已订好', '[内容编号 7]']);
	assert.deepEqual(describe(last.input), ['收到:张三让我订周五会议室，我答应了', '收到:订好了吗', '输出:已订好', '收到:再订下周一的']);
	assert.deepEqual(runtime.runs.list(host.memberId).map(run => `${run.kind}/${run.status}/${run.requestCount}`), [
		'response/completed/1', 'optimization/completed/1', 'response/completed/1', 'response/completed/1',
	]);
	// 最后一次回复什么都没返回：代它记一条空文字，不进上下文。
	assert.deepEqual(runtime.timeline.all(host.memberId).map(item => `${item.kind}/${item.contextState}`), [
		'message/summarized', 'model_output/summarized', 'message/visible', 'model_output/visible', 'optimization/visible', 'summary/visible', 'message/visible', 'model_output/unreturned',
	]);
	await runtime.close();
});

test('几份摘要各自代替不连续的内容：编号用各自代替的最早那条，按先后递增、不重复', async t => {
	const model = new FakeModel();
	const runtime = testRuntime(t, { models: testModels([{ model: 'fake', contextWindow: 100_000 }]), modelClient: model, recentRatio: 0 });
	const human = runtime.members.createHuman('张三');
	const host = addAi(runtime, '沈安');
	const fromHuman = async (text: string) => {
		runtime.messages.send(human.memberId, { kind: 'direct', memberId: host.memberId }, text);
		await runtime.runs.idle();
	};
	model.script = (_, index, request) => {
		if (request.textFormat) return proposal([{ op: 'summarize', ids: [1, 5], summary: '一和三' }, { op: 'summarize', ids: [3], summary: '二' }]);
		// 第四次回复报告的输入到了七成：运行结束时马上压缩，最近看过的一组（四）不能处理。
		return { output: index < 4 ? [say(`回复${index}`)] : [], usage: { inputTokens: index === 3 ? 75_000 : 1_000, cachedTokens: 0, outputTokens: 10 } };
	};
	runtime.runs.start();
	await fromHuman('一'.repeat(200));
	await fromHuman('二'.repeat(200));
	await fromHuman('三'.repeat(200));
	await fromHuman('四');
	await fromHuman('五');

	assert.deepEqual(heads(model.requests.at(-1)!.input), ['[内容编号 1]', '[内容编号 3]', '[内容编号 7]', '输出:回复3', '[内容编号 12]']);
	assert.deepEqual(describe(model.requests.at(-1)!.input), ['收到:一和三', '收到:二', '收到:四', '输出:回复3', '收到:五']);
	await runtime.close();
});

test('请求前压缩时最近的内容不能处理：没看过的结果和最近看过的一组；方案不合规时带着输出和原因再请求一次，第二次合规的执行、不合规的跳过；两次的经过记进压缩记录，不进上下文', async t => {
	const model = new FakeModel();
	const runtime = testRuntime(t, { models: testModels([{ model: 'fake', contextWindow: 100_000 }]), modelClient: model, recentRatio: 0 });
	const human = runtime.members.createHuman('张三');
	const host = addAi(runtime, '沈安', { directMessage: 'all' });
	const fromHuman = async (text: string) => {
		runtime.messages.send(human.memberId, { kind: 'direct', memberId: host.memberId }, text);
		await runtime.runs.idle();
	};
	const answer = [think('rs_1'), ...proposal([{ op: 'summarize', ids: [1], summary: '张三让我订周五会议室，我答应了' }, { op: 'prune', ids: [3] }])];
	model.script = (_, index, request) => {
		if (request.textFormat) return answer;
		// 第二次回复调用了工具，报告的输入到了七成：下一次请求前先压缩。
		if (index === 1) return { output: [sendCall('c1', human.memberId, '订好了')], usage: { inputTokens: 75_000, cachedTokens: 0, outputTokens: 10 } };
		return { output: index === 0 ? [say(ORDER_REPLY)] : [], usage: { inputTokens: 1_000, cachedTokens: 0, outputTokens: 10 } };
	};
	runtime.runs.start();
	await fromHuman(ORDER);
	await fromHuman('订好了吗');

	const [first, second] = model.requests.filter(request => request.textFormat);
	assert.ok(taskOf(first!).includes('- 内容编号 3 及排在其后的内容是最近的内容，本次不得处理。'));
	assert.deepEqual(second!.input, [
		...first!.input,
		// 思考和文字一起带回，和平时带回模型的输出一样：思考去掉 id。
		{ type: 'reasoning', summary: [], encrypted_content: '加密的rs_1' },
		...answer.slice(1),
		{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '上次的方案存在以下不符合要求之处，整份方案均未执行：\n- 内容编号 3 不在可处理范围内\n\n请修正后重新输出完整的方案。' }] },
	]);
	assert.equal(model.requests.filter(request => request.textFormat).length, 2);
	// 编号和先后一致：摘要用代替的最早那条的编号；调用了工具的回复用这次回复第一项输出（调用，4）的编号，不用结果的（5）。
	assert.deepEqual(heads(model.requests.at(-1)!.input), ['[内容编号 1]', '[内容编号 3]', '调用:send_message', '[内容编号 4]']);
	assert.deepEqual(runtime.runs.list(host.memberId).map(run => `${run.kind}/${run.status}/${run.requestCount}`), ['response/completed/4', 'response/completed/1']);
	assert.deepEqual(runtime.timeline.all(host.memberId).map(item => `${item.kind}/${item.contextState}`), [
		'message/summarized', 'model_output/summarized', 'message/visible', 'model_output/visible', 'tool_result/visible', 'optimization/visible', 'summary/visible', 'model_output/unreturned',
	]);
	// 压缩记录：两次请求的输出和不合规的地方（第一次整份没执行，第二次跳过了这一处），排在结果前面；思考只有加密内容，没有文字。
	const record = runtime.timeline.all(host.memberId).find(item => item.kind === 'optimization');
	assert.ok(record?.kind === 'optimization');
	const { requests, estimate, ...rest } = record.optimization;
	assert.deepEqual({ ...rest, startedAt: 0, endedAt: 0 }, { trigger: 'before_request', status: 'completed', error: null, startedAt: 0, endedAt: 0 });
	assert.deepEqual(requests.map(request => ({ ...request, requestId: 0 })), [1, 2].map(() => ({
		requestId: 0, reasoning: '', output: JSON.stringify({ ops: [{ op: 'summarize', ids: [1], summary: '张三让我订周五会议室，我答应了' }, { op: 'prune', ids: [3] }] }),
		problems: ['内容编号 3 不在可处理范围内'], retries: [], inputTokens: null, cachedTokens: null, outputTokens: null,
	})));
	assert.ok(estimate.after !== null && estimate.after < estimate.before);
	await runtime.close();
});

test('压缩的输出只有思考、没有文字时，第二次请求不带回输出，只说明哪里不合规', async t => {
	const model = new FakeModel();
	const runtime = testRuntime(t, { models: testModels([{ model: 'fake', contextWindow: 100_000 }]), modelClient: model, recentRatio: 0 });
	const human = runtime.members.createHuman('张三');
	const host = addAi(runtime, '沈安');
	model.script = (_, index, request) => {
		if (request.textFormat) return model.requests.filter(item => item.textFormat).length === 1 ? [think('rs_1'), say('')] : proposal([{ op: 'prune', ids: [1] }]);
		// 第二次回复报告的输入到了七成：运行结束时马上压缩，最近看过的一组不能处理。
		return { output: [say(ORDER_REPLY)], usage: { inputTokens: index === 1 ? 75_000 : 1_000, cachedTokens: 0, outputTokens: 10 } };
	};
	runtime.runs.start();
	for (const text of [ORDER, '订好了吗']) {
		runtime.messages.send(human.memberId, { kind: 'direct', memberId: host.memberId }, text);
		await runtime.runs.idle();
	}

	const [first, second] = model.requests.filter(request => request.textFormat);
	assert.deepEqual(second!.input, [
		...first!.input,
		{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '上次的方案存在以下不符合要求之处，整份方案均未执行：\n- 输出不符合要求的 JSON 格式\n\n请修正后重新输出完整的方案。' }] },
	]);
	assert.deepEqual(runtime.timeline.all(host.memberId).map(item => `${item.kind}/${item.contextState}`), [
		'message/pruned', 'model_output/pruned', 'message/visible', 'model_output/visible', 'optimization/visible', 'pruning/visible',
	]);
	await runtime.close();
});

test('压缩时整理记忆：按顺序检查，超过兜底或找不到原文的算不合规，第二次仍这样就跳过；之后刷新快照，修改记进时间线；摘要开头写时间范围', async t => {
	const model = new FakeModel();
	const runtime = testRuntime(t, { models: testModels([{ model: 'fake', contextWindow: 100_000 }]), modelClient: model, recentRatio: 0 });
	const human = runtime.members.createHuman('张三');
	const host = addAi(runtime, '沈安');
	runtime.memories.write(host.memberId, '张三是产品经理', true);
	const fromHuman = async (text: string) => {
		runtime.messages.send(human.memberId, { kind: 'direct', memberId: host.memberId }, text);
		await runtime.runs.idle();
	};
	const memorySection = (request: IModelRequest) => memoryOf(request.input);

	model.script = (_, index, request) => {
		if (request.textFormat) {
			return proposal([
				{ op: 'summarize', ids: [1], summary: '张三让我订周五会议室' },
				{ op: 'memory_add', text: '张三开会习惯订周五' },
				{ op: 'memory_replace', old_text: '张三是设计师', new_text: '张三是产品总监' },
				{ op: 'memory_add', text: '长'.repeat(6000) },
				{ op: 'memory_replace', old_text: '产品经理', new_text: '产品总监' },
			]);
		}
		// 第二次回复报告的输入到了七成：运行结束时马上压缩，最近看过的一组不能处理。
		return { output: index === 0 ? [say(ORDER_REPLY)] : [], usage: { inputTokens: index === 1 ? 75_000 : 1_000, cachedTokens: 0, outputTokens: 10 } };
	};
	runtime.runs.start();
	await fromHuman(ORDER);
	await fromHuman('订好了吗');
	await fromHuman('还有别的吗');

	const [optimization, retry] = model.requests.filter(request => request.textFormat);
	assert.equal(memorySection(optimization!), '张三是产品经理');
	assert.ok(taskOf(optimization!).includes('记忆的当前内容与开头「# 你的记忆」相同，共 7 字。'));
	assert.equal((retry!.input.at(-1) as any).content[0].text, [
		'上次的方案存在以下不符合要求之处，整份方案均未执行：',
		'- memory_replace「张三是设计师」：记忆中未找到 old_text 的原文',
		`- memory_add「${'长'.repeat(40)}……」：修改后记忆共 6018 字，超过 6000 字上限`,
		'',
		'请修正后重新输出完整的方案。',
	].join('\n'));
	assert.equal(runtime.memories.read(host.memberId), '张三是产品总监\n张三开会习惯订周五');
	const change = runtime.timeline.all(host.memberId).find(item => item.kind === 'memory_change');
	assert.deepEqual(change?.kind === 'memory_change' && change.change, {
		operations: [{ op: 'add', text: '张三开会习惯订周五' }, { op: 'replace', oldText: '产品经理', newText: '产品总监' }],
		length: 17,
	});

	const last = model.requests.at(-1)!;
	assert.equal(memorySection(last), '张三是产品总监\n张三开会习惯订周五');
	const summary = last.input.map(raw => raw as Record<string, any>).find(item => item['role'] === 'user' && String(item['content'][0].text).includes('张三让我订周五会议室'));
	// 时间范围是压缩时写下的那段文字，原样放进上下文。
	const stored = runtime.timeline.all(host.memberId).find(item => item.kind === 'summary');
	assert.ok(stored?.kind === 'summary');
	assert.match(stored.summary.rangeText, RANGE_TEXT);
	assert.match(summary!['content'][0].text, /^\[内容编号 \d+\]\n/);
	assert.ok(summary!['content'][0].text.endsWith(`\n以下是你此前整理的较早内容的摘要，时间范围为 ${stored.summary.rangeText}：\n张三让我订周五会议室`), summary!['content'][0].text);
	assert.deepEqual(describe(last.input).slice(-1), ['收到:还有别的吗']);
	await runtime.close();
});

test('压缩时记下统计：每条摘要记下代替了什么；删掉的合成一条删除记录，排在摘要后面，不进上下文；再整理旧摘要时算一条摘要，原文改为指向新摘要', async t => {
	const model = new FakeModel();
	const runtime = testRuntime(t, { models: testModels([{ model: 'fake', contextWindow: 100_000 }]), modelClient: model, recentRatio: 0 });
	const human = runtime.members.createHuman('张三');
	const host = addAi(runtime, '沈安');
	const long = (label: string) => `${label}${'讨论'.repeat(200)}`;
	const replies = [[think('rs_1'), say(ORDER_REPLY)], [say(''), sendCall('c1', human.memberId, '收到')], [], [say('还在订')], [say('订好了')]];
	let responses = 0;
	let optimizations = 0;
	model.script = (_, _index, request) => {
		if (request.textFormat) {
			const numbers = processable(request);
			return proposal(++optimizations === 1
				? [
					// 关键词去掉重复的、过长的和被代替的内容里没有的。
					{ op: 'summarize', ids: [numbers[0]], summary: '张三让我订会议室，我答应了', keywords: ['订会议室', '没有这个词', '订会议室', 'x'.repeat(65)] },
					{ op: 'prune', ids: [numbers[1]] },
					{ op: 'prune', ids: [numbers[2]] },
					{ op: 'memory_add', text: '张三常订会议室' },
				]
				// 「订会议室」是旧摘要核对过的关键词；「投影仪」只在旧摘要代替的原文里；「收到」在删掉的内容里，这条摘要没有代替它。
				: [{ op: 'summarize', ids: numbers, summary: '张三让我订会议室，问过进度', keywords: ['订会议室', '收到', '进度', '投影仪'] }]);
		}
		// 第四次、第五次回复报告的输入到了七成：运行结束时马上压缩，最近看过的一组不能处理。
		return { output: replies[responses]!, usage: { inputTokens: responses++ >= 3 ? 75_000 : 1_000, cachedTokens: 0, outputTokens: 10 } };
	};
	runtime.runs.start();
	for (const text of [long('订会议室'), long('先回我一句'), long('进度怎么样')]) {
		runtime.messages.send(human.memberId, { kind: 'direct', memberId: host.memberId }, text);
		await runtime.runs.idle();
	}
	const beforeSecond = model.requests.length;
	runtime.messages.send(human.memberId, { kind: 'direct', memberId: host.memberId }, '订好了吗');
	await runtime.runs.idle();

	const items = runtime.timeline.all(host.memberId);
	assert.deepEqual(items.map(item => `${item.kind}/${item.contextState}`), [
		'message/summarized', 'model_output/summarized', 'model_output/summarized',
		// 发完消息那一轮什么都没返回：代它记的空文字记成没带回，不在上下文里，压缩不处理。
		'message/pruned', 'model_output/pruned', 'model_output/pruned', 'tool_result/pruned', 'model_output/unreturned',
		'message/summarized', 'model_output/summarized',
		'optimization/visible', 'memory_change/visible', 'summary/summarized', 'pruning/visible',
		'message/visible', 'model_output/visible', 'optimization/visible', 'summary/visible',
	]);
	const zero = { summaries: 0, messages: 0, thinking: 0, outputs: 0, calls: 0, events: 0 };
	const [first, second] = items.filter(item => item.kind === 'summary');
	// 发出的消息算消息；和工具调用一起保存下来的没有文字的直接输出不算。
	assert.deepEqual(first?.kind === 'summary' && first.summary.counts, { ...zero, messages: 1, thinking: 1, outputs: 1 });
	const pruning = items.find(item => item.kind === 'pruning');
	assert.deepEqual(pruning?.kind === 'pruning' && pruning.pruning, { counts: { ...zero, messages: 2 } });
	assert.deepEqual(second?.kind === 'summary' && second.summary.counts, { ...zero, summaries: 1, messages: 1, outputs: 1 });
	assert.deepEqual([first?.kind === 'summary' && first.summary.keywords, second?.kind === 'summary' && second.summary.keywords], [['订会议室'], ['订会议室', '进度', '投影仪']]);
	// 旧摘要和它代替的原文都直接指向新摘要。
	assert.deepEqual(items.filter(item => item.contextState === 'summarized').map(item => item.summaryItemId), Array(6).fill(second!.itemId));
	// 删除记录和记忆的修改一样不进上下文：第二次压缩前的请求里只有摘要、最近的一问一答和新消息。摘要后面写关键词。
	assert.equal(describe(model.requests[beforeSecond]!.input).length, 4);
	assert.ok(JSON.stringify(model.requests[beforeSecond]!.input).includes('张三让我订会议室，我答应了\\n关键词：订会议室'));
	await runtime.close();
});

test('旧摘要被删掉时，它代替的原文也改为已删除，不再指向摘要', async t => {
	const model = new FakeModel();
	const runtime = testRuntime(t, { models: testModels([{ model: 'fake', contextWindow: 100_000 }]), modelClient: model, recentRatio: 0 });
	const human = runtime.members.createHuman('张三');
	const host = addAi(runtime, '沈安');
	let responses = 0;
	let optimizations = 0;
	model.script = (_, _index, request) => {
		if (request.textFormat) {
			const numbers = processable(request);
			return proposal(++optimizations === 1 ? [{ op: 'summarize', ids: [numbers[0]], summary: '张三让我订会议室', keywords: [] }] : [{ op: 'prune', ids: [numbers[0]] }]);
		}
		// 第二次、第三次回复报告的输入到了七成：运行结束时马上压缩。
		return { output: [say('好')], usage: { inputTokens: responses++ >= 1 ? 75_000 : 1_000, cachedTokens: 0, outputTokens: 10 } };
	};
	runtime.runs.start();
	for (const text of ['订会议室', '第二件事', '第三件事']) {
		runtime.messages.send(human.memberId, { kind: 'direct', memberId: host.memberId }, `${text}${'讨论'.repeat(200)}`);
		await runtime.runs.idle();
	}
	const items = runtime.timeline.all(host.memberId);
	assert.deepEqual(items.slice(0, 2).map(item => [item.contextState, item.summaryItemId]), [['pruned', null], ['pruned', null]]);
	assert.deepEqual(items.filter(item => item.kind === 'summary').map(item => item.contextState), ['pruned']);
	await runtime.close();
});

test('压缩请求放不下全部内容时按先后从最早的带：能处理的带完，接着带最近的内容，带到放不下为止', async t => {
	const model = new FakeModel();
	const runtime = testRuntime(t, { models: testModels([{ model: 'fake', contextWindow: 100_000 }]), modelClient: model });
	const human = runtime.members.createHuman('张三');
	const host = addAi(runtime, '沈安');
	const group = runtime.groups.create(human.memberId, '讨论', [host.memberId]);
	const long = (label: string) => `${label} ${'讨论'.repeat(1000)}`;
	model.script = (_, _index, request) => request.textFormat ? proposal([{ op: 'prune', ids: processable(request) }]) : [];
	runtime.runs.start();
	// 先看过 30 条长消息，分两批，免得一次没看过的太多。
	for (const batch of [0, 1]) {
		runtime.runs.pause(host.memberId);
		for (let index = 0; index < 15; index++) runtime.messages.send(human.memberId, { kind: 'direct', memberId: host.memberId }, long(`看过${batch * 15 + index}`));
		runtime.runs.resume(host.memberId);
		await runtime.runs.idle();
	}
	// 再攒 25 条不唤醒的群聊消息，最后一条私聊唤醒它。
	runtime.runs.pause(host.memberId);
	for (let index = 0; index < 25; index++) runtime.messages.send(human.memberId, { kind: 'group', groupId: group.groupId }, long(`新${index}`));
	runtime.messages.send(human.memberId, { kind: 'direct', memberId: host.memberId }, '看看群里说了什么');
	runtime.runs.resume(host.memberId);
	await runtime.runs.idle();

	const [optimization] = model.requests.filter(request => request.textFormat);
	const received = describe(optimization!.input).map(text => text.split(' ')[0]);
	const boundary = /- 内容编号 (\d+) 及排在其后的内容/.exec(taskOf(optimization!))?.[1];
	assert.ok(boundary);
	// 看过的全带上，最近看过的几条（约 5%）不能处理；接着按先后带没看过的，最新的几条没带上。
	assert.ok(received.includes('收到:看过0') && received.includes('收到:看过29') && received.includes('收到:新0'));
	assert.ok(!received.includes('收到:新24') && !received.includes('收到:看看群里说了什么'));
	assert.match(taskOf(optimization!), /只提供了其中一部分/);
	const numbers = processable(optimization!);
	assert.ok(numbers.length > 20 && numbers.length < 30, `能处理 ${numbers.length} 条`);
	// 能处理的都删掉以后，最近看过的几条和没看过的全部进了正常请求。
	const last = describe(model.requests.at(-1)!.input).map(text => text.split(' ')[0]);
	assert.ok(!last.includes('收到:看过0') && last.includes('收到:看过29') && last.includes('收到:新0') && last.includes('收到:新24'));
	assert.ok(runtime.runs.contextUsage(host.memberId).usedTokens < 70_000);
	await runtime.close();
});

test('一次运行一直调用工具时，中途压缩能处理这次运行前面几轮的调用和结果，以及触发它的消息', async t => {
	const model = new FakeModel();
	const runtime = testRuntime(t, { models: testModels([{ model: 'fake', contextWindow: 100_000 }]), modelClient: model, recentRatio: 0 });
	const human = runtime.members.createHuman('张三');
	const host = addAi(runtime, '沈安', { directMessage: 'all' });
	model.script = (_, index, request) => {
		if (request.textFormat) return proposal([{ op: 'prune', ids: processable(request) }]);
		// 第三次调用报告的输入到了七成：下一次请求前压缩。
		return index < 3 ? { output: [sendCall(`c${index}`, human.memberId, `第${index}步`)], usage: { inputTokens: index === 2 ? 75_000 : 1_000, cachedTokens: 0, outputTokens: 10 } } : [];
	};
	runtime.runs.start();
	runtime.messages.send(human.memberId, { kind: 'direct', memberId: host.memberId }, '查一下');
	await runtime.runs.idle();

	const [optimization] = model.requests.filter(request => request.textFormat);
	const results = runtime.timeline.all(host.memberId).filter(item => item.kind === 'model_output').map(item => item.itemId);
	const message = runtime.timeline.all(host.memberId).find(item => item.kind === 'message')!;
	// 第三步的结果没看过，第二步是最近看过的一组，都不能处理；消息和第一步能处理。
	assert.deepEqual(processable(optimization!), [message.itemId, results[0]]);
	assert.ok(taskOf(optimization!).includes(`- 内容编号 ${results[1]} 及排在其后的内容是最近的内容，本次不得处理。`));
	const last = describe(model.requests.at(-1)!.input);
	assert.deepEqual(last.map(text => text.split(':')[0]), ['调用', '结果', '调用', '结果']);
	assert.deepEqual(last.filter(text => text.startsWith('调用')), ['调用:第1步', '调用:第2步']);
	assert.deepEqual(runtime.runs.list(host.memberId).map(run => `${run.kind}/${run.status}/${run.requestCount}`), ['response/completed/5']);
	await runtime.close();
});

test('最近看过的内容按组往前算到上下文长度的 5%，跨过线的那组整组算进去，调用和结果不分开', async t => {
	const model = new FakeModel();
	const runtime = testRuntime(t, { models: testModels([{ model: 'fake', contextWindow: 100_000 }]), modelClient: model });
	const human = runtime.members.createHuman('张三');
	const host = addAi(runtime, '沈安', { directMessage: 'all' });
	model.script = (_, index, request) => {
		if (request.textFormat) return proposal([{ op: 'prune', ids: processable(request) }]);
		// 调用工具，再回复一句：回复跟着调用那一组。回复报告的输入到了七成，运行结束时压缩。
		return index === 0 ? [sendCall('c1', human.memberId, '收到')] : { output: [say('好')], usage: { inputTokens: 75_000, cachedTokens: 0, outputTokens: 10 } };
	};
	runtime.runs.start();
	runtime.runs.pause(host.memberId);
	// 每条约 2000 token；上下文长度的 5% 是 5000。
	for (let index = 0; index < 10; index++) runtime.messages.send(human.memberId, { kind: 'direct', memberId: host.memberId }, `第${index}条 ${'讨论'.repeat(1333)}`);
	runtime.runs.resume(host.memberId);
	await runtime.runs.idle();

	const [optimization] = model.requests.filter(request => request.textFormat);
	const messages = runtime.timeline.all(host.memberId).filter(item => item.kind === 'message').map(item => item.itemId);
	// 往前：调用那一组，第 9、8 条还不到 5000，第 7 条跨过线，整条算进去。
	assert.deepEqual(processable(optimization!), messages.slice(0, 7));
	assert.ok(taskOf(optimization!).includes(`- 内容编号 ${messages[7]} 及排在其后的内容是最近的内容，本次不得处理。`));
	assert.deepEqual(describe(optimization!.input).slice(-4, -1).map(text => text.split(':')[0]), ['调用', '结果', '输出']);
	assert.equal(runtime.timeline.all(host.memberId).filter(item => item.contextState === 'pruned').length, 7);
	await runtime.close();
});

test('能处理的摘要超过上下文长度的四分之一时必须处理其中一部分；摘要的长度按整份方案算，单条可以比原来长', async t => {
	const model = new FakeModel();
	const runtime = testRuntime(t, { models: testModels([{ model: 'fake', contextWindow: 100_000 }]), modelClient: model, recentRatio: 0 });
	const human = runtime.members.createHuman('张三');
	const host = addAi(runtime, '沈安');
	const proposals: ((numbers: number[]) => object[])[] = [
		// 第一次压缩：先给一份摘要合计太长的，再给一份合规的，第二条摘要比它代替的那条长，靠删掉的抵掉。
		numbers => [{ op: 'summarize', ids: numbers.slice(0, 30), summary: 'S'.repeat(160_000) }],
		numbers => [
			{ op: 'summarize', ids: numbers.slice(0, 30), summary: 'S'.repeat(120_000) },
			{ op: 'summarize', ids: [numbers[30]], summary: 'T'.repeat(8_000) },
			{ op: 'prune', ids: numbers.slice(31) },
		],
		// 第二次压缩：摘要已经超过四分之一，先只删别的，再删掉第二条摘要。
		numbers => [{ op: 'prune', ids: numbers.slice(-1) }],
		numbers => [{ op: 'prune', ids: [numbers[1]] }],
	];
	// 看长消息的两次运行报告的输入不多；之后两次运行结束时都到了七成，各压缩一次。
	model.script = (_, _index, request) => request.textFormat
		? proposal(proposals.shift()!(processable(request)))
		: { output: [say('好')], usage: { inputTokens: describe(request.input).at(-1)!.includes('讨论') ? 1_000 : 75_000, cachedTokens: 0, outputTokens: 10 } };
	runtime.runs.start();
	for (const batch of [0, 1]) {
		runtime.runs.pause(host.memberId);
		for (let index = 0; index < 20; index++) runtime.messages.send(human.memberId, { kind: 'direct', memberId: host.memberId }, `第${batch * 20 + index}条 ${'讨论'.repeat(1000)}`);
		runtime.runs.resume(host.memberId);
		await runtime.runs.idle();
	}
	for (const text of ['整理一下', '继续']) {
		runtime.messages.send(human.memberId, { kind: 'direct', memberId: host.memberId }, text);
		await runtime.runs.idle();
	}

	const optimizations = model.requests.filter(request => request.textFormat);
	assert.equal(optimizations.length, 4);
	const problemsOf = (request: IModelRequest) => String((request.input.at(-1) as any).content[0].text);
	assert.match(problemsOf(optimizations[1]!), /- 本方案中的摘要合计未显著短于其代替和删除的内容/);
	assert.doesNotMatch(taskOf(optimizations[0]!), /之前整理的摘要已经占了/);
	assert.match(taskOf(optimizations[2]!), /- 此前整理的摘要已占上下文长度的约 \d+%，超过四分之一：本次必须合并、精简或删除其中一部分。/);
	assert.match(problemsOf(optimizations[3]!), /- 此前整理的摘要占上下文长度的约 \d+%，超过四分之一，但本方案未处理其中任何一条/);
	const summaries = runtime.timeline.all(host.memberId).filter(item => item.kind === 'summary');
	assert.deepEqual(summaries.map(item => item.contextState), ['visible', 'pruned']);
	await runtime.close();
});

test('换了上下文更短的模型、看过的内容本身就放不下时分段压缩：只带最早的一段，直到低于七成', async t => {
	const model = new FakeModel();
	const runtime = testRuntime(t, { models: testModels([{ model: 'big', contextWindow: 1_000_000 }, { model: 'small', contextWindow: 100_000 }]), modelClient: model });
	const human = runtime.members.createHuman('张三');
	const host = addAi(runtime, '沈安');
	model.script = (_, _index, request) => request.textFormat ? proposal([{ op: 'prune', ids: processable(request) }]) : [];
	runtime.runs.start();
	runtime.runs.pause(host.memberId);
	for (let index = 0; index < 60; index++) runtime.messages.send(human.memberId, { kind: 'direct', memberId: host.memberId }, `看过${index} ${'讨论'.repeat(1000)}`);
	runtime.runs.resume(host.memberId);
	await runtime.runs.idle();
	assert.equal(model.requests.filter(request => request.textFormat).length, 0);

	runtime.memberFolders.update(host.memberId, { definition: { model: { provider: 'test', name: 'small' } } });
	runtime.messages.send(human.memberId, { kind: 'direct', memberId: host.memberId }, '换模型了');
	await runtime.runs.idle();

	const optimizations = model.requests.filter(request => request.textFormat);
	assert.ok(optimizations.length >= 1);
	const received = describe(optimizations[0]!.input).map(text => text.split(' ')[0]);
	assert.match(taskOf(optimizations[0]!), /- 上下文过长，本次只提供了其中一部分，其后还有内容。/);
	assert.doesNotMatch(taskOf(optimizations[0]!), /及排在其后的内容/);
	assert.equal(received[0], '收到:看过0');
	assert.ok(!received.includes('收到:看过59') && !received.includes('收到:换模型了'));
	assert.deepEqual(describe(model.requests.at(-1)!.input).at(-1), '收到:换模型了');
	assert.ok(runtime.runs.contextUsage(host.memberId).usedTokens < 70_000);
	assert.deepEqual(runtime.runs.list(host.memberId).map(run => run.status), ['completed', 'completed']);
	await runtime.close();
});

test('没看过的内容超过四成五时从最早的拿出上下文：先拿不唤醒的，放一条带编号的说明，原文查历史还能查到', async t => {
	const model = new FakeModel();
	const runtime = testRuntime(t, { models: testModels([{ model: 'fake', contextWindow: 100_000 }]), modelClient: model });
	const human = runtime.members.createHuman('张三');
	const host = addAi(runtime, '沈安');
	const group = runtime.groups.create(human.memberId, '讨论', [host.memberId]);
	runtime.runs.start();
	runtime.messages.send(human.memberId, { kind: 'direct', memberId: host.memberId }, '你好');
	await runtime.runs.idle();
	runtime.runs.pause(host.memberId);
	runtime.messages.send(human.memberId, { kind: 'direct', memberId: host.memberId }, '先看这个');
	for (let index = 0; index < 40; index++) runtime.messages.send(human.memberId, { kind: 'group', groupId: group.groupId }, `第${index}条 ${'讨论'.repeat(1000)}`);
	runtime.runs.resume(host.memberId);
	await runtime.runs.idle();

	const last = model.requests.at(-1)!;
	const notes = last.input.map(raw => String((raw as any).content?.[0]?.text ?? '')).filter(text => text.includes('内容过多'));
	assert.equal(notes.length, 1);
	const match = /^\[内容编号 (\d+)\]\n由于内容过多，(.+?)收到的内容中有 (\d+) 条未放入上下文，原文仍保留。$/.exec(notes[0]!);
	assert.ok(match, notes[0]);
	assert.match(match[2]!, RANGE_TEXT);
	const count = Number(match[3]);
	assert.ok(count > 5 && count < 40, `拿掉了 ${count} 条`);
	// 会唤醒的私聊更早，但留着；说明放在第一条被拿掉的位置。
	const received = describe(last.input).map(text => text.startsWith('收到:由于内容过多') ? '说明' : text.split(' ')[0]);
	assert.deepEqual(received.slice(1, 5), ['收到:你好', '收到:先看这个', '说明', `收到:第${count}条`]);
	assert.equal(received.length, 3 + 1 + 40 - count);
	const items = runtime.timeline.all(host.memberId);
	assert.deepEqual(items.filter(item => item.contextState === 'omitted').map(item => item.kind === 'message' && runtime.messages.get(item.messageId)!.text.split(' ')[0]),
		Array.from({ length: count }, (_, index) => `第${index}条`));
	const omissions = items.filter(item => item.kind === 'omission');
	assert.equal(omissions.length, 1);
	assert.equal(omissions[0]!.kind === 'omission' && omissions[0]!.omission.rangeText, match[2]);
	assert.equal(model.requests.filter(request => request.textFormat).length, 0);
	const context = { memberId: host.memberId, workingDirectory: process.cwd(), signal: new AbortController().signal };
	const { output } = await runtime.tools.call(context, 'search_history', JSON.stringify({ keywords: ['第0条'] }));
	assert.ok(output.includes('第0条'), output);
	await runtime.close();
});

test('最新的一条会唤醒的内容本身超过四成五时也留着，更早的照常拿掉', async t => {
	const model = new FakeModel();
	const runtime = testRuntime(t, { models: testModels([{ model: 'fake', contextWindow: 45_000 }]), modelClient: model });
	const human = runtime.members.createHuman('张三');
	const host = addAi(runtime, '沈安');
	const group = runtime.groups.create(human.memberId, '讨论', [host.memberId]);
	runtime.runs.start();
	runtime.runs.pause(host.memberId);
	runtime.messages.send(human.memberId, { kind: 'direct', memberId: host.memberId }, '先看这个');
	for (let index = 0; index < 5; index++) runtime.messages.send(human.memberId, { kind: 'group', groupId: group.groupId }, `第${index}条 ${'讨论'.repeat(450)}`);
	// 约 2.25 万 token，超过 45k 的四成五。
	runtime.messages.send(human.memberId, { kind: 'direct', memberId: host.memberId }, `长资料 ${'资料'.repeat(14_990)}`);
	runtime.runs.resume(host.memberId);
	await runtime.runs.idle();

	const received = describe(model.requests.at(-1)!.input).map(text => text.startsWith('收到:由于内容过多') ? '说明' : text.split(' ')[0]);
	assert.deepEqual(received, ['说明', '收到:长资料']);
	// 拉进群聊的变动、5 条群聊消息和更早的私聊「先看这个」。
	assert.match(String((model.requests.at(-1)!.input.find(raw => String((raw as any).content?.[0]?.text).includes('内容过多')) as any).content[0].text), /中有 7 条未放入上下文/);
	assert.deepEqual(runtime.runs.list(host.memberId).map(run => run.status), ['completed']);
	await runtime.close();
});

/**
 * 先用上下文很长的模型看过 250 条长消息，再换成 100k 的模型发一条私聊。模型报告的实际用量是估算的七成，
 * 中文内容常见这样。prune 从这次可以处理的编号里挑要删的。
 */
async function switchToSmallModel(t: Parameters<typeof testRuntime>[0], prune: (numbers: number[]) => number[]) {
	const model = new FakeModel();
	const runtime = testRuntime(t, { models: testModels([{ model: 'big', contextWindow: 1_000_000 }, { model: 'small', contextWindow: 100_000 }]), modelClient: model });
	const human = runtime.members.createHuman('张三');
	const host = addAi(runtime, '沈安');
	model.script = (_, _index, request) => request.textFormat
		? proposal([{ op: 'prune', ids: prune(processable(request)) }])
		: { output: [], usage: { inputTokens: Math.round(estimateTokens(request.input) * 0.7), cachedTokens: 0, outputTokens: 5 } };
	runtime.runs.start();
	for (let batch = 0; batch < 2; batch++) {
		runtime.runs.pause(host.memberId);
		for (let index = 0; index < 125; index++) runtime.messages.send(human.memberId, { kind: 'direct', memberId: host.memberId }, `看过${batch * 125 + index} ${'讨论'.repeat(1000)}`);
		runtime.runs.resume(host.memberId);
		await runtime.runs.idle();
	}
	runtime.memberFolders.update(host.memberId, { definition: { model: { provider: 'test', name: 'small' } } });
	runtime.messages.send(human.memberId, { kind: 'direct', memberId: host.memberId }, '换模型了');
	await runtime.runs.idle();
	return { runtime, host, optimizations: model.requests.filter(request => request.textFormat) };
}

test('实际用量比估算少时，分段压缩前后都按估算比较缩小了多少，一段一段压到低于七成', async t => {
	const { runtime, host, optimizations } = await switchToSmallModel(t, numbers => numbers.length > 1 ? numbers.slice(0, -1) : numbers);
	assert.ok(optimizations.length >= 3, `压了 ${optimizations.length} 轮`);
	assert.ok(runtime.runs.contextUsage(host.memberId).usedTokens < 70_000);
	assert.deepEqual(runtime.runs.list(host.memberId).map(run => run.status), ['completed', 'completed', 'completed']);
	await runtime.close();
});

test('分段压缩连续两轮这一段缩小不到两成就停，压完仍放不下时这次运行失败', async t => {
	// 每轮只删一条。
	const { runtime, host, optimizations } = await switchToSmallModel(t, numbers => numbers.slice(0, 1));
	assert.equal(optimizations.length, 2);
	const [last] = runtime.runs.list(host.memberId);
	assert.equal(last!.status, 'failed');
	assert.match(last!.error!, /^上下文过长（估算约 \d+ token），压缩后仍超过模型上限 100000$/);
	await runtime.close();
});

test('分段压缩有一轮没有进展、下一轮压下来了，接着压完', async t => {
	// 第一轮只删一条，之后每段只留最后一条。
	let round = 0;
	const { runtime, host, optimizations } = await switchToSmallModel(t, numbers => ++round === 1 ? numbers.slice(0, 1) : numbers.length > 1 ? numbers.slice(0, -1) : numbers);
	assert.ok(optimizations.length >= 4, `压了 ${optimizations.length} 轮`);
	assert.ok(runtime.runs.contextUsage(host.memberId).usedTokens < 70_000);
	assert.equal(runtime.runs.list(host.memberId)[0]!.status, 'completed');
	await runtime.close();
});

test('压缩请求放得下全部内容时最多连续压 3 轮，压完仍偏长但放得下就照常请求', async t => {
	const model = new FakeModel();
	const runtime = testRuntime(t, { models: testModels([{ model: 'fake', contextWindow: 100_000 }]), modelClient: model });
	const human = runtime.members.createHuman('张三');
	const host = addAi(runtime, '沈安');
	// 每轮只删最前面的一条短消息，压不到七成以下。
	model.script = (_, _index, request) => request.textFormat ? proposal([{ op: 'prune', ids: processable(request).slice(0, 1) }]) : [];
	runtime.runs.start();
	const long = (index: number) => `第${index}条 ${'讨论'.repeat(1000)}`;
	// 先看过 6 条短消息和 22 条长消息，再收到 22 条长消息。
	const batches = [
		[...Array.from({ length: 6 }, (_, index) => `好${index}`), ...Array.from({ length: 22 }, (_, index) => long(index))],
		Array.from({ length: 22 }, (_, index) => long(22 + index)),
	];
	for (const texts of batches) {
		runtime.runs.pause(host.memberId);
		for (const text of texts) runtime.messages.send(human.memberId, { kind: 'direct', memberId: host.memberId }, text);
		runtime.runs.resume(host.memberId);
		await runtime.runs.idle();
	}

	// 第二批长消息的那次运行里请求前压了 3 轮；运行结束时还在七成以上，马上又压了 3 轮。
	assert.ok(model.requests.filter(request => request.textFormat).every(request => !/只提供了其中一部分/.test(taskOf(request))));
	assert.deepEqual(runtime.runs.list(host.memberId).map(run => `${run.kind}/${run.status}/${run.requestCount}`), [
		'optimization/completed/3', 'response/completed/4', 'response/completed/1',
	]);
	const usage = runtime.runs.contextUsage(host.memberId);
	assert.ok(usage.usedTokens >= 70_000 && usage.usedTokens < 100_000);
	await runtime.close();
});

test('压缩失败后 7 分钟内，运行结束时不再压缩，请求前只在放不下时压缩；成功一次就不再等', async t => {
	const model = new FakeModel();
	const runtime = testRuntime(t, { models: testModels([{ model: 'fake', contextWindow: 100_000 }]), modelClient: model, recentRatio: 0 });
	const human = runtime.members.createHuman('张三');
	const host = addAi(runtime, '沈安');
	let optimizations = 0;
	let reported = 75_000;
	model.script = (_, _index, request) => {
		// 运行结束时的那次压缩两次都给不出合规的方案；之后的给出合规的。
		if (request.textFormat) return ++optimizations <= 2 ? [say('不知道')] : proposal([{ op: 'prune', ids: processable(request) }]);
		// 第一次运行之后都报告到了七成：最近看过的一组不能处理，第二次运行结束时才有能压缩的。
		return { output: [say(ORDER_REPLY)], usage: { inputTokens: model.requests.length > 1 ? reported : 1_000, cachedTokens: 0, outputTokens: 10 } };
	};
	const runs = () => runtime.runs.list(host.memberId).map(run => `${run.kind}/${run.status}/${run.requestCount}`);
	runtime.runs.start();
	for (const text of ['你好', ORDER, '订好了吗']) {
		runtime.messages.send(human.memberId, { kind: 'direct', memberId: host.memberId }, text);
		await runtime.runs.idle();
	}
	// 还放得下：第三次运行请求前、运行结束时都不压缩。
	assert.deepEqual(runs(), ['response/completed/1', 'optimization/failed/2', 'response/completed/1', 'response/completed/1']);

	// 报告的输入超过了上限，下一次请求前放不下了：照样压缩；成功了就不再等，运行结束时又到了七成就接着压缩。
	reported = 120_000;
	for (const text of ['再确认一下', '好的']) {
		runtime.messages.send(human.memberId, { kind: 'direct', memberId: host.memberId }, text);
		await runtime.runs.idle();
	}
	assert.deepEqual(runs().slice(0, 3), ['optimization/completed/1', 'response/completed/2', 'response/completed/1']);
	await runtime.close();
});

test('手动压缩：不管有没有到七成压一轮；全是最近的内容时不能压缩', async t => {
	const model = new FakeModel();
	const runtime = testRuntime(t, { models: testModels([{ model: 'fake', contextWindow: 200_000 }]), modelClient: model });
	const human = runtime.members.createHuman('张三');
	const host = addAi(runtime, '沈安');
	model.script = (_, _index, request) => request.textFormat ? proposal([{ op: 'prune', ids: processable(request).slice(0, 10) }]) : [];
	runtime.runs.start();
	runtime.runs.pause(host.memberId);
	for (let index = 0; index < 33; index++) runtime.messages.send(human.memberId, { kind: 'direct', memberId: host.memberId }, `第${index}条 ${'讨论'.repeat(1000)}`);
	assert.equal(runtime.runs.contextUsage(host.memberId).optimizeProblem, '均为最近的内容，无法压缩');
	assert.throws(() => runtime.runs.optimize(host.memberId), /均为最近的内容，无法压缩/);

	runtime.runs.resume(host.memberId);
	await runtime.runs.idle();
	const before = runtime.runs.contextUsage(host.memberId);
	assert.equal(before.optimizeProblem, null);
	assert.ok(before.usedTokens < 140_000);
	runtime.runs.optimize(host.memberId);
	await runtime.runs.idle();

	const optimizations = model.requests.filter(request => request.textFormat);
	assert.equal(optimizations.length, 1);
	// 都看过了，最近的约 5% 不能处理。
	assert.match(taskOf(optimizations[0]!), /及排在其后的内容是最近的内容，本次不得处理/);
	assert.doesNotMatch(taskOf(optimizations[0]!), /只提供了其中一部分/);
	assert.equal(runtime.timeline.all(host.memberId).filter(item => item.contextState === 'pruned').length, 10);
	assert.ok(runtime.runs.contextUsage(host.memberId).usedTokens < before.usedTokens);
	assert.deepEqual(runtime.runs.list(host.memberId).map(run => `${run.kind}/${run.status}`), ['optimization/completed', 'response/completed']);
	await runtime.close();
});

test('压缩处理掉了没做完的计划：放回计划说明，排在这次压缩的卡片后面、不唤醒成员；下次请求在末尾看到计划原文', async t => {
	const model = new FakeModel();
	const runtime = testRuntime(t, { models: testModels([{ model: 'fake', contextWindow: 200_000 }]), modelClient: model });
	const human = runtime.members.createHuman('张三');
	const host = addAi(runtime, '沈安');
	const target = { kind: 'direct', memberId: host.memberId } as const;
	const items = [{ text: '订会议室', status: 'completed' }, { text: '发通知', status: 'in_progress' }];
	const plan = { type: 'function_call', call_id: 'p1', name: 'update_plan', arguments: JSON.stringify({ items }) } as const;
	model.script = (_, index, request) => request.textFormat ? proposal([{ op: 'prune', ids: processable(request) }]) : index === 0 ? [plan] : [];
	runtime.runs.start();
	runtime.messages.send(human.memberId, target, '订会议室，再发个通知');
	await runtime.runs.idle();
	runtime.runs.pause(host.memberId);
	for (let index = 0; index < 33; index++) runtime.messages.send(human.memberId, target, `第${index}条 ${'讨论'.repeat(1000)}`);
	runtime.runs.resume(host.memberId);
	await runtime.runs.idle();
	const requests = model.requests.length;
	runtime.runs.optimize(host.memberId);
	await runtime.runs.idle();

	// 只有压缩请求，放回的计划说明不唤醒成员。
	assert.deepEqual(model.requests.slice(requests).map(request => !!request.textFormat), [true]);
	const all = runtime.timeline.all(host.memberId);
	assert.equal(all.find(item => item.kind === 'model_output' && item.output['call_id'] === 'p1')!.contextState, 'pruned');
	assert.deepEqual(all.slice(-3).map(item => item.kind), ['optimization', 'pruning', 'plan']);

	runtime.messages.send(human.memberId, target, '进展如何');
	await runtime.runs.idle();
	const tail = timelineOf(model.requests.at(-1)!.input).slice(-2).map(raw => String((raw as any).content[0].text));
	assert.match(tail[0]!, /^\[内容编号 \d+\][^\n]*\n上下文已整理。以下是你用 update_plan 写下的当前计划：\n\{"items":\[\{"text":"订会议室","status":"completed"\},\{"text":"发通知","status":"in_progress"\}\]\}$/);
	assert.match(tail[1]!, /进展如何/);
	await runtime.close();
});

test('服务不支持 json_schema：这次请求改用 json_object 马上重新请求，记作一次重试；之后这个模型直接用 json_object。任务说明总是写明 JSON 格式', async t => {
	const model = new FakeModel();
	const runtime = testRuntime(t, { models: testModels([{ model: 'fake', contextWindow: 200_000 }]), modelClient: model });
	const human = runtime.members.createHuman('张三');
	const host = addAi(runtime, '沈安');
	const rejected = '模型响应失败：<400> InternalError.Algo.InvalidParameter: This text.format type is unavailable now';
	model.script = (_, _index, request) => {
		if (!request.textFormat) return [];
		if (request.textFormat['type'] === 'json_schema') throw new ModelError('response_failed', rejected, false);
		return proposal([{ op: 'prune', ids: processable(request).slice(0, 5) }]);
	};
	runtime.runs.start();
	runtime.runs.pause(host.memberId);
	for (let index = 0; index < 45; index++) runtime.messages.send(human.memberId, { kind: 'direct', memberId: host.memberId }, `第${index}条 ${'讨论'.repeat(1000)}`);
	runtime.runs.resume(host.memberId);
	await runtime.runs.idle();
	for (let round = 0; round < 2; round++) {
		runtime.runs.optimize(host.memberId);
		await runtime.runs.idle();
	}

	const optimizations = model.requests.filter(request => request.textFormat);
	assert.deepEqual(optimizations.map(request => request.textFormat!['type']), ['json_schema', 'json_object', 'json_object']);
	assert.match(taskOf(optimizations[0]!), /只输出一个 JSON 对象/);
	const records = runtime.timeline.all(host.memberId).flatMap(item => item.kind === 'optimization' ? [item.optimization] : []);
	assert.deepEqual(records.map(record => [record.status, record.requests.length, record.requests[0]!.retries]), [['completed', 1, [rejected]], ['completed', 1, []]]);
	await runtime.close();
});

test('压缩的经过推给网页端、记进压缩记录：只推思考，activity 写第几次请求；自动重试过的错误记下；暂停时记一条停止的，带着推出来的思考', async t => {
	let compactions = 0;
	let requested = () => {};
	const client: IModelClient = {
		async respond(request, signal, onDelta) {
			await Promise.resolve();
			if (!request.textFormat) return { output: [], usage: undefined };
			// 第一次压缩想到一半，一直等到被暂停。
			if (++compactions === 1) {
				onDelta('reasoning', '想到一半');
				return new Promise<IModelResponse>((_resolve, reject) => {
					requested();
					signal.addEventListener('abort', () => reject(signal.reason), { once: true });
				});
			}
			onDelta('reasoning', '先看');
			onDelta('text', '{');
			// 第二次压缩：第一次请求断了，重试拿到的方案指向不存在的内容，带着不合规的地方再请求一次。
			if (compactions === 2) throw new ModelError('http_503', '模型服务返回 503', true);
			if (compactions === 3) {
				const reasoning = { type: 'reasoning', summary: [{ type: 'summary_text', text: '先看旧内容' }], encrypted_content: '加密' };
				return { output: [reasoning, ...proposal([{ op: 'prune', ids: [9999] }])], usage: { inputTokens: 900, cachedTokens: 800, outputTokens: 30 } };
			}
			return { output: proposal([{ op: 'prune', ids: processable(request).slice(0, 10) }]), usage: undefined };
		},
	};
	const runtime = testRuntime(t, { models: testModels([{ model: 'fake', contextWindow: 200_000 }]), modelClient: client });
	const human = runtime.members.createHuman('张三');
	const host = addAi(runtime, '沈安');
	const deltas: string[] = [];
	const requestNumbers: (number | null)[] = [];
	runtime.events.subscribe(({ event }) => {
		if (event.type === 'run.delta' && event.memberId === host.memberId) deltas.push(`${event.kind}:${event.attempt}:${event.delta}`);
		if (event.type === 'member.activity' && event.activity?.phase === 'optimizing') requestNumbers.push(event.activity.optimizationRequest);
	});
	runtime.runs.start();
	runtime.runs.pause(host.memberId);
	for (let index = 0; index < 33; index++) runtime.messages.send(human.memberId, { kind: 'direct', memberId: host.memberId }, `第${index}条 ${'讨论'.repeat(1000)}`);
	runtime.runs.resume(host.memberId);
	await runtime.runs.idle();

	const reached = new Promise<void>(resolve => { requested = resolve; });
	runtime.runs.optimize(host.memberId);
	await reached;
	runtime.runs.pause(host.memberId);
	await runtime.runs.idle();
	runtime.runs.resume(host.memberId);
	runtime.runs.optimize(host.memberId);
	await runtime.runs.idle();

	// 输出的是方案的 JSON，不推。自动重试的那次 attempt 是 2。
	assert.deepEqual(deltas, ['reasoning:1:想到一半', 'reasoning:1:先看', 'reasoning:2:先看', 'reasoning:1:先看']);
	assert.deepEqual(requestNumbers, [null, 1, null, 1, 2]);
	const records = runtime.timeline.all(host.memberId).flatMap(item => item.kind === 'optimization' ? [item.optimization] : []);
	assert.deepEqual(records.map(record => `${record.trigger}/${record.status}/${record.error}`), ['manual/stopped/已暂停', 'manual/completed/null']);
	assert.deepEqual(records[0]!.requests.map(request => [request.reasoning, request.output]), [['想到一半', null]]);
	assert.equal(records[0]!.estimate.after, null);
	const [first, second] = records[1]!.requests;
	assert.deepEqual({ ...first!, requestId: 0 }, {
		requestId: 0, reasoning: '先看旧内容', output: JSON.stringify({ ops: [{ op: 'prune', ids: [9999] }] }), problems: ['不存在内容编号 9999'],
		retries: ['模型服务返回 503'], inputTokens: 900, cachedTokens: 800, outputTokens: 30,
	});
	assert.deepEqual([second!.problems, second!.retries], [[], []]);
	await runtime.close();
});

/** 输入里的思考和工具调用，按先后：思考原样，调用写成 call_id。 */
function reasoningOf(input: readonly object[]): (object | string)[] {
	return input.flatMap((raw): (object | string)[] => {
		const item = raw as Record<string, any>;
		return item['type'] === 'reasoning' ? [item] : item['type'] === 'function_call' ? [String(item['call_id'])] : [];
	});
}

const FOREIGN = { type: 'reasoning', summary: [], content: [{ type: 'reasoning_text', text: '此步骤由其他模型完成，无可附带的思考内容。' }] };

test('换了模型：别的模型的思考去掉加密，有明文带明文、没有明文带摘要，调用了工具却没有思考的补一句说明；同一个模型的照原样带回', async t => {
	const model = new FakeModel();
	const runtime = testRuntime(t, { models: testModels([{ model: 'a' }, { model: 'b' }]), modelClient: model });
	const human = runtime.members.createHuman('张三');
	const host = addAi(runtime, '沈安', { directMessage: 'all' });
	model.script = (_, index) => [
		[{ type: 'reasoning', id: 'rs_0', summary: [{ type: 'summary_text', text: '先回复张三' }], encrypted_content: '加密a0' }, sendCall('c0', human.memberId, '收到')],
		[{ type: 'reasoning', id: 'rs_1', summary: [], content: [{ type: 'reasoning_text', text: '再补充一句' }], encrypted_content: '加密a1' }, sendCall('c1', human.memberId, '补充')],
		[sendCall('c2', human.memberId, '最后一句')],
		[],
		[{ type: 'reasoning', id: 'rs_4', summary: [], encrypted_content: '加密b4' }, say('好')],
	][index] ?? [];
	const fromHuman = async (text: string) => {
		runtime.messages.send(human.memberId, { kind: 'direct', memberId: host.memberId }, text);
		await runtime.runs.idle();
	};
	runtime.runs.start();
	await fromHuman('在吗');
	runtime.memberFolders.setModel(host.memberId, { provider: 'test', name: 'b' }, null);
	await fromHuman('还在吗');
	await fromHuman('再问一次');

	const [, , , sameModel, switched, after] = model.requests;
	assert.deepEqual([sameModel!.model, switched!.model, after!.model], ['a', 'b', 'b']);
	// 同一个模型：照原样带回，只去掉 id。
	assert.deepEqual(reasoningOf(sameModel!.input), [
		{ type: 'reasoning', summary: [{ type: 'summary_text', text: '先回复张三' }], encrypted_content: '加密a0' }, 'c0',
		{ type: 'reasoning', summary: [], content: [{ type: 'reasoning_text', text: '再补充一句' }], encrypted_content: '加密a1' }, 'c1',
		'c2',
	]);
	assert.deepEqual(reasoningOf(switched!.input), [
		{ type: 'reasoning', summary: [], content: [{ type: 'reasoning_text', text: '先回复张三' }] }, 'c0',
		{ type: 'reasoning', summary: [], content: [{ type: 'reasoning_text', text: '再补充一句' }] }, 'c1',
		FOREIGN, 'c2',
	]);
	// 换过去的模型自己的思考，照原样带回给它。
	assert.deepEqual(reasoningOf(after!.input).at(-1), { type: 'reasoning', summary: [], encrypted_content: '加密b4' });
	await runtime.close();
});

test('运行中途改了模型，从下一次请求开始用新的', async t => {
	const model = new FakeModel();
	const runtime = testRuntime(t, { models: testModels([{ model: 'a' }, { model: 'b' }]), modelClient: model });
	const human = runtime.members.createHuman('张三');
	const host = addAi(runtime, '沈安', { directMessage: 'all' });
	model.script = (_, index) => {
		if (index > 0) return [];
		runtime.memberFolders.setModel(host.memberId, { provider: 'test', name: 'b' }, null);
		return [sendCall('c0', human.memberId, '收到')];
	};
	runtime.runs.start();
	runtime.messages.send(human.memberId, { kind: 'direct', memberId: host.memberId }, '在吗');
	await runtime.runs.idle();

	assert.deepEqual(model.requests.map(request => request.model), ['a', 'b']);
	assert.deepEqual(reasoningOf(model.requests[1]!.input), [FOREIGN, 'c0']);
	assert.deepEqual(runtime.runs.list(host.memberId).map(run => run.status), ['completed']);
	await runtime.close();
});

test('停在工具结果上时，重试、恢复不需要新内容就接着运行，停下时的调用和结果没看过、不能压缩；别的时候不因此运行', async t => {
	const model = new FakeModel();
	const runtime = testRuntime(t, { models: testModels([{ model: 'fake', contextWindow: 100_000 }]), modelClient: model, recentRatio: 0 });
	const human = runtime.members.createHuman('张三');
	const host = addAi(runtime, '沈安', { directMessage: 'all' });
	let fail = true;
	let prune = false;
	const last = (request: IModelRequest) => timelineOf(request.input).at(-1) as Record<string, any>;
	model.script = (_, _index, request) => {
		if (request.textFormat) return proposal([{ op: 'prune', ids: prune ? processable(request) : [9999] }]);
		// 看到工具结果的那次请求：出错，或者接着做完。
		if (last(request)['type'] === 'function_call_output') {
			if (fail) throw new ModelError('server', '模型服务返回 500', false);
			return [];
		}
		// 订会议室：调用工具，报告的输入到了七成，下一次请求前要压缩。
		if (String(last(request)['content'][0].text).includes(ORDER)) {
			return { output: [sendCall('c1', human.memberId, '订好了')], usage: { inputTokens: 75_000, cachedTokens: 0, outputTokens: 10 } };
		}
		return { output: [say('你好呀')], usage: { inputTokens: 1_000, cachedTokens: 0, outputTokens: 10 } };
	};
	const fromHuman = async (text: string) => {
		runtime.messages.send(human.memberId, { kind: 'direct', memberId: host.memberId }, text);
		await runtime.runs.idle();
	};
	const statuses = () => runtime.runs.list(host.memberId).map(run => run.status).reverse();
	const lastResponse = () => model.requests.filter(request => !request.textFormat).at(-1)!;
	runtime.runs.start();
	await fromHuman('你好');
	await fromHuman(ORDER);
	assert.deepEqual(statuses(), ['completed', 'failed']);
	assert.deepEqual(runtime.runs.stopReason(host.memberId), { status: 'failed', error: '模型服务返回 500' });

	// 不是用户恢复、重试时，不因此运行。
	runtime.runs.wake(host.memberId);
	await runtime.runs.idle();
	assert.deepEqual(statuses(), ['completed', 'failed']);

	fail = false;
	prune = true;
	// 请求前的压缩刚失败过，冷却时间里还放得下就不压缩：过了冷却时间再重试。
	t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 8 * 60_000 });
	runtime.runs.retry(host.memberId);
	await runtime.runs.idle();
	assert.deepEqual(statuses(), ['completed', 'failed', 'completed']);
	assert.equal(runtime.runs.stopReason(host.memberId), undefined);
	// 接着运行的请求末尾就是停下时的工具结果，没有新内容。
	assert.equal(last(lastResponse())['type'], 'function_call_output');
	// 压缩时停下时的调用和结果没看过，它和前面最近看过的一组（订会议室）不能处理，更早的照常处理。
	const order = runtime.timeline.all(host.memberId).filter(item => item.kind === 'message')[1]!;
	assert.ok(taskOf(model.requests.filter(request => request.textFormat).at(-1)!).includes(`- 内容编号 ${order.itemId} 及排在其后的内容`));
	// 第一次运行请求前的压缩两次都指向不存在的内容，出错了，还放得下就接着请求：出错的压缩也有记录，排在后来那次成功的前面。
	assert.deepEqual(runtime.timeline.all(host.memberId).map(item => `${item.kind}/${item.contextState}`), [
		'message/pruned', 'model_output/pruned', 'message/visible', 'model_output/visible', 'tool_result/visible', 'optimization/visible', 'optimization/visible', 'pruning/visible', 'model_output/unreturned',
	]);
	const failed = runtime.timeline.all(host.memberId).find(item => item.kind === 'optimization');
	assert.ok(failed?.kind === 'optimization');
	assert.equal(failed.optimization.status, 'failed');
	assert.equal(failed.optimization.error, '压缩未给出可用的操作：不存在内容编号 9999');
	assert.equal(failed.optimization.estimate.after, null);
	assert.deepEqual(failed.optimization.requests.map(request => request.problems), [['不存在内容编号 9999'], ['不存在内容编号 9999']]);
	// 已经接着做完了，再点重试不运行。
	runtime.runs.retry(host.memberId);
	await runtime.runs.idle();
	assert.equal(statuses().length, 3);

	// 恢复暂停也一样。
	fail = true;
	await fromHuman(ORDER);
	assert.equal(statuses().at(-1), 'failed');
	fail = false;
	runtime.runs.pause(host.memberId);
	runtime.runs.resume(host.memberId);
	await runtime.runs.idle();
	assert.equal(statuses().at(-1), 'completed');
	assert.equal(last(lastResponse())['type'], 'function_call_output');
	await runtime.close();
});

test('运行时退出时停在工具结果上：重启后不自动接着运行，状态是运行中断，点重试接着运行', async t => {
	const model = new FakeModel();
	const runtime = testRuntime(t, { models: testModels(), modelClient: model });
	const human = runtime.members.createHuman('张三');
	const host = addAi(runtime, '沈安', { directMessage: 'all' });
	model.script = (_, index) => {
		if (index === 0) return [sendCall('c1', human.memberId, '收到')];
		if (index === 1) {
			// 看到工具结果的那次请求时运行时退出。
			void runtime.runs.shutdown();
			throw new Error('请求被中止');
		}
		return [];
	};
	const statuses = () => runtime.runs.list(host.memberId).map(run => `${run.status}${run.error ? `(${run.error})` : ''}`).reverse();
	runtime.runs.start();
	runtime.messages.send(human.memberId, { kind: 'direct', memberId: host.memberId }, '在吗');
	await runtime.runs.idle();
	assert.deepEqual(statuses(), ['stopped(运行时退出)']);

	runtime.runs.start();
	await runtime.runs.idle();
	assert.deepEqual(statuses(), ['stopped(运行时退出)']);
	assert.deepEqual(runtime.runs.stopReason(host.memberId), { status: 'interrupted', error: '运行时退出' });

	runtime.runs.retry(host.memberId);
	await runtime.runs.idle();
	assert.deepEqual(statuses(), ['stopped(运行时退出)', 'completed']);
	assert.equal(runtime.runs.stopReason(host.memberId), undefined);
	assert.equal(model.requests.length, 3);
	await runtime.close();
});

test('上下文用量：各部分加起来等于已用；运行中、历史不满 48k 时不能手动压缩', async t => {
	const model = new FakeModel();
	const runtime = testRuntime(t, { models: testModels([{ model: 'fake', contextWindow: 1_000_000 }]), modelClient: model });
	const host = addAi(runtime, '沈安');
	const problems: (string | null)[] = [];
	model.script = (_, index) => {
		problems.push(runtime.runs.contextUsage(host.memberId).optimizeProblem);
		return { output: [say('好')], usage: { inputTokens: index === 0 ? 30_000 : 200_000, cachedTokens: 0, outputTokens: 5 } };
	};
	const total = (usage: IContextUsageInfo) => Object.values(usage.categories).reduce((sum, tokens) => sum + tokens, 0);
	runtime.runs.start();
	runtime.timeline.appendUserInput(host.memberId, { text: '你好' });
	await runtime.runs.idle();

	const small = runtime.runs.contextUsage(host.memberId);
	assert.equal(small.contextWindow, 1_000_000);
	// 上次请求报告的 30000，加上之后的输出「好」的估算。
	assert.ok(small.usedTokens > 30_000 && small.usedTokens < 30_100);
	assert.equal(total(small), small.usedTokens);
	assert.equal(small.historyTokens, small.categories.incoming + small.categories.toolCalls + small.categories.outputs + small.categories.summaries);
	assert.match(small.optimizeProblem!, /^历史内容 .+，达到 48k 后才能压缩$/);
	assert.throws(() => runtime.runs.optimize(host.memberId), /达到 48k 后才能压缩/);

	for (let index = 0; index < 3; index++) runtime.timeline.appendUserInput(host.memberId, { text: '长'.repeat(30_000) });
	await runtime.runs.idle();
	const large = runtime.runs.contextUsage(host.memberId);
	assert.equal(total(large), large.usedTokens);
	assert.ok(large.historyTokens >= 48_000);
	assert.equal(large.optimizeProblem, null);
	assert.deepEqual(problems, ['正在运行，请在运行结束后再压缩', '正在运行，请在运行结束后再压缩']);
	await runtime.close();
});

test('按比例分摊取整后加起来正好等于总数', () => {
	assert.deepEqual(distribute({ a: 1, b: 1, c: 1 }, 10), { a: 4, b: 3, c: 3 });
	assert.deepEqual(distribute({ a: 3, b: 1 }, 2), { a: 2, b: 0 });
	assert.deepEqual(distribute({ a: 0, b: 0 }, 5), { a: 0, b: 0 });
});
