import type { ITask } from '../api/types.ts';

/** 运行中的在上、已结束的在下，两组都按开始时间从新到旧：新转入后台的总在最上面，位置稳定。 */
export function sortTasks(tasks: readonly ITask[]): ITask[] {
	return [...tasks].sort((left, right) => {
		const running = Number(right.status === 'running') - Number(left.status === 'running');
		return running || right.startedAt - left.startedAt || (left.taskId < right.taskId ? 1 : -1);
	});
}

/** 分两组：运行中的、已结束的，各自按开始时间从新到旧。 */
export function groupTasks(tasks: readonly ITask[]): { readonly running: ITask[]; readonly finished: ITask[] } {
	const sorted = sortTasks(tasks);
	return { running: sorted.filter(task => task.status === 'running'), finished: sorted.filter(task => task.status !== 'running') };
}
