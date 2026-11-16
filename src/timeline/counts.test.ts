import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addCounts, countContent } from './counts.ts';
import type { IModelOutputItem, TimelineItem } from './timeline.ts';

const base = { itemId: 1, wakes: false, contextState: 'visible', summaryItemId: null, createdAt: 0 } as const;
const output = (value: IModelOutputItem): TimelineItem => ({ ...base, kind: 'model_output', requestId: 1, runId: 1, output: value });
const text = (value: string): IModelOutputItem => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: value }] });
const call = (name: string): IModelOutputItem => ({ type: 'function_call', call_id: name, name, arguments: '{}' });

test('按种类数压缩处理的内容：发出的消息算消息，工具结果和调用算一次，没有文字的直接输出不算，服务端工具算工具调用', () => {
	const items = [
		{ ...base, kind: 'summary', summary: { text: '旧摘要', anchorItemId: 1, startTime: 0, endTime: 0, rangeText: '', counts: addCounts([]) } },
		{ ...base, kind: 'message', messageId: 1 },
		{ ...base, kind: 'user_input', input: { text: '你好', attachments: [] } },
		output(call('send_message')),
		output({ type: 'reasoning', summary: [] }),
		output(text('写好了')),
		output(text('  ')),
		output(call('read_file')),
		{ ...base, kind: 'tool_result', requestId: 1, runId: 1, result: { callId: 'read_file', name: 'read_file', output: '内容', isError: false } },
		output({ type: 'web_search_call', id: 'ws_1' }),
		{ ...base, kind: 'reminder', reminder: { reminderId: 'R_1', time: '', note: '' } },
		{ ...base, kind: 'omission', omission: { anchorItemId: 1, startTime: 0, endTime: 0, rangeText: '', count: 3 } },
		{ ...base, kind: 'change_notice', notice: { text: '', brief: '' } },
		{ ...base, kind: 'plan', plan: { items: [] } },
	] as TimelineItem[];
	assert.deepEqual(countContent(items), { summaries: 1, messages: 3, thinking: 1, outputs: 1, calls: 2, events: 4 });
});

test('几份统计加在一起', () => {
	const one = { summaries: 1, messages: 2, thinking: 0, outputs: 1, calls: 3, events: 0 };
	assert.deepEqual(addCounts([one, one]), { summaries: 2, messages: 4, thinking: 0, outputs: 2, calls: 6, events: 0 });
});
