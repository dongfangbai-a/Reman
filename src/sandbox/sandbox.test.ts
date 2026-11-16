import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { test } from 'node:test';
import { ShellLocator } from '../shells/shells.ts';
import { temporaryDirectory } from '../testing.ts';
import { CommandParser } from '../tools/command/commandParser.ts';
import { createShellTool } from '../tools/command/shell.ts';
import { DataProtection } from '../tools/protection.ts';
import { dataOverlap, gitProtectedPaths, Sandbox, sandboxConfig } from './sandbox.ts';

test('沙箱的配置：只能写工作目录，读不到令牌、浏览器的数据和数据库；工作目录和数据目录重叠的放不进沙箱', t => {
	const data = temporaryDirectory(t);
	const directories = { dataDirectory: data, workspacesDirectory: join(data, 'workspaces') };
	const workingDirectory = join(data, 'workspaces', 'M_1');
	const config = sandboxConfig(workingDirectory, directories, []);
	assert.deepEqual(config.filesystem.allowWrite, [workingDirectory]);
	// 浏览器的数据是目录，末尾带分隔符。
	assert.deepEqual(config.filesystem.denyRead, ['access-token', 'runtime.json', 'secret-key', 'browsers', 'runtime.sqlite', 'runtime.sqlite-wal', 'runtime.sqlite-shm']
		.map(name => join(data, name) + (name === 'browsers' ? sep : '')));
	assert.equal(dataOverlap(workingDirectory, directories), undefined);
	assert.equal(dataOverlap(join(data, 'members', '林舟'), directories), '工作目录位于运行时的数据目录中');
	assert.equal(dataOverlap(data, directories), '工作目录包含运行时的数据目录');
});

test('工作目录里已有仓库的钩子和配置每条命令单独禁止写：只看几层，跳过 node_modules', t => {
	const directory = temporaryDirectory(t);
	for (const repository of ['', 'projects/app', 'node_modules/x']) {
		mkdirSync(join(directory, repository, '.git', 'hooks'), { recursive: true });
		writeFileSync(join(directory, repository, '.git', 'config'), '');
	}
	assert.deepEqual(gitProtectedPaths(directory).sort(), [
		join(directory, '.git', 'config'), join(directory, '.git', 'hooks'),
		join(directory, 'projects', 'app', '.git', 'config'), join(directory, 'projects', 'app', '.git', 'hooks'),
	].sort());
});

test('沙箱没打开时命令照旧按文字判断', async () => {
	const sandbox = new Sandbox({ workingDirectories: () => [] });
	assert.deepEqual(await sandbox.placement(process.cwd(), new ShellLocator(() => undefined).current()), { sandboxed: false, reason: '沙箱未开启' });
});

// 要在装好沙箱的电脑上跑：REMAN_SANDBOX_TEST_DIR 指向沙箱账户读得到的目录（不能在临时目录里）。
const root = process.env['REMAN_SANDBOX_TEST_DIR'];

test('沙箱里执行的不用审批，只能写工作目录、读不到令牌，失败时提示；到沙箱外执行时 auto 要审批、免审批直接执行（受保护的除外）', { skip: !root }, async t => {
	const data = join(root!, 'data');
	rmSync(data, { recursive: true, force: true });
	const workingDirectory = join(data, 'workspaces', 'M_1');
	mkdirSync(workingDirectory, { recursive: true });
	writeFileSync(join(data, 'access-token'), 'token\n');
	writeFileSync(join(data, 'sandbox.json'), '{ "enabled": true }\n');
	const directories = { dataDirectory: data, workspacesDirectory: join(data, 'workspaces') };
	const sandbox = new Sandbox({ settingsPath: join(data, 'sandbox.json'), data: directories, workingDirectories: () => [workingDirectory] });
	t.after(() => sandbox.shutdown());
	const protection = new DataProtection({ ...directories, membersDirectory: join(data, 'members'), skillsDirectory: join(data, 'skills'), eventRoutesDirectory: join(data, 'event-routes'), customToolsDirectory: join(data, 'custom-tools') });
	const tool = createShellTool(new ShellLocator(() => undefined), new CommandParser(), protection, sandbox);
	const context = { memberId: 'M_1', workingDirectory, signal: new AbortController().signal };

	// Windows 上用项目里带的 curl；补了语言，中文按字数。
	if (process.platform === 'win32') {
		assert.match((await tool.execute(context, { command: 'which curl' })).output, /vendor\/curl\/curl/);
		assert.match((await tool.execute(context, { command: 'echo "$LANG"; printf 中文 | wc -m' })).output, /^\w+\.UTF-8\n\s*2$/);
	}

	const inside = { command: 'echo hi > a.txt; cat ../../access-token' };
	assert.equal(await tool.needsApproval!(context, inside), undefined);
	assert.deepEqual(await tool.protectedReasons!(context, inside), []);
	const result = await tool.execute(context, inside);
	assert.match(result.output, /Permission denied/);
	assert.match(result.hint ?? '', /outside_sandbox/);
	assert.equal(readFileSync(join(workingDirectory, 'a.txt'), 'utf8'), 'hi\n');

	// 网络设置改了，已经开着的沙箱进程立即按新的；挡住时写明是用户的设置。
	sandbox.setNetwork({ deny: ['example.com'] });
	assert.deepEqual(JSON.parse(readFileSync(join(data, 'sandbox.json'), 'utf8')), { enabled: true, network: { deny: ['example.com'] } });
	const denied = await tool.execute(context, { command: 'curl -sS -m 10 https://www.example.com/' });
	assert.match(denied.hint ?? '', /用户的设置不允许沙箱中的命令连接 www\.example\.com:443/);

	const outside = { ...inside, outside_sandbox: true };
	assert.deepEqual(await tool.alwaysReasons!(context, inside), []);
	assert.deepEqual(await tool.alwaysReasons!(context, outside), ['在沙箱外执行']);
	assert.deepEqual(await tool.protectedReasons!(context, outside), ['涉及运行时的令牌和密钥：access-token']);

	// 超时结束沙箱里的命令。
	const started = Date.now();
	const slow = { command: 'sleep 30', timeout_ms: 1000 };
	await tool.protectedReasons!(context, slow);
	assert.equal((await tool.execute(context, slow)).timedOut, true);
	assert.ok(Date.now() - started < 10_000);
});
