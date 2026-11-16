import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { temporaryDirectory } from '../../testing.ts';
import { DataProtection } from '../protection.ts';
import type { IToolContext } from '../tools.ts';
import { createFileTools } from './fileTools.ts';
import { formatWarning } from './formatCheck.ts';

/** 反斜杠单独取：测试里要写的正是「一个反斜杠」，直接写会跟源码转义混在一起。 */
const BACKSLASH = String.fromCharCode(92);

/** 在临时工作目录里拿 write_file 和 edit_file。 */
function setup(t: Parameters<typeof temporaryDirectory>[0]) {
	const workspace = temporaryDirectory(t);
	const [write, edit] = createFileTools(new DataProtection()).tools;
	const context = { memberId: 'M_TEST', workingDirectory: workspace } as IToolContext;
	return { workspace, write: write!, edit: edit!, context };
}

test('格式检查：合法的 JSON、JSONL、YAML 不提示', () => {
	assert.equal(formatWarning('a.json', '{"a": 1}'), '');
	assert.equal(formatWarning('a.jsonl', '{"a": 1}\n\n{"b": 2}\n'), '');
	assert.equal(formatWarning('a.yaml', 'a: 1\nb: [1, 2]\n'), '');
	assert.equal(formatWarning('a.yml', '- 1\n- 2\n'), '');
});

test('格式检查：不是这些后缀就不检查', () => {
	assert.equal(formatWarning('a.txt', '{"a": '), '');
	assert.equal(formatWarning('a.md', 'whatever'), '');
	assert.equal(formatWarning('Makefile', '\tbad'), '');
	assert.equal(formatWarning('a.js', 'function {'), '');
});

test('格式检查：非法 JSON 的提示里带位置', () => {
	// shadow-relay 那场的原样：JSON 字符串里一个反斜杠加点，是非法转义，整个文件解析不了。
	const content = '{\n  "evidence": "queries matching ^[0-9a-f]{8}' + BACKSLASH + '.cc$"\n}';
	const warning = formatWarning('analysis.json', content);
	// 提示是接在工具结果后面的一行，所以自己带前导换行。
	assert.match(warning, /\n⚠️ 不是合法的 JSON：/);
	assert.match(warning, /position \d+/);
	assert.match(warning, /line 2 column \d+/);
});

test('格式检查：JSONL 指出坏在哪一行', () => {
	const warning = formatWarning('rows.jsonl', '{"a": 1}\n{"b": 2}\n{"c": oops}\n');
	assert.match(warning, /第 3 行/);
});

test('格式检查：YAML 的提示里带行列', () => {
	const warning = formatWarning('config.yaml', 'a: 1\nb: [1, 2\n');
	assert.match(warning, /不是合法的 YAML/);
	assert.match(warning, /第 \d+ 行第 \d+ 列/);
});

test('格式检查：空内容当成占位，不提示', () => {
	assert.equal(formatWarning('a.json', ''), '');
	assert.equal(formatWarning('a.json', '\n\n'), '');
	assert.equal(formatWarning('a.yaml', '   '), '');
	assert.equal(formatWarning('a.jsonl', ''), '');
});

test('格式检查：超过大小上限时跳过', () => {
	// YAML 上限 8 MB：内容非法但超过上限就不查，也不提示（解析要在主线程上占内存）。
	const huge = 'a: [1, 2\n' + '#'.repeat(8 * 1024 * 1024);
	assert.equal(formatWarning('a.yaml', huge), '');
});

test('write_file：写成非法 JSON 时，结果后面补上提示', async t => {
	const { workspace, write, context } = setup(t);
	const content = `{"a": "${BACKSLASH}."}`;
	const result = String(await write.execute(context, { path: 'out.json', content }));
	assert.match(result, /^已新建 out\.json，1 行/);
	assert.match(result, /不是合法的 JSON/);
	// 文件照样写进去了：提示是补充信息，不是失败。
	assert.equal(readFileSync(join(workspace, 'out.json'), 'utf8'), content);
});

test('write_file：覆盖带 BOM 的 JSON 文件，不因为 BOM 报错', async t => {
	const { workspace, write, context } = setup(t);
	// 原文件有 BOM：写回时 BOM 会留着，但它是文件头，不是内容的一部分。
	writeFileSync(join(workspace, 'bom.json'), String.fromCharCode(0xFEFF) + '{"a": 1}\n');
	const result = String(await write.execute(context, { path: 'bom.json', content: '{"a": 2}', overwrite: true }));
	assert.equal(result, '已覆盖 bom.json，原有 1 行，现有 1 行');
});

test('write_file：写成合法 JSON 时，结果和以前一样', async t => {
	const { write, context } = setup(t);
	const result = String(await write.execute(context, { path: 'out.json', content: '{"a": 1}' }));
	assert.equal(result, '已新建 out.json，1 行');
});

test('edit_file：把 JSON 改坏能抓到，改回来就不提示', async t => {
	const { workspace, edit, context } = setup(t);
	writeFileSync(join(workspace, 'out.json'), '{"a": 1}\n');
	// 少写一个右括号：文件还在，但已经不是合法 JSON。
	const broken = String(await edit.execute(context, { path: 'out.json', edits: [{ old_text: '1}', new_text: '1' }] }));
	assert.match(broken, /^已修改 out\.json，1 处/);
	assert.match(broken, /不是合法的 JSON/);
	const fixed = String(await edit.execute(context, { path: 'out.json', edits: [{ old_text: '{"a": 1', new_text: '{"a": 1}' }] }));
	assert.equal(fixed, '已修改 out.json，1 处');
});