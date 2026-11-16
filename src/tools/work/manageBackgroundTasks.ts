import { invalid } from '../../common/errors.ts';
import { clipEnd } from '../../common/text.ts';
import { compactDuration, RECENT_LINES, recentOutput } from '../backgroundText.ts';
import type { LiveOutputs } from '../liveOutputs.ts';
import type { ITask, Tasks } from '../tasks.ts';
import type { ITool } from '../tools.ts';

/** 「做什么」最多写多少字。 */
const CALL_CHARS = 200;

/** 正在运行的后台任务。 */
export interface IRunningTask {
	readonly taskId: string;
	readonly toolName: string;
	/** 做什么：shell 是命令，terminal 的等待写等哪个终端、什么时候结束，其他工具是参数 JSON，长的截断。 */
	readonly call: string;
	readonly runningSeconds: number;
	/** 还剩多少秒到时限；没有时限的工具是 null。shell 到时被结束；terminal 的等待到时只是不再等，见 returnsOnTimeout。 */
	readonly timeoutInSeconds: number | null;
	/** 到时限时只是返回、程序继续运行（terminal 的等待）；到时被结束的是 false。 */
	readonly returnsOnTimeout: boolean;
	/** shell 到目前为止输出的最后几行；别的工具没有执行中的输出，是 null。 */
	readonly recentOutput: string | null;
}

/**
 * 查看或取消自己的后台任务。list 返回正在运行的任务，cancel 等任务结束，返回一句说明和取消前的输出。
 * 只有工具名和编号时判断不了哪个该停：写上做什么、运行了多久和最近的输出，才分得清是卡住了还是在正常干活。
 * 还剩多久超时也写上：压缩之后回来一查，就知道服务快被结束了，要不要重启自己决定。
 * timeoutOf 给出这次调用最多运行多久（毫秒），没有超时的工具是 undefined。
 * statusOf 是工具自己说这个任务在做什么、最晚什么时刻结束（见 ITool.taskStatus），有的话用它的：terminal 的等待最晚结束的时刻会顺延。
 */
export function createManageBackgroundTasksTool(
	tasks: Tasks, liveOutputs: LiveOutputs, timeoutOf: (toolName: string, args: Record<string, unknown>) => number | undefined,
	statusOf: (toolName: string, taskId: string) => { readonly summary: string; readonly returnsAt: number } | undefined = () => undefined,
): ITool<IRunningTask[] | string> {
	return {
		name: 'manage_background_tasks',
		label: '管理后台任务',
		progressive: true,
		description: '查看或取消你的后台任务。执行时间较长的工具调用会自动转为后台任务，结束后结果会作为新内容送达给你。查看时列出每个任务的内容、已运行时长和距超时的剩余时间，shell 任务还包括最近的输出。取消 terminal 的后台任务不影响终端中的程序。',
		parameters: {
			type: 'object',
			properties: {
				action: { type: 'string', enum: ['list', 'cancel'], description: 'list 列出正在运行的后台任务；cancel 取消一个任务' },
				task_id: { type: 'string', description: 'cancel 时必填：后台任务 ID（B_ 开头）' },
			},
			required: ['action'],
			additionalProperties: false,
		},
		returns: '{ taskId: string; toolName: string; call: string; runningSeconds: number; timeoutInSeconds: number | null; returnsOnTimeout: boolean; recentOutput: string | null }[] | string',
		execute(context, args) {
			if (args['action'] === 'list') {
				const now = Date.now();
				return tasks.list(context.memberId, { runningOnly: true }).map(task => {
					const status = statusOf(task.toolName, task.taskId);
					const timeoutMs = status ? undefined : timeoutOf(task.toolName, (task.arguments ?? {}) as Record<string, unknown>);
					const endsAt = status ? status.returnsAt : timeoutMs === undefined ? undefined : task.startedAt + timeoutMs;
					return {
						taskId: task.taskId,
						toolName: task.toolName,
						call: status ? status.summary : describeCall(task),
						runningSeconds: Math.round((now - task.startedAt) / 1000),
						timeoutInSeconds: endsAt === undefined ? null : Math.max(0, Math.round((endsAt - now) / 1000)),
						returnsOnTimeout: status !== undefined,
						recentOutput: recentOutput(liveOutputs.read(task.runId, task.callId)?.output),
					};
				});
			}
			if (args['action'] === 'cancel') {
				const taskId = args['task_id'];
				if (typeof taskId !== 'string' || !taskId) throw invalid('cancel 须提供 task_id');
				return tasks.cancelOwn(taskId, context.memberId, context.signal).then(output =>
					output === undefined ? `已取消后台任务 ${taskId}，任务正在结束；结束后，取消前的输出会作为新内容送达给你。`
						: output ? `已取消后台任务 ${taskId}，取消前的输出：\n${output}`
							: `已取消后台任务 ${taskId}，取消前无输出。`);
			}
			throw invalid('action 只能是 list 或 cancel');
		},
		format(result) {
			if (typeof result === 'string') return result;
			if (result.length === 0) return '没有正在运行的后台任务';
			return result.map(task => [
				`- ${task.taskId}：${task.toolName}，${task.returnsOnTimeout ? '已等待' : '已运行'} ${compactDuration(task.runningSeconds)}${timeLeft(task)}`,
				`  内容：${task.call}`,
				...task.recentOutput === null ? []
					: task.recentOutput ? [`  最近的输出（最后 ${RECENT_LINES} 行以内）：`, ...task.recentOutput.split('\n').map(line => `    ${line}`)]
						: ['  最近的输出：（尚无输出）'],
			].join('\n')).join('\n');
		},
	};
}

/** 还剩多久到时限：到时被结束的写「1m40s 后超时」，到时只是返回的写「最晚 21m40s 后返回」。 */
function timeLeft(task: IRunningTask): string {
	if (task.timeoutInSeconds === null) return '';
	if (task.returnsOnTimeout) return task.timeoutInSeconds > 0 ? `，最晚 ${compactDuration(task.timeoutInSeconds)} 后返回` : '，即将返回';
	return task.timeoutInSeconds > 0 ? `，${compactDuration(task.timeoutInSeconds)} 后超时` : '，即将超时';
}

/** 做什么：shell 写命令，其他工具写参数 JSON；长的截断。 */
function describeCall(task: ITask): string {
	const args = task.arguments as Record<string, unknown> | null;
	const text = task.toolName === 'shell' && typeof args?.['command'] === 'string' ? args['command'] : JSON.stringify(task.arguments);
	return clipEnd(text, CALL_CHARS);
}
