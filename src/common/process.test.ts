import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { killProcessTree } from './process.ts';

test('结束进程和它启动的子进程：进程很快就没了', async t => {
	// 一个自己不会结束的进程。Windows 上用 node：跨平台、不依赖 shell。
	const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
	t.after(() => child.kill());
	await delay(300);
	assert.equal(child.exitCode, null);
	const started = Date.now();
	killProcessTree(child);
	const exited = await Promise.race([
		new Promise<boolean>(resolve => child.on('exit', () => resolve(true))),
		delay(5000, false),
	]);
	assert.equal(exited, true, '结束进程后 5 秒内应该退出');
	assert.ok(Date.now() - started < 5000);
});
