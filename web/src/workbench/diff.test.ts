import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDiff } from './diff.ts';

test('diff 拆成行：文件头不显示，改名这类照写；按 @@ 算原来和现在的行号；去掉 Windows 换行的 \\r', () => {
	const text = [
		'diff --git a/old.ts b/new.ts',
		'similarity index 90%',
		'rename from old.ts',
		'rename to new.ts',
		'index 1111111..2222222 100644',
		'--- a/old.ts',
		'+++ b/new.ts',
		'@@ -10,3 +10,4 @@ function main() {',
		' a\r',
		'-b\r',
		'+B\r',
		'+C\r',
		' d\r',
		'\\ No newline at end of file',
		'',
	].join('\n');
	assert.deepEqual(parseDiff(text), [
		{ kind: 'note', text: 'similarity index 90%' },
		{ kind: 'note', text: 'rename from old.ts' },
		{ kind: 'note', text: 'rename to new.ts' },
		{ kind: 'hunk', text: '@@ -10,3 +10,4 @@ function main() {' },
		{ kind: 'context', text: ' a', old: 10, new: 10 },
		{ kind: 'remove', text: '-b', old: 11 },
		{ kind: 'add', text: '+B', new: 11 },
		{ kind: 'add', text: '+C', new: 12 },
		{ kind: 'context', text: ' d', old: 12, new: 13 },
		{ kind: 'note', text: '\\ No newline at end of file' },
	]);
});

test('diff 拆成行：两个文件段（没认出改名时是一删一增）分开算；合并冲突的 diff 不算行号', () => {
	const text = [
		'diff --git a/a.txt b/a.txt',
		'deleted file mode 100644',
		'--- a/a.txt',
		'+++ /dev/null',
		'@@ -1 +0,0 @@',
		'-x',
		'diff --git a/b.txt b/b.txt',
		'new file mode 100644',
		'@@ -0,0 +1 @@',
		'+y',
	].join('\n');
	assert.deepEqual(parseDiff(text).map(line => [line.kind, line.text, line.old, line.new]), [
		['note', 'deleted file mode 100644', undefined, undefined],
		['hunk', '@@ -1 +0,0 @@', undefined, undefined],
		['remove', '-x', 1, undefined],
		['note', 'new file mode 100644', undefined, undefined],
		['hunk', '@@ -0,0 +1 @@', undefined, undefined],
		['add', '+y', undefined, 1],
	]);
	const combined = parseDiff(['diff --cc a.txt', '@@@ -1,1 -1,1 +1,5 @@@', '++<<<<<<< HEAD', ' +ours', '- theirs', '  same'].join('\n'));
	assert.deepEqual(combined.map(line => line.kind), ['hunk', 'add', 'add', 'remove', 'context']);
	assert.ok(combined.every(line => line.old === undefined && line.new === undefined));
});
