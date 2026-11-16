import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import type { IModelClient, IModelRequest, IModelResponse } from '../models/client.ts';
import { runtimeDirectories } from '../dataDirectory.ts';
import { Runtime } from '../runtime.ts';
import { addAi, openingOf, temporaryDirectory, testModels, testRuntime, timelineOf, withoutNumbers } from '../testing.ts';
import type { IModelOutputItem } from '../timeline/timeline.ts';
import { toolSummary } from '../tools/tools.ts';

/** 假的模型：按脚本返回，并记下每次请求。 */
class FakeModel implements IModelClient {
	readonly requests: IModelRequest[] = [];
	script: (request: IModelRequest) => IModelOutputItem[] | IModelResponse = () => [];

	async respond(request: IModelRequest): Promise<IModelResponse> {
		this.requests.push(request);
		await Promise.resolve();
		const result = this.script(request);
		return Array.isArray(result) ? { output: result, usage: undefined } : result;
	}
}

function say(text: string): IModelOutputItem {
	return { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] };
}

/** 返回改成员文件的函数：配置这些技能，成员现在有的工具里去掉这些。 */
function configurer(runtime: Runtime, memberId: string) {
	const defaults = runtime.tools.list(memberId).filter(entry => entry.configurable && entry.enabled).map(entry => entry.name);
	return (skills: readonly string[], without: readonly string[]) => {
		runtime.memberFolders.update(memberId, { definition: { skills: [...skills], tools: defaults.filter(name => !without.includes(name)) } });
	};
}

function notices(runtime: Runtime, memberId: string) {
	return runtime.timeline.all(memberId).flatMap(item => item.kind === 'change_notice' ? [{ ...item.notice, wakes: item.wakes }] : []);
}

/** 请求看到的最后一条内容的正文。 */
function lastText(request: IModelRequest): string {
	return String((withoutNumbers(timelineOf(request.input)).at(-1) as Record<string, any>)['content'][0].text);
}

test('工具列表、运行环境和通讯录是快照：变动不改快照，和上一次请求比，在时间线末尾追加一条说明，不唤醒；去掉又加回来不算变动', async t => {
	const model = new FakeModel();
	const runtime = testRuntime(t, { models: testModels(), modelClient: model });
	runtime.skills.create('notes', '记笔记的方法', '# 笔记');
	runtime.skills.create('drafts', '写草稿的方法', '# 草稿');
	const human = runtime.members.createHuman('张三');
	const host = addAi(runtime, '沈安', { skills: ['notes'] });
	const configure = configurer(runtime, host.memberId);
	const send = async (text: string) => {
		runtime.messages.send(human.memberId, { kind: 'direct', memberId: host.memberId }, text);
		await runtime.runs.idle();
	};
	runtime.runs.start();
	await send('在吗');

	runtime.runs.pause(host.memberId);
	configure(['notes', 'drafts'], ['browser']);
	const group = runtime.groups.create(human.memberId, '项目组', [host.memberId]);
	const other = runtime.members.createHuman('李四');
	runtime.runs.resume(host.memberId);
	await send('还在吗');

	const [first, second] = model.requests;
	assert.deepEqual(second!.tools, first!.tools);
	assert.equal(openingOf(second!.input), openingOf(first!.input));
	const labels = new Map([[human.memberId, `张三(${human.memberId}，真人)`], [host.memberId, `沈安(${host.memberId}，AI，你自己)`]]);
	const text = [
		'不再可用的工具：browser',
		'新增技能：',
		'- drafts：写草稿的方法',
		`新加入的群聊「项目组」(${group.groupId})，创建者：张三(${human.memberId}，真人)，未关注，成员：${group.members.map(membership => labels.get(membership.memberId)).join('、')}`,
		`新增可私聊的成员：李四(${other.memberId}，真人)`,
	].join('\n');
	assert.equal(lastText(second!), text);
	assert.deepEqual(notices(runtime, host.memberId), [{ text, brief: '工具 browser 不再可用；新增技能 drafts；加入群聊「项目组」；新增可私聊成员 李四', wakes: false }]);

	// 和上一次请求比：browser 去掉后又能用了算新增，技能去掉又加回来不算。
	configure(['notes'], ['browser']);
	configure(['notes', 'drafts'], []);
	await send('再问一次');
	const browser = runtime.tools.get('browser')!;
	assert.equal(lastText(model.requests.at(-1)!), `新增渐进式工具：\n- browser：${toolSummary(browser)}`);
	assert.deepEqual(model.requests.at(-1)!.tools, first!.tools);

	await send('最后一次');
	assert.equal(notices(runtime, host.memberId).length, 2);
	await runtime.close();
});

test('换了模型或压缩之后重新生成快照，不追加说明', async t => {
	const model = new FakeModel();
	const runtime = testRuntime(t, { models: testModels([{ model: 'a', contextWindow: 100_000 }, { model: 'b', contextWindow: 100_000 }]), modelClient: model, recentRatio: 0 });
	const human = runtime.members.createHuman('张三');
	const host = addAi(runtime, '沈安');
	const configure = configurer(runtime, host.memberId);
	const send = async (text: string) => {
		runtime.messages.send(human.memberId, { kind: 'direct', memberId: host.memberId }, text);
		await runtime.runs.idle();
	};
	const names = (request: IModelRequest) => request.tools.map(tool => tool.name);
	// 第二次回复的时候去掉了修改文件（write_file、edit_file），回复报告的输入到了七成，运行结束时马上压缩，删掉第一次的问答。
	model.script = request => {
		if (request.textFormat) return [say(JSON.stringify({ ops: [{ op: 'prune', ids: [1] }] }))];
		if (model.requests.length === 1) return [say('你好')];
		if (model.requests.length > 2) return [];
		configure([], ['files']);
		return { output: [say('在')], usage: { inputTokens: 75_000, cachedTokens: 0, outputTokens: 10 } };
	};
	runtime.runs.start();
	await send('你好');
	await send('在吗');
	assert.ok(names(model.requests[1]!).includes('edit_file'));
	assert.ok(model.requests[2]!.textFormat);
	await send('压缩之后');
	assert.deepEqual(model.requests.at(-1)!.tools, runtime.tools.definitions(host.memberId));
	assert.ok(!names(model.requests.at(-1)!).includes('edit_file'));

	configure([], ['files', 'browser']);
	runtime.memberFolders.setModel(host.memberId, { provider: 'test', name: 'b' }, null);
	await send('换了模型');
	assert.equal(model.requests.at(-1)!.model, 'b');
	assert.deepEqual(model.requests.at(-1)!.tools, runtime.tools.definitions(host.memberId));
	assert.ok(!names(model.requests.at(-1)!).includes('browser'));
	assert.deepEqual(notices(runtime, host.memberId), []);
	await runtime.close();
});

/** 完整的时间和到分钟的时间。 */
const FULL_TIME = /^时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2} 周.（[\w/]+，UTC[+-]\d{2}:\d{2}）$/;
const MINUTE_TIME = /^时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;

/** 请求里张三私聊来的每条消息：正文和编号后面带的时间（没带时是 undefined）。 */
function received(request: IModelRequest): [string, string | undefined][] {
	return request.input.flatMap(raw => {
		const item = raw as Record<string, any>;
		if (item['role'] !== 'user' || !Array.isArray(item['content'])) return [];
		const match = /^\[内容编号 \d+\](?: (时间：[^\n]*))?\n张三\(\w+\) 私聊你：\n([\s\S]*)$/.exec(String(item['content'][0].text));
		return match ? [[match[2]!, match[1]]] : [];
	});
}

test('时间：收到的内容写在编号后面；新成员收到第一条时写完整的，离最晚的一条满 10 分钟写到分钟的，换了一天写完整的；连着调用工具、运行开始时不写；写下的留在原处', async t => {
	let now = Date.UTC(2026, 10, 5, 20, 0);
	const model = new FakeModel();
	const runtime = testRuntime(t, { models: testModels(), modelClient: model, now: () => now });
	const human = runtime.members.createHuman('张三');
	const host = addAi(runtime, '沈安');
	const send = async (text: string) => {
		runtime.messages.send(human.memberId, { kind: 'direct', memberId: host.memberId }, text);
		await runtime.runs.idle();
	};
	// 第三次请求调用工具，拿到结果时又过了 20 分钟：同一次运行里连着调用工具，没有新收到的内容，不写。
	model.script = () => {
		if (model.requests.length !== 3) return [say('好')];
		now += 20 * 60_000;
		return [{ type: 'function_call', call_id: 'c1', name: 'nothing', arguments: '{}' }];
	};
	runtime.runs.start();
	await send('一');
	now += 5 * 60_000;
	await send('二');
	now += 10 * 60_000;
	await send('三');
	now += 24 * 60 * 60_000;
	await send('四');
	// 暂停时收到的内容：收到时离上一条时间不到 10 分钟，不写；隔了 15 分钟才恢复，运行开始时也不补。
	runtime.runs.pause(host.memberId);
	runtime.messages.send(human.memberId, { kind: 'direct', memberId: host.memberId }, '五');
	now += 15 * 60_000;
	runtime.runs.resume(host.memberId);
	await runtime.runs.idle();

	assert.equal(model.requests.length, 6);
	assert.doesNotMatch(openingOf(model.requests[0]!.input), /时间/);
	const [[first, firstTime]] = received(model.requests[0]!) as [[string, string]];
	// 新成员：第一条消息带完整的时间。
	assert.equal(first, '一');
	assert.match(firstTime, FULL_TIME);
	// 5 分钟后不带；15 分钟后带到分钟的。
	assert.deepEqual(received(model.requests[1]!).at(-1), ['二', undefined]);
	const [third, thirdTime] = received(model.requests[2]!).at(-1)!;
	assert.equal(third, '三');
	assert.match(thirdTime!, MINUTE_TIME);
	assert.equal(received(model.requests[3]!).length, 3);
	// 换了一天：完整的时间。
	const [fourth, fourthTime] = received(model.requests[4]!).at(-1)!;
	assert.equal(fourth, '四');
	assert.match(fourthTime!, FULL_TIME);
	// 运行开始时不写时间：最后一条还是收到的「五」，不带时间。
	assert.deepEqual(received(model.requests[5]!).at(-1), ['五', undefined]);
	assert.match(lastText(model.requests[5]!), /五$/);
	// 每次请求都以上一次请求的全部输入开头：写下的时间留在原处，输出接在模型看到的同样的内容后面。
	for (let index = 1; index < 6; index++) {
		assert.deepEqual(model.requests[index]!.input.slice(0, model.requests[index - 1]!.input.length), model.requests[index - 1]!.input);
	}
	// 时间记在收到的内容上，模型输出和工具结果不带；以后读出来还是写下时的那一行。
	const timed = runtime.timeline.all(host.memberId).filter(item => item.time);
	assert.deepEqual(timed.map(item => [item.kind, item.time!.full]), [['message', true], ['message', false], ['message', true]]);
	assert.deepEqual(timed.map(item => item.time!.text), [firstTime, thirdTime, fourthTime]);
	await runtime.close();
});

test('时间感知：关了之后收到的内容不带时间，下次请求前追加说明；运行规则跟着快照，换了模型或压缩之后才改；再开又带上', async t => {
	let now = Date.UTC(2026, 10, 5, 20, 0);
	const model = new FakeModel();
	const runtime = testRuntime(t, { models: testModels([{ model: 'a' }, { model: 'b' }]), modelClient: model, now: () => now });
	const human = runtime.members.createHuman('张三');
	const host = addAi(runtime, '沈安');
	const send = async (text: string) => {
		runtime.messages.send(human.memberId, { kind: 'direct', memberId: host.memberId }, text);
		await runtime.runs.idle();
	};
	const rules = (request: IModelRequest) => String((request.input[0] as Record<string, any>)['content'][0].text);
	const TIME_RULE = '# 时间\n系统会不定期提供时间：写在收到的内容的内容编号之后，表示收到该内容的时刻。并非每条内容都带有时间，最近一条带时间的内容最接近当前时刻。';
	model.script = () => [say('好')];
	runtime.runs.start();
	await send('一');
	assert.ok(rules(model.requests[0]!).includes(TIME_RULE));
	assert.ok(runtime.members.get(host.memberId)!.timeAwareness);

	// 关掉：之后收到的不带时间，下次请求前说明；规则不改，开头不变，缓存不断。
	runtime.memberFolders.update(host.memberId, { definition: { timeAwareness: false } });
	assert.equal(runtime.members.get(host.memberId)!.timeAwareness, false);
	now += 30 * 60_000;
	await send('二');
	assert.deepEqual(received(model.requests[1]!).at(-1), ['二', undefined]);
	const off = '系统已停止提供时间。上下文中已有的时间仅表示当时的时刻，不代表当前时刻。';
	assert.equal(lastText(model.requests[1]!), off);
	assert.deepEqual(model.requests[1]!.input.slice(0, model.requests[0]!.input.length), model.requests[0]!.input);
	// 已经写下的时间不变。
	assert.match(received(model.requests[1]!)[0]![1]!, FULL_TIME);

	// 换了模型，快照重新生成，规则里不再说时间。
	runtime.memberFolders.setModel(host.memberId, { provider: 'test', name: 'b' }, null);
	now += 24 * 60 * 60_000;
	await send('三');
	assert.ok(!rules(model.requests[2]!).includes('# 时间'));
	assert.deepEqual(received(model.requests[2]!).at(-1), ['三', undefined]);

	// 再打开：之后收到的又带时间，下次请求前说明；规则等下次重新生成快照才加回来。
	runtime.memberFolders.update(host.memberId, { definition: { model: { provider: 'test', name: 'b' } } });
	await send('四');
	const on = '系统会不定期提供时间：写在收到的内容的内容编号之后，表示收到该内容的时刻。';
	assert.equal(lastText(model.requests[3]!), on);
	assert.ok(!rules(model.requests[3]!).includes('# 时间'));
	// 和上下文里还留着的时间比：最晚的完整时间是一天前的，这条带完整的。
	const [fourth, fourthTime] = received(model.requests[3]!).at(-1)!;
	assert.equal(fourth, '四');
	assert.match(fourthTime!, FULL_TIME);
	runtime.memberFolders.setModel(host.memberId, null, null);
	await send('五');
	assert.ok(rules(model.requests[4]!).includes(TIME_RULE));
	assert.deepEqual(notices(runtime, host.memberId), [
		{ text: off, brief: '关闭时间感知', wakes: false },
		{ text: on, brief: '开启时间感知', wakes: false },
	]);
	await runtime.close();
});

test('开头：身份和规则是开发者消息，成员设定到通讯录是一条用户消息，运行环境里没有时间；后面是收到的内容，编号后面带着完整的时间', async t => {
	const model = new FakeModel();
	const runtime = testRuntime(t, { models: testModels(), modelClient: model });
	const human = runtime.members.createHuman('张三');
	const host = addAi(runtime, '沈安');
	runtime.memberFolders.update(host.memberId, { prompt: '你负责订会议室。' });
	runtime.memories.write(host.memberId, '张三喜欢周五开会', true);
	runtime.runs.start();
	runtime.messages.send(human.memberId, { kind: 'direct', memberId: host.memberId }, '在吗');
	await runtime.runs.idle();

	const input = model.requests[0]!.input as Record<string, any>[];
	assert.deepEqual([input[0]!['role'], input[1]!['role'], input[2]!['role'], input.length], ['developer', 'user', 'user', 3]);
	assert.match(openingOf(input), /^# 成员设定\n[\s\S]*你负责订会议室。\n\n# 你的记忆\n[\s\S]*张三喜欢周五开会\n\n# 运行环境\n- 操作系统：[\s\S]*\n\n# 通讯录\n/);
	assert.doesNotMatch(openingOf(input), /时间/);
	// 时间写在内容编号那一行的后面，不另占一条。
	assert.match(input[2]!['content'][0].text, /^\[内容编号 \d+\] 时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2} 周.（[\w/]+，UTC[+-]\d{2}:\d{2}）\n[\s\S]*在吗$/);
	await runtime.close();
});

test('通讯录：每个群写群名和 ID、创建者、关注没有，下一行是成员，自己注明「你自己」；然后是能私聊的成员', async t => {
	const model = new FakeModel();
	const runtime = testRuntime(t, { models: testModels(), modelClient: model });
	const human = runtime.members.createHuman('张三');
	const host = addAi(runtime, '沈安');
	const other = addAi(runtime, '北辰');
	const theirs = runtime.groups.create(human.memberId, '项目组', [host.memberId, other.memberId]);
	const own = runtime.groups.create(host.memberId, '小组', [human.memberId]);
	runtime.groups.setWatching(own.groupId, host.memberId, true, 'self');
	runtime.runs.start();
	runtime.messages.send(human.memberId, { kind: 'direct', memberId: host.memberId }, '在吗');
	await runtime.runs.idle();

	// 同一时刻进群的按 ID 排，成员列表照群里的顺序写。两个 AI 成员默认不能私聊，能私聊的只有张三。
	const labels = new Map([[human.memberId, `张三(${human.memberId}，真人)`], [host.memberId, `沈安(${host.memberId}，AI，你自己)`], [other.memberId, `北辰(${other.memberId}，AI)`]]);
	const membersOf = (groupId: string) => runtime.groups.get(groupId)!.members.map(membership => labels.get(membership.memberId)).join('、');
	const opening = openingOf(model.requests[0]!.input);
	assert.equal(opening.slice(opening.indexOf('# 通讯录')), [
		'# 通讯录',
		'已关注的群聊中，每条新消息都会提醒你处理；未关注的群聊中，只有点名你的消息会提醒你，其他消息不单独提醒，这些消息在你下次处理时一并提供。',
		'',
		'## 群聊',
		`- 「项目组」(${theirs.groupId})，创建者：张三(${human.memberId}，真人)，未关注`,
		`  成员：${membersOf(theirs.groupId)}`,
		`- 「小组」(${own.groupId})，创建者：沈安(${host.memberId}，AI，你自己)，已关注`,
		`  成员：${membersOf(own.groupId)}`,
		'',
		'## 可私聊的成员',
		`- 张三(${human.memberId}，真人)`,
	].join('\n'));
	await runtime.close();
});

test('运行时重启后上下文不变：开头一样，之前的输入原样留下，不因为重启追加时间', async t => {
	let now = Date.UTC(2026, 10, 5, 20, 0);
	const directory = temporaryDirectory(t);
	const open = (model: FakeModel) => new Runtime(join(directory, 'runtime.sqlite'), {
		dataDirectory: directory, ...runtimeDirectories(directory), portableGitDirectory: null, models: testModels(), modelClient: model, now: () => now,
	});
	const before = new FakeModel();
	before.script = () => [say('好')];
	const first = open(before);
	const human = first.members.createHuman('张三');
	const host = addAi(first, '沈安');
	first.runs.start();
	first.messages.send(human.memberId, { kind: 'direct', memberId: host.memberId }, '一');
	await first.runs.idle();
	await first.close();

	// 隔了 5 分钟重启，再收到一条：不到 10 分钟，不追加时间。
	now += 5 * 60_000;
	const after = new FakeModel();
	after.script = () => [say('好')];
	const second = open(after);
	second.runs.start();
	second.messages.send(human.memberId, { kind: 'direct', memberId: host.memberId }, '二');
	await second.runs.idle();
	const previous = before.requests[0]!.input;
	const next = after.requests[0]!.input;
	assert.deepEqual(after.requests[0]!.tools, before.requests[0]!.tools);
	assert.deepEqual(next.slice(0, previous.length), previous);
	assert.match(lastText(after.requests[0]!), /二$/);
	await second.close();
});
