import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { ShellLocator } from '../shells/shells.ts';
import { realPath, temporaryDirectory } from '../testing.ts';
import { GitReader, parseNameStatus, parseNumstat, parseStatus } from './git.ts';

const gitPath = new ShellLocator(() => undefined).git();
const skip = gitPath ? false : '未找到 git';
const reader = new GitReader(() => gitPath);

/** 测试里自己动手改仓库用的 git：固定作者和时间，不读使用者的全局配置。 */
function git(cwd: string, ...args: string[]): string {
	return execFileSync(gitPath!, args, {
		cwd,
		encoding: 'utf8',
		env: {
			...process.env,
			GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
			GIT_CONFIG_NOSYSTEM: '1',
			GIT_AUTHOR_NAME: '张三', GIT_AUTHOR_EMAIL: 'zhang@example.com', GIT_COMMITTER_NAME: '张三', GIT_COMMITTER_EMAIL: 'zhang@example.com',
			GIT_AUTHOR_DATE: '2026-11-07T10:00:00+08:00', GIT_COMMITTER_DATE: '2026-11-07T10:00:00+08:00',
		},
	});
}

function repository(t: TestContext): string {
	const root = join(temporaryDirectory(t), 'app');
	mkdirSync(root);
	git(root, 'init', '-q', '-b', 'main');
	git(root, 'config', 'core.autocrlf', 'false');
	return root;
}

function commit(root: string, files: Record<string, string>, message: string): void {
	for (const [name, content] of Object.entries(files)) {
		mkdirSync(join(root, name, '..'), { recursive: true });
		writeFileSync(join(root, name), content);
	}
	git(root, 'add', '-A');
	git(root, 'commit', '-q', '-m', message);
}

/** 建一个指向文件的符号链接；Windows 没开开发者模式时建不了，返回 false。 */
function trySymlink(target: string, path: string): boolean {
	try {
		symlinkSync(target, path, 'file');
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'EPERM') return false;
		throw error;
	}
}

test('解析 status：分支、远程、各组改动，改名带原来的路径，路径里有空格', () => {
	const output = [
		'# branch.oid 1234567890abcdef1234567890abcdef12345678', '# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -1',
		'1 .M N... 100644 100644 100644 aaaa bbbb src/a b.ts',
		'1 A. N... 000000 100644 100644 0000 cccc new.ts',
		'2 R. N... 100644 100644 100644 dddd dddd R100 lib/新.ts', 'lib/旧.ts',
		'u UU N... 100644 100644 100644 100644 eeee ffff 0000 conflict.ts',
		'? notes/草稿 1.md',
		'',
	].join('\0');
	const parsed = parseStatus(output);
	assert.equal(parsed.branch, 'main');
	assert.deepEqual(parsed.upstream, { name: 'origin/main', ahead: 2, behind: 1 });
	assert.deepEqual(parsed.unstaged, [{ path: 'src/a b.ts', status: 'modified' }]);
	assert.deepEqual(parsed.staged, [{ path: 'lib/新.ts', oldPath: 'lib/旧.ts', status: 'renamed' }, { path: 'new.ts', status: 'added' }]);
	assert.deepEqual(parsed.conflicted, [{ path: 'conflict.ts', status: 'modified' }]);
	assert.deepEqual(parsed.untracked, [{ path: 'notes/草稿 1.md', status: 'added' }]);
	assert.equal(parseStatus('# branch.oid (initial)\0# branch.head (detached)\0').oid, null);
});

test('解析 numstat 和 name-status：改名按现在的路径记，二进制没有行数', () => {
	const numstat = parseNumstat(['3\t1\tsrc/a.ts', '-\t-\tlogo.png', '0\t0\t', 'old.ts', 'new.ts', ''].join('\0'));
	assert.deepEqual(Object.fromEntries(numstat), { 'src/a.ts': { added: 3, removed: 1 }, 'logo.png': { binary: true }, 'new.ts': { added: 0, removed: 0 } });
	assert.deepEqual(parseNameStatus(['M', 'src/a.ts', 'R092', 'old.ts', 'new.ts', 'D', 'gone.ts', ''].join('\0')), [
		{ path: 'src/a.ts', status: 'modified' },
		{ path: 'new.ts', oldPath: 'old.ts', status: 'renamed' },
		{ path: 'gone.ts', status: 'deleted' },
	]);
});

test('仓库：子目录也算，给出根目录和分支；不是仓库时是 null', { skip }, async t => {
	const root = repository(t);
	commit(root, { 'src/index.ts': 'export {};\n' }, '第一次提交');
	const inside = await reader.repository(join(root, 'src'));
	// 临时目录在 Windows 上可能是 8.3 短名，git 给的是展开后的路径，两边都归一化再比。
	assert.deepEqual(inside, { available: true, repository: { root: realPath(resolve(root)), branch: 'main' } });
	const outside = temporaryDirectory(t);
	assert.deepEqual(await reader.repository(outside), { available: true, repository: null });
	assert.deepEqual(await reader.repository(join(outside, '没有')), { available: true, repository: null });
	assert.deepEqual(await new GitReader(() => undefined).repository(root), { available: false, repository: null });
	// 打开着的标签，仓库被删了：说文件夹没了，不是未找到 git。
	await assert.rejects(reader.status(join(outside, '没有')), { code: 'not_found', message: '仓库文件夹已不存在' });
});

test('改动：已暂存、未暂存、未跟踪分组，带行数；改名、二进制；和远程比领先几个、上次获取的时间', { skip }, async t => {
	const remote = repository(t);
	commit(remote, { 'a.txt': '一\n二\n三\n', 'old.txt': '要改名\n', 'logo.bin': '\0\x01\x02' }, '第一次提交');
	const root = join(remote, '..', 'clone');
	git(join(remote, '..'), 'clone', '-q', remote, root);
	git(root, 'config', 'core.autocrlf', 'false');
	commit(root, { 'b.txt': '新文件\n' }, '第二次提交');
	git(root, 'fetch', '-q');

	writeFileSync(join(root, 'a.txt'), '一\n二改了\n三\n四\n');
	git(root, 'mv', 'old.txt', 'new.txt');
	writeFileSync(join(root, 'staged.txt'), '暂存的\n');
	git(root, 'add', 'staged.txt');
	writeFileSync(join(root, 'staged.txt'), '暂存的\n又改了\n');
	writeFileSync(join(root, 'logo.bin'), '\0\x03');
	mkdirSync(join(root, '新目录'));
	writeFileSync(join(root, '新目录', '草稿 1.md'), '# 草稿\n');

	const status = await reader.status(root);
	assert.equal(status.branch, 'main');
	assert.equal(status.head?.subject, '第二次提交');
	assert.deepEqual(status.upstream, { name: 'origin/main', ahead: 1, behind: 0 });
	assert.ok(status.fetchedAt !== null && status.fetchedAt > Date.now() - 60_000);
	assert.equal(status.state, null);
	assert.deepEqual(status.changes.staged, [
		{ path: 'new.txt', oldPath: 'old.txt', status: 'renamed', added: 0, removed: 0 },
		{ path: 'staged.txt', status: 'added', added: 1, removed: 0 },
	]);
	assert.deepEqual(status.changes.unstaged, [
		{ path: 'a.txt', status: 'modified', added: 2, removed: 1 },
		{ path: 'logo.bin', status: 'modified', binary: true },
		{ path: 'staged.txt', status: 'modified', added: 1, removed: 0 },
	]);
	assert.deepEqual(status.changes.untracked, [{ path: '新目录/草稿 1.md', status: 'added' }]);
	assert.deepEqual(status.changes.conflicted, []);
	assert.equal(status.truncated, false);

	const unstaged = await reader.diff(root, { file: 'a.txt', area: 'unstaged' });
	assert.match(unstaged.diff, /^@@ -1,3 \+1,4 @@\n 一\n-二\n\+二改了\n 三\n\+四$/m);
	assert.deepEqual([unstaged.binary, unstaged.truncated], [false, false]);
	const renamed = await reader.diff(root, { file: 'new.txt', oldPath: 'old.txt', area: 'staged' });
	assert.match(renamed.diff, /rename from old\.txt\nrename to new\.txt/);
	assert.equal((await reader.diff(root, { file: 'logo.bin', area: 'unstaged' })).binary, true);
	assert.deepEqual(await reader.diff(root, { file: '新目录/草稿 1.md', area: 'untracked' }), { diff: '@@ -0,0 +1,1 @@\n+# 草稿', binary: false, truncated: false });
	await assert.rejects(reader.diff(root, { file: '新目录', area: 'untracked' }), /是文件夹/);
	await assert.rejects(reader.diff(root, { file: '没有的.md', area: 'untracked' }), /文件不存在/);
	if (trySymlink('a.txt', join(root, '链接'))) {
		assert.deepEqual(await reader.diff(root, { file: '链接', area: 'untracked' }), { diff: '@@ -0,0 +1,1 @@\n+a.txt', binary: false, truncated: false });
	}
	await assert.rejects(reader.diff(root, { file: '../clone/a.txt', area: 'unstaged' }), /相对路径/);
});

test('提交历史：只沿第一个父提交，翻页接着上一页往下取；一个提交的说明和改了的文件；第一个提交和空的比', { skip }, async t => {
	const root = repository(t);
	assert.deepEqual(await reader.log(root, undefined, 50), []);
	commit(root, { 'a.txt': '一\n' }, '第一次提交');
	commit(root, { 'a.txt': '一\n二\n', 'b.txt': '新的\n' }, '第二次提交\n\n详细说明');
	commit(root, { 'b.txt': '改了\n' }, '第三次提交');

	const first = await reader.log(root, undefined, 2);
	assert.deepEqual(first.map(item => item.subject), ['第三次提交', '第二次提交']);
	assert.equal(first[0]!.author, '张三');
	assert.equal(first[0]!.authoredAt, Date.parse('2026-11-07T10:00:00+08:00'));
	const second = await reader.log(root, first.at(-1)!.hash, 2);
	assert.deepEqual(second.map(item => item.subject), ['第一次提交']);

	const detail = await reader.commit(root, first[1]!.hash);
	assert.equal(detail.message, '第二次提交\n\n详细说明');
	assert.deepEqual(detail.files, [{ path: 'a.txt', status: 'modified', added: 1, removed: 0 }, { path: 'b.txt', status: 'added', added: 1, removed: 0 }]);
	const initial = await reader.commit(root, second[0]!.hash);
	assert.deepEqual(initial.files, [{ path: 'a.txt', status: 'added', added: 1, removed: 0 }]);
	assert.match((await reader.diff(root, { file: 'a.txt', area: 'commit', commit: first[1]!.hash })).diff, /^@@ -1 \+1,2 @@\n 一\n\+二$/m);
	assert.match((await reader.diff(root, { file: 'a.txt', area: 'commit', commit: second[0]!.hash })).diff, /^@@ -0,0 \+1 @@\n\+一$/m);
	await assert.rejects(reader.commit(root, 'HEAD~1'), /哈希/);
});

test('冲突：正在合并，冲突的文件单独一组', { skip }, async t => {
	const root = repository(t);
	commit(root, { 'a.txt': '原来\n' }, '第一次提交');
	git(root, 'checkout', '-q', '-b', 'other');
	commit(root, { 'a.txt': '分支改的\n' }, '分支');
	git(root, 'checkout', '-q', 'main');
	commit(root, { 'a.txt': '主线改的\n' }, '主线');
	assert.throws(() => git(root, 'merge', '-q', 'other'));
	const status = await reader.status(root);
	assert.equal(status.state, 'merging');
	assert.deepEqual(status.changes.conflicted, [{ path: 'a.txt', status: 'modified' }]);
});

test('不执行仓库里配置的程序：fsmonitor、过滤器、textconv 都不跑', { skip }, async t => {
	const root = repository(t);
	commit(root, { 'a.txt': '一\n', '.gitattributes': '*.txt filter=evil diff=evil\n' }, '第一次提交');
	git(root, 'config', 'core.fsmonitor', 'echo x > fsmonitor-ran; exit 1; #');
	git(root, 'config', 'filter.evil.clean', 'echo x > filter-ran; cat');
	git(root, 'config', 'filter.evil.required', 'true');
	git(root, 'config', 'filter.evil.smudge', 'cat');
	git(root, 'config', 'diff.evil.textconv', 'echo x > textconv-ran; cat');
	writeFileSync(join(root, 'a.txt'), '一\n二\n');

	const status = await reader.status(root);
	assert.deepEqual(status.changes.unstaged, [{ path: 'a.txt', status: 'modified', added: 1, removed: 0 }]);
	await reader.diff(root, { file: 'a.txt', area: 'unstaged' });
	for (const marker of ['fsmonitor-ran', 'filter-ran', 'textconv-ran']) assert.equal(existsSync(join(root, marker)), false, marker);

	// 对照：平常的 git 会执行它们，上面没执行不是因为命令本身写错了。
	git(root, 'status');
	git(root, 'diff', '--textconv');
	for (const marker of ['fsmonitor-ran', 'filter-ran', 'textconv-ran']) assert.equal(existsSync(join(root, marker)), true, marker);
});
