import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { temporaryDirectory } from '../testing.ts';
import { TerminalSettings } from './settings.ts';

test('没有 terminals.json 时用默认的 16 个，没有警告', t => {
	const settings = new TerminalSettings(join(temporaryDirectory(t), 'terminals.json'));
	assert.deepEqual(settings.limits, { maxAiTerminals: 16, problem: null });
});

test('不传路径（测试里）也用默认值', () => {
	assert.deepEqual(new TerminalSettings(undefined).limits, { maxAiTerminals: 16, problem: null });
});

test('读得到文件里写的值', t => {
	const path = join(temporaryDirectory(t), 'terminals.json');
	writeFileSync(path, '{ "maxAiTerminals": 4 }\n');
	assert.deepEqual(new TerminalSettings(path).limits, { maxAiTerminals: 4, problem: null });
});

test('值不合法时按默认值处理，并记下原因', t => {
	const path = join(temporaryDirectory(t), 'terminals.json');
	writeFileSync(path, '{ "maxAiTerminals": 99 }\n');
	const limits = new TerminalSettings(path).limits;
	assert.equal(limits.maxAiTerminals, 16);
	assert.match(limits.problem ?? '', /maxAiTerminals 必须是 1 到 32 的整数/);
});

test('文件读不出来时按默认值处理，并记下原因', t => {
	const path = join(temporaryDirectory(t), 'terminals.json');
	writeFileSync(path, '{ 坏了');
	assert.equal(new TerminalSettings(path).limits.maxAiTerminals, 16);
	assert.match(new TerminalSettings(path).limits.problem ?? '', /terminals.json 读不出来/);
});

test('改上限时校验，写回文件', t => {
	const path = join(temporaryDirectory(t), 'terminals.json');
	const settings = new TerminalSettings(path);
	assert.throws(() => settings.setMaxAiTerminals(0), /maxAiTerminals 必须是 1 到 32 的整数/);
	assert.throws(() => settings.setMaxAiTerminals('8'), /maxAiTerminals 必须是 1 到 32 的整数/);
	assert.deepEqual(settings.setMaxAiTerminals(8), { maxAiTerminals: 8, problem: null });
	assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { maxAiTerminals: 8 });
});
