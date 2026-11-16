import { invalid } from '../../common/errors.ts';
import { formatDuration } from '../../common/time.ts';
import { describeReminder, MAX_DELAY_SECONDS, MAX_NOTE_LENGTH, MAX_REMINDERS, type IReminder, type Reminders } from '../../reminders/reminders.ts';
import type { ITool } from '../tools.ts';

export const MANAGE_REMINDERS_TOOL_NAME = 'manage_reminders';

/** 定时：到点时唤醒自己，按当时写下的 note 去做。 */
export function createManageRemindersTool(reminders: Reminders): ITool<IReminder | IReminder[]> {
	// 结果给脚本的是定时本身；直接调用时的文字要说明做了什么，记在这里。
	const texts = new WeakMap<IReminder, string>();
	const done = (reminder: IReminder, text: string) => (texts.set(reminder, text), reminder);
	const saved = (verb: string, reminder: IReminder) => done(reminder, `${verb}定时 ${describeReminder(reminder)}，约 ${until(reminder.nextAt)}后到时间。届时系统会提醒你。`);
	return {
		name: MANAGE_REMINDERS_TOOL_NAME,
		label: '管理定时提醒',
		progressive: true,
		defaultPolicy: 'allow',
		approvable: false,
		description: [
			'在将来的某个时间提醒你做一件事，例如用户要求你明早 6 点查询天气并告知。',
			'新建定时只是记录下来，当前不会执行任何操作；到时间后系统会提醒你，发送一条「定时已到时间」的提示并附上你写的 note，届时再按 note 执行。',
			'时间按定时自身的时区计算；用户所说的是其他地区的时间时，用 timezone 指明。',
		].join('\n'),
		parameters: {
			type: 'object',
			properties: {
				action: { type: 'string', enum: ['add', 'update', 'cancel', 'list'], description: 'add 新建；update 修改；cancel 取消；list 列出你的定时' },
				reminder_id: { type: 'string', description: 'update、cancel 时必填：定时编号（R_ 开头）' },
				time: { type: 'string', description: '一次性定时写日期和时刻，如 2026-11-02 06:00；重复定时只写时刻，如 06:00；均可带秒，如 06:00:30' },
				delay_seconds: { type: 'integer', minimum: 1, maximum: MAX_DELAY_SECONDS, description: '用户指定相对时间（如 3 分钟后）时使用，单位为秒，如 180，从当前时刻起算；仅用于一次性定时，与 time 二者只能提供一个' },
				timezone: { type: 'string', description: 'IANA 时区名，如 America/Chicago；新建时不写则使用运行时所在机器的当前时区，通常即上下文中最近一条完整时间所标注的时区' },
				repeat: { type: 'string', enum: ['none', 'day', 'weekday', 'week'], description: 'none 仅一次（默认）；day 每天；weekday 周一至周五；week 每周 week_days 指定的几天' },
				week_days: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 7 }, description: 'repeat 为 week 时每周的哪几天，1 为周一，7 为周日' },
				note: { type: 'string', description: `到时间后要做的事，写给届时的你：做什么、结果告知谁、在哪个对话中告知。最长 ${MAX_NOTE_LENGTH} 字` },
			},
			required: ['action'],
			additionalProperties: false,
		},
		returns: '{ reminderId: string; when: string; timeZone: string; next: string; note: string } | { reminderId: string; when: string; timeZone: string; next: string; note: string }[]',
		execute(context, args) {
			const { action, reminder_id: reminderId, time, delay_seconds, timezone, repeat, week_days, note } = args;
			const input = { time, delay_seconds, timezone, repeat, week_days, note };
			switch (action) {
				case 'list': return reminders.list(context.memberId);
				case 'add': return saved('已新建', reminders.add(context.memberId, input));
				case 'update': return saved('已修改', reminders.update(context.memberId, requireId(reminderId), input));
				case 'cancel': {
					const reminder = reminders.cancel(requireId(reminderId), context.memberId);
					return done(reminder, `已取消定时 ${describeReminder(reminder)}`);
				}
				default: throw invalid('action 只能是 add、update、cancel 或 list');
			}
		},
		format(result) {
			if (Array.isArray(result)) {
				if (result.length === 0) return '暂无定时';
				// 每个定时一行，下面缩进写记下的事；多行的 note 每行都缩进，不和下一个定时混在一起。
				const lines = result.flatMap(reminder => [`- ${describeReminder(reminder)}`, `  记录的事项：${reminder.note.replace(/\n/g, '\n  ')}`]);
				return [`你的定时（最多 ${MAX_REMINDERS} 个）：`, ...lines].join('\n');
			}
			return texts.get(result) ?? describeReminder(result);
		},
	};
}

/** 离 at 还有多久：不到 1 小时写到秒，按整秒往上取；再长的按整分钟往上取，往下取会把「5 小时后」说成「还有约 4 小时 59 分钟」。 */
function until(at: number): string {
	const ms = at - Date.now();
	if (ms < 3600_000) return formatDuration(Math.ceil(ms / 1000) * 1000, true);
	return formatDuration(Math.ceil(ms / 60_000) * 60_000);
}

function requireId(reminderId: unknown): string {
	if (typeof reminderId !== 'string' || !reminderId) throw invalid('须提供 reminder_id');
	return reminderId;
}
