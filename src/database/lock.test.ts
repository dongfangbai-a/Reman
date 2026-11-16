import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { temporaryDirectory } from '../testing.ts';
import { DataDirectoryLock } from './lock.ts';

/** 抢锁失败时的说明文字。 */
async function refusal(directory: string): Promise<string> {
	return await DataDirectoryLock.acquire(directory).then(() => '抢到了', (error: Error) => error.message);
}

test('数据目录的锁：一个目录只有一个运行时，放开之后才能再抢', async t => {
	const directory = temporaryDirectory(t);
	const first = await DataDirectoryLock.acquire(directory);
	assert.match(await refusal(directory), /已被另一个运行时占用/);
	first.release();
	first.release();
	const second = await DataDirectoryLock.acquire(directory);
	second.release();
});

test('数据目录的锁：被占时说出是哪个进程，好让人结束它', async t => {
	const directory = temporaryDirectory(t);
	const survivor = await DataDirectoryLock.acquire(directory);
	// 占着锁的运行时上次写的 runtime.json：进程号取一个肯定还在跑的（自己）。
	writeFileSync(join(directory, 'runtime.json'), JSON.stringify({ port: 6001, pid: process.pid }));
	const refusalText = await refusal(directory);
	assert.ok(refusalText.includes(`进程 ${process.pid} 还在运行`), refusalText);
	assert.ok(refusalText.includes('端口 6001'), refusalText);
	assert.ok(refusalText.includes(`taskkill /pid ${process.pid} /f`), refusalText);
	// 记下的进程号早没了：说明只是锁还没放开，提示过几秒再启动。
	writeFileSync(join(directory, 'runtime.json'), JSON.stringify({ port: 6001, pid: 999999 }));
	assert.match(await refusal(directory), /上一次的进程 999999 已经不在了/);
	survivor.release();
});
