import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ITask } from '../api/types.ts';
import { groupTasks, sortTasks } from './sort.ts';

const task = (taskId: string, status: ITask['status'], startedAt: number): ITask => ({
	taskId, memberId: 'M_A', runId: 1, callId: taskId, toolName: 'shell', arguments: {}, status, output: null, startedAt, endedAt: null,
});

test('后台任务：运行中的在上、已结束的在下，两组都按开始时间从新到旧', () => {
	const tasks = [task('B_1', 'completed', 100), task('B_2', 'running', 200), task('B_3', 'cancelled', 300), task('B_4', 'running', 50)];
	assert.deepEqual(sortTasks(tasks).map(item => item.taskId), ['B_2', 'B_4', 'B_3', 'B_1']);
});

test('后台任务分组：运行中的、已结束的各一组，各自从新到旧', () => {
	const tasks = [task('B_1', 'completed', 100), task('B_2', 'running', 200), task('B_3', 'cancelled', 300), task('B_4', 'running', 50), task('B_5', 'failed', 400)];
	const { running, finished } = groupTasks(tasks);
	assert.deepEqual(running.map(item => item.taskId), ['B_2', 'B_4']);
	assert.deepEqual(finished.map(item => item.taskId), ['B_5', 'B_3', 'B_1']);
});
