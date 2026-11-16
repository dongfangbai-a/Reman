import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { LoginShells } from '../tools/command/loginShell.ts';
import { formatCommand, runCommand } from '../tools/command/shell.ts';
import { ShellLocator, type IShell } from './shells.ts';

test('Windows 上优先系统的 Git Bash，跳过 WSL 的 bash.exe；没有时依次用 PortableGit、pwsh、Windows PowerShell', () => {
	const detect = (files: readonly string[], path: string, portable?: string) => {
		const env = { Path: path, ProgramFiles: 'C:\\Program Files', SystemRoot: 'C:\\Windows' };
		const locator = new ShellLocator(() => portable, { platform: 'win32', env, exists: file => files.includes(file) });
		const shell = locator.current();
		return `${shell.label}: ${shell.executable}`;
	};
	const wsl = ['C:\\Windows\\System32\\bash.exe'];
	assert.deepEqual([
		detect([...wsl, 'C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'], 'C:\\Windows\\System32'),
		// 装在别处的 Git：从 PATH 里的 git.exe 找到安装目录。
		detect([...wsl, 'D:\\Tools\\Git\\cmd\\git.exe', 'D:\\Tools\\Git\\bin\\bash.exe'], 'C:\\Windows\\System32;D:\\Tools\\Git\\cmd'),
		detect([...wsl, 'E:\\PortableGit\\bin\\bash.exe', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'], 'C:\\Windows\\System32', 'E:\\PortableGit\\bin\\bash.exe'),
		detect([...wsl, 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'], 'C:\\Windows\\System32'),
		detect(wsl, 'C:\\Windows\\System32'),
	], [
		'Git Bash: C:\\Program Files\\Git\\bin\\bash.exe',
		'Git Bash: D:\\Tools\\Git\\bin\\bash.exe',
		'Git Bash: E:\\PortableGit\\bin\\bash.exe',
		'PowerShell 7: C:\\Program Files\\PowerShell\\7\\pwsh.exe',
		'Windows PowerShell: C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
	]);
	const posix = (platform: NodeJS.Platform) => new ShellLocator(() => undefined, {
		platform, env: { PATH: '/usr/bin' }, exists: file => ['/usr/bin/bash', '/usr/bin/zsh', '/bin/sh'].includes(file),
	}).current().executable;
	assert.deepEqual([posix('darwin'), posix('linux')], ['/usr/bin/zsh', '/usr/bin/bash']);
});

test('执行命令：输出和退出码；超时、运行停止都会结束命令', async () => {
	const shell: IShell = new ShellLocator(() => undefined).current();
	const signal = new AbortController().signal;
	const command = shell.kind === 'bash' || shell.kind === 'zsh' || shell.kind === 'sh'
		? { ok: 'echo 你好; sleep 0.3; echo 出错 >&2; exit 3', slow: 'sleep 20' }
		: { ok: 'Write-Output 你好; Start-Sleep -Milliseconds 300; [Console]::Error.WriteLine("出错"); exit 3', slow: 'Start-Sleep 20' };
	// 执行中看得到到目前为止的输出，结束时关掉。
	const seen: string[] = [];
	let closed = false;
	const done = await runCommand(shell, command.ok, process.cwd(), 10_000, signal, read => ({
		changed: () => seen.push(read()),
		close: () => closed = true,
	}));
	assert.deepEqual(done, { output: '你好\n出错', exitCode: 3, signal: null, timedOut: false });
	assert.match(seen[0]!, /^你好\r?\n$/);
	assert.ok(closed);
	assert.equal(formatCommand(done), '你好\n出错\n\n[退出码 3]');
	const started = Date.now();
	const slow = await runCommand(shell, command.slow, process.cwd(), 1000, signal);
	assert.deepEqual(slow, { output: '', exitCode: null, signal: null, timedOut: true });
	assert.equal(formatCommand(slow), '（无输出）\n\n[超时，已终止]');
	assert.ok(Date.now() - started < 10_000);

	const controller = new AbortController();
	setTimeout(() => controller.abort(new Error('运行已停止')), 500);
	const stopped = await runCommand(shell, command.slow, process.cwd(), 10_000, controller.signal);
	assert.deepEqual(stopped, { output: '', exitCode: null, signal: null, timedOut: false, cancelled: '运行已停止' });
	assert.equal(formatCommand(stopped), '（无输出）\n\n[运行已停止，命令已终止]');
	assert.ok(Date.now() - started < 20_000);
});

test('bash 登录一次记下环境：结果和每次登录相同，不带登录时的输出；改了配置文件下一条就重新记', async t => {
	const shell: IShell = new ShellLocator(() => undefined).current();
	if (shell.kind !== 'bash') return t.skip('只有 bash 记登录环境');
	const home = mkdtempSync(join(tmpdir(), 'reman-login-'));
	const previousHome = process.env['HOME'];
	process.env['HOME'] = home;
	t.after(() => {
		if (previousHome === undefined) delete process.env['HOME'];
		else process.env['HOME'] = previousHome;
		rmSync(home, { recursive: true, force: true });
	});
	const profile = join(home, '.bash_profile');
	const writeProfile = (value: string, time: number) => {
		writeFileSync(profile, `echo 登录时的输出\nexport REMAN_TEST_VALUE=${value}\nexport PATH="$HOME/bin:$PATH"\n`);
		utimesSync(profile, time, time);
	};
	writeProfile('一', 1_000_000);
	const signal = new AbortController().signal;
	const probe = 'echo "$REMAN_TEST_VALUE|$LANG|${REMAN_SHELL_LOGIN-没有}"; printf 中文 | wc -m; echo "$PATH"; command -v git';
	const run = (logins?: LoginShells) => runCommand(shell, probe, process.cwd(), 30_000, signal, undefined, logins).then(result => result.output);
	const logins = new LoginShells();
	const everyTime = await run();
	assert.equal(everyTime.split('\n')[0], '登录时的输出');
	assert.equal(await run(logins), everyTime.split('\n').slice(1).join('\n'));
	assert.match(await run(logins), /^一\|.*\|没有\n\s*2\n/);

	writeProfile('二', 2_000_000);
	assert.match(await run(logins), /^二\|/);
});
