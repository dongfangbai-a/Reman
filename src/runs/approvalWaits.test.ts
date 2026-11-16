import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApprovalWaits } from './approvalWaits.ts';

test('只在正在执行的调用全都在等审批时计时', () => {
	let now = 0;
	const waits = new ApprovalWaits(() => now);
	const a = waits.start();
	const b = waits.start();
	const doneA = a.wait();
	now = 10; // b 还在执行，不算
	const doneB = b.wait();
	now = 30; // 都在等：20
	doneA();
	now = 35;
	b.end(); // 只剩 a，a 不在等
	now = 40;
	doneB();
	const doneA2 = a.wait();
	now = 50; // a 在等：10
	a.end();
	now = 70;
	doneA2();
	assert.equal(waits.waitedMs(), 30);
});
