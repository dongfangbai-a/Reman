import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { IModelClient, IModelRequest, IModelResponse } from '../models/client.ts';
import { addAi, memoryOf, testModels, testRuntime } from '../testing.ts';
import type { IModelOutputItem } from '../timeline/timeline.ts';
import { applyMemoryOperation, checkMemoryLimit, MEMORY_LIMIT } from './memory.ts';

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

function memorySection(request: IModelRequest): string | undefined {
	return memoryOf(request.input);
}

test('记忆的修改：添加接在末尾；替换要求原文只出现一次，找不到时附上全文；删掉整行不留空行', () => {
	assert.equal(applyMemoryOperation('', { op: 'add', text: ' 张三喜欢周五开会 ' }), '张三喜欢周五开会');
	assert.equal(applyMemoryOperation('甲', { op: 'add', text: '乙' }), '甲\n乙');
	assert.equal(applyMemoryOperation('甲\n乙\n丙', { op: 'replace', oldText: '乙', newText: '丁' }), '甲\n丁\n丙');
	assert.equal(applyMemoryOperation('甲\n乙\n丙', { op: 'replace', oldText: '乙', newText: '' }), '甲\n丙');
	assert.throws(() => applyMemoryOperation('甲\n乙', { op: 'replace', oldText: '丙', newText: '丁' }), /未找到 old_text.*\n甲\n乙$/s);
	assert.throws(() => applyMemoryOperation('甲乙甲', { op: 'replace', oldText: '甲', newText: '丁' }), /出现了多处/);
	assert.throws(() => applyMemoryOperation('', { op: 'replace', oldText: '甲', newText: '丁' }), /记忆当前为空/);
});

test('上限只拦变长的修改：超过上限后缩短的修改仍然可以做', () => {
	const full = 'x'.repeat(MEMORY_LIMIT);
	assert.doesNotThrow(() => checkMemoryLimit('', full));
	assert.throws(() => checkMemoryLimit(full, `${full}y`), /修改后记忆将有 3001 字，超过上限 3000 字，未做修改。记忆当前 3000 字/);
	assert.doesNotThrow(() => checkMemoryLimit(`${full}yy`, `${full}y`));
});

test('manage_memory：写进 memory.md，结果写明字数；开头的记忆是快照，成员自己改的不刷新，用户改的刷新', async t => {
	const model = new FakeModel();
	const runtime = testRuntime(t, { models: testModels(), modelClient: model });
	const ai = addAi(runtime, '沈安');
	const tool = (callId: string, args: object) => call(callId, 'manage_memory', args);
	model.script = [
		[tool('c1', { action: 'add', text: '张三喜欢周五开会' })],
		[tool('c2', { action: 'replace', old_text: '周四', new_text: '周五' })],
		[tool('c3', { action: 'add', text: 'x'.repeat(MEMORY_LIMIT) })],
		[],
		[],
	];
	runtime.runs.start();
	runtime.timeline.appendUserInput(ai.memberId, { text: '记一下' });
	await runtime.runs.idle();

	const results = runtime.timeline.all(ai.memberId).flatMap(item => item.kind === 'tool_result' ? [item.result.output] : []);
	assert.equal(results[0], '已添加。记忆当前 8 字，上限 3000 字。');
	assert.match(results[1]!, /未找到 old_text.*\n张三喜欢周五开会$/s);
	assert.match(results[2]!, /^修改后记忆将有 3009 字，超过上限 3000 字，未做修改。/);
	const file = join(runtime.memberFolders.snapshot().folders.find(folder => folder.memberId === ai.memberId)!.path, 'memory.md');
	assert.equal(readFileSync(file, 'utf8'), '张三喜欢周五开会\n');
	// 这次运行开始时记忆是空的，后面几次请求开头也没有记忆。
	assert.deepEqual(model.requests.map(memorySection), [undefined, undefined, undefined, undefined]);

	runtime.memories.write(ai.memberId, '张三喜欢周一开会', true);
	runtime.timeline.appendUserInput(ai.memberId, { text: '改好了' });
	await runtime.runs.idle();
	assert.equal(memorySection(model.requests.at(-1)!), '张三喜欢周一开会');

	// 直接改文件：成员文件夹同步后刷新。
	writeFileSync(file, '\uFEFF张三喜欢周二开会\r\n');
	runtime.memberFolders.sync();
	runtime.timeline.appendUserInput(ai.memberId, { text: '又改了' });
	await runtime.runs.idle();
	assert.equal(memorySection(model.requests.at(-1)!), '张三喜欢周二开会');
	await runtime.close();
});
