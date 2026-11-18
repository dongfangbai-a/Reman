import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { runtimeDirectories } from '../dataDirectory.ts';
import { Runtime } from '../runtime.ts';
import { addAi, realPath } from '../testing.ts';
import { ShellLocator } from '../shells/shells.ts';
import { DEFAULT_MAX_TERMINALS } from './limits.ts';

const isBash = new ShellLocator(() => undefined).current().kind === 'bash';

function setup(t: TestContext, limits?: { maxAiTerminals: number }) {
	const directory = mkdtempSync(join(tmpdir(), 'reman-runtime-terminal-'));
	const terminalSettingsPath = join(directory, 'terminals.json');
	if (limits) writeFileSync(terminalSettingsPath, `${JSON.stringify(limits)}\n`);
	const runtime = new Runtime(':memory:', { ...runtimeDirectories(directory), portableGitDirectory: null, terminalSettingsPath });
	t.after(async () => {
		await runtime.close();
		await removeDirectory(directory);
	});
	const first = addAi(runtime, '沈安');
	const second = addAi(runtime, '林岚');
	const terminal = async (memberId: string, args: object) => {
		const context = { memberId, workingDirectory: directory, signal: new AbortController().signal };
		const result = await runtime.tools.call(context, 'terminal', JSON.stringify({ idle_ms: 1_000, ...args }));
		return result.output;
	};
	return { runtime, directory, first, second, terminal };
}

/** 刚结束的进程要过一会儿才放开工作目录，删不掉时稍后再试。（rmSync 的 retryDelay 在 Windows 上实际不等待。） */
async function removeDirectory(directory: string): Promise<void> {
	for (let attempt = 1; ; attempt++) {
		try {
			rmSync(directory, { recursive: true, force: true });
			return;
		} catch (error) {
			if (attempt >= 50) throw error;
			await delay(100);
		}
	}
}

/** 去掉提示符那些因机器而异的行，只留命令的输出。 */
function outputLines(text: string): string[] {
	return text.split('\n').slice(1).filter(line => !line.includes('$') && !line.includes('@') && line.trim());
}

/** 等终端里的程序把自己的进程号写进文件。 */
async function readPid(file: string): Promise<number> {
	for (let index = 0; index < 100; index++) {
		const text = existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
		if (text) return Number(text);
		await delay(100);
	}
	throw new Error(`一直没有写进程号：${file}`);
}

/** 进程在 5 秒内结束时返回 true。 */
async function exited(pid: number): Promise<boolean> {
	for (let index = 0; index < 50; index++) {
		try {
			process.kill(pid, 0);
		} catch {
			return true;
		}
		await delay(100);
	}
	return false;
}

test('新建终端、输入命令、读新输出；两个成员各读各的', { skip: !isBash }, async t => {
	const { runtime, first, second, terminal } = setup(t);
	const created = await terminal(first.memberId, { input: 'echo ready\n' });
	const terminalId = /\[终端 (T_\w+)，运行中\]/.exec(created)![1]!;
	// 负载高时 shell 启动、响应都慢，一次可能读不全：接着读，直到读到 expected。
	const readUntil = async (lines: string[], expected: string) => {
		for (let index = 0; index < 30 && !lines.includes(expected); index++) {
			lines.push(...outputLines(await terminal(first.memberId, { terminal_id: terminalId })));
		}
		return lines;
	};
	const input = async (text: string) => readUntil(outputLines(await terminal(first.memberId, { terminal_id: terminalId, input: `echo ${text}\n` })), text);

	await readUntil(outputLines(created), 'ready');
	assert.deepEqual(await input('one'), ['one']);
	assert.deepEqual(await input('two'), ['two']);
	// 另一个成员第一次读，看到全部输出。
	assert.deepEqual(outputLines(await terminal(second.memberId, { terminal_id: terminalId })), ['ready', 'one', 'two']);
	// 第一个成员都读过了：不经工具直接读，确认没有未读的输出。
	const unread = (await runtime.terminals.readNow(terminalId, first.memberId, 'new')).output;
	assert.deepEqual(outputLines(`[第一行]\n${unread}`), []);
});

test('同一行没变时下一次读不再给一遍：转后台时通知和结果两次读不会重复同一段', { skip: !isBash }, async t => {
	const { runtime, first, terminal } = setup(t);
	// 光标停在 a1 这一行上（a1 后面没有换行）。再读一次时这一行没变，不该重复给：转后台时通知读完、
	// 后台任务的结果接着读，共用成员的读游标，重复给的话成员会看到两遍同一段。
	const created = await terminal(first.memberId, { input: `bash -c 'printf a1; sleep 30'\n` });
	const terminalId = /\[终端 (T_\w+)/.exec(created)![1]!;
	assert.ok(outputLines(created).includes('a1'), created);
	assert.equal((await runtime.terminals.readNow(terminalId, first.memberId, 'new')).output, '');
	// 新的一行照常给，不带上刚才那一行。
	runtime.terminals.input(terminalId, '\u0003', { memberId: first.memberId });
	let lines: string[] = [];
	for (let index = 0; index < 30 && !lines.includes('tail10'); index++) {
		lines = [...lines, ...outputLines(await terminal(first.memberId, { terminal_id: terminalId, input: 'echo tail$((5+5))\n' }))];
	}
	assert.ok(lines.includes('tail10'), lines.join('\n'));
	assert.equal(lines.includes('a1'), false);
});

test('输入的内容没有以回车结尾时，结果第一行写明；带回车的、按控制键的不写', { skip: !isBash }, async t => {
	const { first, terminal } = setup(t);
	const head = (text: string) => text.split('\n')[0];
	const created = await terminal(first.memberId, { input: 'echo typed' });
	const terminalId = /\[终端 (T_\w+)/.exec(created)![1]!;
	assert.equal(head(created), `[终端 ${terminalId}，运行中，本次输入未以回车结尾]`);
	// 命令只是打在提示符后面，没有执行：输出里没有单独一行的 typed。（负载高时 shell 还没启动完，可能什么输出都没有。）
	assert.equal(outputLines(created).includes('typed'), false);
	// Ctrl+C 是按键，本来就不带回车。
	assert.equal(head(await terminal(first.memberId, { terminal_id: terminalId, input: '\u0003' })), `[终端 ${terminalId}，运行中]`);
	assert.equal(head(await terminal(first.memberId, { terminal_id: terminalId, input: 'echo done\n' })), `[终端 ${terminalId}，运行中]`);
});

test('终端记下 shell 现在的当前目录，cd 之后跟着变', { skip: !isBash }, async t => {
	const { runtime, directory, first, terminal } = setup(t);
	mkdirSync(join(directory, 'sub'));
	const terminalId = /\[终端 (T_\w+)/.exec(await terminal(first.memberId, { input: 'cd sub\n' }))![1]!;
	// shell 报的路径可能带 8.3 短名，两边都归一化再比。
	const expected = realPath(join(directory, 'sub'));
	const current = async () => realPath((await runtime.terminals.currentDirectory(terminalId)) ?? '');
	for (let index = 0; index < 30 && await current() !== expected; index++) await delay(100);
	assert.equal(await current(), expected);
});

test('交互程序：在 node 里输入表达式，Ctrl+C 退出', { skip: !isBash }, async t => {
	const { first, terminal } = setup(t);
	const terminalId = /\[终端 (T_\w+)/.exec(await terminal(first.memberId, {}))![1]!;
	await terminal(first.memberId, { terminal_id: terminalId, input: 'node\n', idle_ms: 1500 });
	assert.match(await terminal(first.memberId, { terminal_id: terminalId, input: '1 + 2\n' }), /^3$/m);
	await terminal(first.memberId, { terminal_id: terminalId, input: '\u0003' });
	const exited = await terminal(first.memberId, { terminal_id: terminalId, input: '\u0003' });
	assert.doesNotMatch(exited.split('\n').at(-1)!, /^> ?$/);
	assert.deepEqual(outputLines(await terminal(first.memberId, { terminal_id: terminalId, input: 'echo back\n' })), ['back']);
});

test('用户接管期间 AI 只能读不能写，调用马上返回；交还后唤醒它；关闭终端会结束里面的程序', { skip: !isBash }, async t => {
	const { runtime, directory, first, terminal } = setup(t);
	const terminalId = /\[终端 (T_\w+)/.exec(await terminal(first.memberId, {}))![1]!;
	const pidFile = join(directory, 'pid.txt').replace(/\\/g, '/');

	// 用户在前端输入就自动接管。
	runtime.terminals.input(terminalId, `node -e "require('fs').writeFileSync('${pidFile}', String(process.pid)); setInterval(() => {}, 1000)"\r`, 'user');
	assert.equal(runtime.terminals.get(terminalId).controller, 'user');
	assert.equal(await terminal(first.memberId, { terminal_id: terminalId, input: 'echo hi\n' }), `用户正在操作终端 ${terminalId}，当前无法输入；用户交还时会通知你`);
	// 不等新输出，马上返回。
	const startedAt = Date.now();
	assert.match(await terminal(first.memberId, { terminal_id: terminalId }), /用户正在操作，交还时会通知你/);
	assert.ok(Date.now() - startedAt < 5000);

	runtime.terminals.release(terminalId);
	const last = runtime.timeline.all(first.memberId).at(-1)!;
	assert.deepEqual(last.kind === 'terminal_event' && { event: last.event, wakes: last.wakes }, { event: { terminalId, event: 'released', request: null, waiting: true }, wakes: true });

	const pid = await readPid(pidFile);
	assert.equal(await terminal(first.memberId, { terminal_id: terminalId, close: true }), `已关闭终端 ${terminalId}`);
	assert.deepEqual(runtime.terminals.list(), []);
	assert.equal(await exited(pid), true);
});

test('交还时只唤醒在等的成员：请过用户接管的写明请求；没人在等时只给建终端的成员记一条，不唤醒', { skip: !isBash }, async t => {
	const { runtime, first, second, terminal } = setup(t);
	const terminalId = /\[终端 (T_\w+)/.exec(await terminal(first.memberId, {}))![1]!;
	const released = (memberId: string) => runtime.timeline.all(memberId).flatMap(item => item.kind === 'terminal_event' ? [{ event: item.event, wakes: item.wakes }] : []);

	// 接管后什么都没做就交还。
	runtime.terminals.takeover(terminalId);
	runtime.terminals.release(terminalId);
	assert.deepEqual(released(first.memberId), [{ event: { terminalId, event: 'released', request: null, waiting: false }, wakes: false }]);

	// 共用这个终端的另一个成员请用户接管：不等新输出马上返回；交还时只唤醒它，建终端的成员不再记。
	const askedAt = Date.now();
	assert.match(await terminal(second.memberId, { terminal_id: terminalId, ask_user: '输入 sudo 密码' }), /已请用户接管，交还时会通知你/);
	assert.ok(Date.now() - askedAt < 5_000);
	assert.deepEqual(runtime.terminals.get(terminalId).takeoverRequests.map(({ memberId, request }) => ({ memberId, request })), [{ memberId: second.memberId, request: '输入 sudo 密码' }]);
	runtime.terminals.takeover(terminalId);
	// 接管后网页端不再显示请求，但交还时仍然唤醒它。
	assert.deepEqual(runtime.terminals.get(terminalId).takeoverRequests, []);
	runtime.terminals.release(terminalId);
	assert.deepEqual(released(second.memberId), [{ event: { terminalId, event: 'released', request: '输入 sudo 密码', waiting: true }, wakes: true }]);
	assert.equal(released(first.memberId).length, 1);
	assert.deepEqual(runtime.terminals.get(terminalId).takeoverRequests, []);
});

test('请用户接管后只读不算把终端拿回来：提示留着；输入才撤销，撤销后交还不再唤醒它', { skip: !isBash }, async t => {
	const { runtime, first, second, terminal } = setup(t);
	const terminalId = /\[终端 (T_\w+)/.exec(await terminal(first.memberId, {}))![1]!;
	const requests = () => runtime.terminals.get(terminalId).takeoverRequests.map(({ memberId, request }) => ({ memberId, request }));
	assert.match(await terminal(second.memberId, { terminal_id: terminalId, ask_user: '输入 sudo 密码' }), /已请用户接管/);
	assert.deepEqual(requests(), [{ memberId: second.memberId, request: '输入 sudo 密码' }]);

	// 只读：边等边看，提示保留。
	await terminal(second.memberId, { terminal_id: terminalId });
	assert.deepEqual(requests(), [{ memberId: second.memberId, request: '输入 sudo 密码' }]);

	// 输入：把终端拿回来自己用，请求撤销。
	await terminal(second.memberId, { terminal_id: terminalId, input: 'echo hi\n' });
	assert.deepEqual(requests(), []);

	// 撤销之后再接管、交还，不会再唤醒它。
	runtime.terminals.takeover(terminalId);
	runtime.terminals.release(terminalId);
	assert.deepEqual(runtime.timeline.all(second.memberId).filter(item => item.kind === 'terminal_event' && item.event.event === 'released'), []);
});

test('用户占用时成员硬输入会被拒绝，接管请求不该被误撤销', { skip: !isBash }, async t => {
	const { runtime, first, second, terminal } = setup(t);
	const terminalId = /\[终端 (T_\w+)/.exec(await terminal(first.memberId, {}))![1]!;
	const released = (memberId: string) => runtime.timeline.all(memberId).flatMap(item => item.kind === 'terminal_event' && item.event.event === 'released' ? [item.event] : []);
	await terminal(second.memberId, { terminal_id: terminalId, ask_user: '输入 sudo 密码' });
	runtime.terminals.takeover(terminalId);
	assert.deepEqual(runtime.terminals.get(terminalId).takeoverRequests, []);

	// 用户正占用：输入被拒绝，它还在等，交还时要带着请求文案唤醒它。
	assert.match(await terminal(second.memberId, { terminal_id: terminalId, input: 'echo hi\n' }), /用户正在操作终端/);
	runtime.terminals.release(terminalId);
	assert.deepEqual(released(second.memberId), [{ terminalId, event: 'released', request: '输入 sudo 密码', waiting: true }]);
});

test('用户不用接管：只撤这个成员的请求并唤醒它继续，同一个终端上别人的请求不动', { skip: !isBash }, async t => {
	const { runtime, first, second, terminal } = setup(t);
	const terminalId = /\[终端 (T_\w+)/.exec(await terminal(first.memberId, {}))![1]!;
	const requests = () => runtime.terminals.get(terminalId).takeoverRequests.map(({ memberId, request }) => ({ memberId, request }));
	const terminalEvents = (memberId: string) => runtime.timeline.all(memberId).flatMap(item => item.kind === 'terminal_event' ? [{ event: item.event, wakes: item.wakes }] : []);
	await terminal(first.memberId, { terminal_id: terminalId, ask_user: '输入 sudo 密码' });
	await terminal(second.memberId, { terminal_id: terminalId, ask_user: '确认删掉 export/tmp' });
	assert.equal(requests().length, 2);

	runtime.terminals.decline(terminalId, first.memberId);
	assert.deepEqual(requests(), [{ memberId: second.memberId, request: '确认删掉 export/tmp' }]);
	assert.deepEqual(terminalEvents(first.memberId).at(-1), { event: { terminalId, event: 'declined', request: '输入 sudo 密码', waiting: true }, wakes: true });

	// 重复撤不报错，也不再记事件。
	const count = runtime.timeline.all(first.memberId).length;
	runtime.terminals.decline(terminalId, first.memberId);
	assert.equal(runtime.timeline.all(first.memberId).length, count);

	// 交还时只唤醒还在等的 second，不再管 first。
	runtime.terminals.takeover(terminalId);
	runtime.terminals.release(terminalId);
	assert.equal(terminalEvents(first.memberId).filter(item => item.event.event === 'released').length, 0);
	assert.equal(terminalEvents(second.memberId).filter(item => item.event.event === 'released').length, 1);
});

test('decline 的成员已经删除时只摘请求，不记事件', { skip: !isBash }, async t => {
	const { runtime, first, second, terminal } = setup(t);
	const terminalId = /\[终端 (T_\w+)/.exec(await terminal(first.memberId, {}))![1]!;
	await terminal(second.memberId, { terminal_id: terminalId, ask_user: '输入 sudo 密码' });
	runtime.db.run('UPDATE members SET deleted_at = ? WHERE member_id = ?', Date.now(), second.memberId);
	const count = runtime.timeline.all(second.memberId).length;
	runtime.terminals.decline(terminalId, second.memberId);
	assert.deepEqual(runtime.terminals.get(terminalId).takeoverRequests, []);
	assert.equal(runtime.timeline.all(second.memberId).length, count);
});

test('关闭正在执行命令的终端：shell 和命令都结束，不留进程', { skip: !isBash }, async t => {
	const { directory, first, terminal } = setup(t);
	const shellFile = join(directory, 'shell-pid.txt').replace(/\\/g, '/');
	const commandFile = join(directory, 'command-pid.txt').replace(/\\/g, '/');
	// 命令写下自己的进程号后一直等输入，不再启动新程序（关闭时恰好在启动的程序会漏掉）。
	const created = await terminal(first.memberId, { input: `cat /proc/$$/winpid > '${shellFile}'; bash -c 'cat /proc/$$/winpid > "${commandFile}"; read'\n` });
	const terminalId = /\[终端 (T_\w+)/.exec(created)![1]!;
	const shell = await readPid(shellFile);
	const command = await readPid(commandFile);
	assert.equal(await terminal(first.memberId, { terminal_id: terminalId, close: true }), `已关闭终端 ${terminalId}`);
	assert.equal(await exited(shell), true);
	assert.equal(await exited(command), true);
});

/** 等屏幕快照里出现 marker，返回快照内容。 */
async function screenWith(runtime: Runtime, terminalId: string, marker: string): Promise<string> {
	for (let index = 0; index < 100; index++) {
		const { data } = await runtime.terminals.screen(terminalId);
		if (data.includes(marker)) return data;
		await delay(100);
	}
	throw new Error(`终端里一直没有输出 ${marker}`);
}

test('屏幕快照记下程序隐藏了光标', { skip: !isBash }, async t => {
	const { runtime, directory } = setup(t);
	const { terminalId } = runtime.terminals.create(null, directory);
	runtime.terminals.input(terminalId, `printf '\\033[?25l'; echo mark$((40+4))\r`, 'user');
	assert.ok((await screenWith(runtime, terminalId, 'mark44')).endsWith('\x1b[?25l'));
	runtime.terminals.close(terminalId, 'user');
});

test('AI 成员建的终端尺寸固定，用户接管了也不能改', async t => {
	const { runtime, directory, first } = setup(t);
	const { terminalId } = runtime.terminals.create(first.memberId, directory);
	runtime.terminals.takeover(terminalId);
	assert.throws(() => runtime.terminals.resize(terminalId, 60, 20), /尺寸固定/);
	assert.deepEqual([runtime.terminals.get(terminalId).cols, runtime.terminals.get(terminalId).rows], [100, 30]);
	runtime.terminals.close(terminalId, 'user');
});

test('Windows 上终端变窄后，快照里的行不超过终端的宽度', { skip: !isBash || process.platform !== 'win32' }, async t => {
	const { runtime, directory } = setup(t);
	const { terminalId } = runtime.terminals.create(null, directory);
	runtime.terminals.input(terminalId, `printf 'X%.0s' $(seq 100); echo; echo mark$((40+5))\r`, 'user');
	await screenWith(runtime, terminalId, 'mark45');
	runtime.terminals.resize(terminalId, 60, 30);
	const longest = Math.max(...((await runtime.terminals.screen(terminalId)).data.match(/X+/g) ?? []).map(run => run.length));
	assert.equal(longest, 60);
	runtime.terminals.close(terminalId, 'user');
});

test('等待被中止时照常返回终端和已有的输出，写明命令可能还在运行；等待期间被用户关闭时返回关闭前的输出', { skip: !isBash }, async t => {
	const { runtime, directory, first } = setup(t);
	const controller = new AbortController();
	// 一直等到被中止或终端被关闭：idle_ms 很长，命令输出后一直等输入（也不再启动新程序，关闭时不会漏掉）。
	const start = (signal: AbortSignal, input: string) => runtime.tools.call(
		{ memberId: first.memberId, workingDirectory: directory, signal }, 'terminal', JSON.stringify({ input, idle_ms: 20_000 }),
	);
	const printed = async (marker: string) => {
		for (let index = 0; index < 200; index++) {
			const terminal = runtime.terminals.list().find(info => info.status === 'running');
			if (terminal && (await runtime.terminals.screen(terminal.terminalId)).data.includes(marker)) return terminal.terminalId;
			await delay(50);
		}
		throw new Error(`终端里一直没有输出 ${marker}`);
	};

	const interrupted = start(controller.signal, `bash -c 'echo mark$((40+2)); read'\n`);
	const terminalId = await printed('mark42');
	controller.abort();
	const stopped = (await interrupted).output;
	assert.equal(stopped.split('\n')[0], `[终端 ${terminalId}，运行中，等待已中止，命令可能仍在运行]`);
	assert.deepEqual(outputLines(stopped), ['mark42']);
	runtime.terminals.close(terminalId, 'user');

	const waiting = start(new AbortController().signal, `bash -c 'echo mark$((40+3)); read'\n`);
	const closedId = await printed('mark43');
	runtime.terminals.close(closedId, 'user');
	const closed = (await waiting).output;
	assert.equal(closed.split('\n')[0], `[终端 ${closedId}，已被用户关闭]`);
	assert.deepEqual(outputLines(closed), ['mark43']);
	assert.deepEqual(runtime.terminals.list(), []);
});

test('成员建终端有上限：默认 3 个，满了之后新建被拦下，关掉一个就能再建', { skip: !isBash }, async t => {
	const { first, second, terminal } = setup(t);
	const created: string[] = [];
	for (let index = 0; index < DEFAULT_MAX_TERMINALS; index++) {
		created.push(/\[终端 (T_\w+)/.exec(await terminal(first.memberId, {}))![1]!);
	}
	const blocked = await terminal(first.memberId, {});
	assert.match(blocked, new RegExp(`已创建且未退出的终端已达上限（${DEFAULT_MAX_TERMINALS} 个）：${created.join('、')}`));
	// 关掉一个，名额就腾出来了。
	await terminal(first.memberId, { terminal_id: created[0]!, close: true });
	assert.match(await terminal(first.memberId, {}), /\[终端 T_\w+/);
	// 另一个成员有自己的额度。
	assert.match(await terminal(second.memberId, {}), /\[终端 T_\w+/);
});

test('上限按成员配置：member.json 里写了 maxTerminals 就按它算', { skip: !isBash }, async t => {
	const { runtime, terminal } = setup(t);
	const strict = addAi(runtime, '严格', { maxTerminals: 1 });
	assert.match(await terminal(strict.memberId, {}), /\[终端 T_\w+/);
	assert.match(await terminal(strict.memberId, {}), /已创建且未退出的终端已达上限（1 个）：T_\w+/);
});

test('用户自己建的终端不算进成员的额度', { skip: !isBash }, async t => {
	const { runtime, directory, first, terminal } = setup(t);
	for (let index = 0; index < DEFAULT_MAX_TERMINALS + 1; index++) runtime.terminals.create(null, directory);
	for (let index = 0; index < DEFAULT_MAX_TERMINALS; index++) {
		assert.match(await terminal(first.memberId, {}), /\[终端 T_\w+/);
	}
});

test('已经退出的终端不占名额：shell 结束就释放，不用关掉', { skip: !isBash }, async t => {
	const { runtime, directory, first, terminal } = setup(t);
	const ids = [0, 1, 2].map(() => runtime.terminals.create(first.memberId, directory).terminalId);
	// 三个都开着，这时新建被拦下。
	assert.match(await terminal(first.memberId, {}), /已创建且未退出的终端已达上限（3 个）/);
	runtime.terminals.input(ids[0]!, 'exit\n', { memberId: first.memberId });
	for (let index = 0; index < 50 && runtime.terminals.get(ids[0]!)?.status !== 'exited'; index++) await delay(100);
	assert.equal(runtime.terminals.get(ids[0]!)?.status, 'exited');
	// 退出后不占名额，不关也能再建。
	assert.match(await terminal(first.memberId, {}), /\[终端 T_\w+/);
});

test('AI 成员合计的上限：不同成员建的算在一起，配置的小值立刻生效', { skip: !isBash }, async t => {
	const { runtime, directory, first, second } = setup(t, { maxAiTerminals: 2 });
	runtime.terminals.create(first.memberId, directory);
	runtime.terminals.create(second.memberId, directory);
	assert.throws(() => runtime.terminals.create(first.memberId, directory), /AI 成员已创建且未退出的终端已达上限（2 个）/);
	// 用户自己建的不算在 AI 的额度里。
	assert.ok(runtime.terminals.create(null, directory).terminalId);
	// 上限改了立刻按新值算。
	assert.deepEqual(runtime.terminals.setMaxAiTerminals(3), { maxAiTerminals: 3, problem: null });
	assert.ok(runtime.terminals.create(second.memberId, directory).terminalId);
});

test('真人自己建的终端最多 20 个', { skip: !isBash }, async t => {
	const { runtime, directory } = setup(t);
	for (let index = 0; index < 20; index++) runtime.terminals.create(null, directory);
	assert.throws(() => runtime.terminals.create(null, directory), /已创建且未退出的终端已达上限（20 个）/);
	// AI 成员的名额不受影响。
	assert.ok(runtime.terminals.create(addAi(runtime, '晚到').memberId, directory).terminalId);
});
