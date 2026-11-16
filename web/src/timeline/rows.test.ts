import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IModelOutputItem, TimelineEntry } from '../api/types.ts';
import { buildRows, reasoningText, reuseRows, type Row } from './rows.ts';

let nextId = 1;

function output(requestId: number, item: IModelOutputItem, contextState: 'visible' | 'unreturned' = 'visible'): TimelineEntry {
	const itemId = nextId++;
	return { kind: 'model_output', itemId, requestId, runId: 1, output: item, wakes: false, contextState, summaryItemId: null, createdAt: itemId };
}

const think = (text: string): IModelOutputItem => ({ type: 'reasoning', summary: [{ type: 'summary_text', text }] });
const say = (text: string): IModelOutputItem => ({ type: 'message', role: 'assistant', content: text ? [{ type: 'output_text', text }] : [] });
const call = (callId: string): IModelOutputItem => ({ type: 'function_call', call_id: callId, name: 'shell', arguments: '{"command":"ls"}' });

/** 每一行写成「种类/状态」，过程写出里面的每一步。 */
function shape(rows: readonly Row[]): string[] {
	return rows.map(row => row.kind === 'process'
		? `process: ${row.steps.map(step => step.kind === 'call' ? 'call' : `${step.kind}/${step.state}`).join(', ')}`
		: row.kind);
}

test('没有实际产出的一轮（运行时记成 unreturned）：思考、其他输出照常显示，什么都没有时写一步空回复；有产出的一轮照常', () => {
	const entries = [
		output(1, think('先看看')), output(1, call('c1')),
		output(2, think('不用再说了'), 'unreturned'), output(2, say(''), 'unreturned'),
		output(3, say(''), 'unreturned'),
		output(4, { type: 'custom_tool_call', name: 'x' }, 'unreturned'),
		output(5, think('回答')), output(5, say('好的')),
	];
	assert.deepEqual(shape(buildRows(entries, [], true)), [
		'process: thinking/visible, call, thinking/unreturned, empty/unreturned, other/unreturned, thinking/visible',
		'output',
	]);
});

function entry(fields: Record<string, unknown>): TimelineEntry {
	const itemId = nextId++;
	return { itemId, wakes: false, contextState: 'visible', summaryItemId: null, createdAt: itemId, ...fields } as unknown as TimelineEntry;
}

const counts = { summaries: 0, messages: 1, thinking: 0, outputs: 0, calls: 0, events: 0 };
const record = () => entry({ kind: 'optimization', optimization: { trigger: 'manual', status: 'completed', error: null, startedAt: 0, endedAt: 0, estimate: { before: 2, after: 1 }, requests: [] } });
const memory = () => entry({ kind: 'memory_change', change: { operations: [], length: 0 } });
const summary = () => entry({ kind: 'summary', summary: { text: '摘要', anchorItemId: 1, startTime: 0, endTime: 0, rangeText: '', counts } });
const pruning = () => entry({ kind: 'pruning', pruning: { counts } });
const plan = () => entry({ kind: 'plan', plan: { items: [{ text: '订会议室', status: 'pending' }] } });

test('压缩记录带着紧跟在后面的卡片；前面没有记录的卡片、隔开了的卡片单独一行；只压缩的运行不画分隔线，出错的也不画', () => {
	const entries = [summary(), pruning(), plan(), record(), memory(), summary(), summary(), pruning(), plan(), output(9, say('好')), summary(), record(), record()];
	const rows = buildRows(entries, [
		{ runId: 1, kind: 'optimization', status: 'failed', endedAt: 1000 },
		{ runId: 2, kind: 'response', status: 'completed', endedAt: 1000 },
	] as never, true);
	assert.deepEqual(rows.map(row => row.kind === 'optimization' ? `optimization: ${row.cards.map(card => card.kind).join(', ')}` : row.kind === 'entry' ? row.entry.kind : row.kind), [
		'summary', 'pruning', 'plan',
		'optimization: memory_change, summary, summary, pruning, plan',
		'output', 'summary',
		'optimization: ', 'optimization: ',
		'run',
	]);
});

test('重新排行时内容没变的行沿用上一次的对象；调用有了结果的那段过程和新增的行是新的', () => {
	const first = output(1, think('先看看'));
	const pending = output(1, call('c1'));
	const message = entry({ kind: 'user_input', input: { text: '你好', attachments: [] } });
	const before = buildRows([message, first, pending], [], true);
	const result = entry({ kind: 'tool_result', requestId: 1, runId: 1, result: { callId: 'c1', name: 'shell', output: 'ok', isError: false } });
	const reply = output(2, say('好的'));
	const after = reuseRows(before, buildRows([message, first, pending, result, reply], [], true));
	assert.deepEqual(after.map((row, index) => row === before[index]), [true, false, false]);
	assert.equal(reuseRows(after, buildRows([message, first, pending, result, reply], [], true)).every((row, index) => row === after[index]), true);
});

test('思考的文字：摘要优先，没有摘要时用 content 里的原文，不管每段标的是什么 type', () => {
	assert.equal(reasoningText({ type: 'reasoning', summary: [{ type: 'summary_text', text: '摘要' }], content: [{ type: 'reasoning_text', text: '原文' }] }), '摘要');
	assert.equal(reasoningText({ type: 'reasoning', summary: [], content: [{ type: 'reasoning_text', text: '原文' }] }), '原文');
	// 有的服务（如 gitee 上的 DeepSeek）把原文放在 content 里却标成 summary_text。
	assert.equal(reasoningText({ type: 'reasoning', summary: [], content: [{ type: 'summary_text', text: '原文' }] }), '原文');
	assert.equal(reasoningText({ type: 'reasoning', summary: [], encrypted_content: 'x' }), '');
});
