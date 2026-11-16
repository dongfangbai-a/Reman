import type { ReminderRepeat } from '../api/types.ts';

const WEEKDAYS = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];

/** 「2026-11-02 06:00」写成「11 月 2 日 周一 06:00」（带秒的照写），不是今年的加上年份。写法不对时原样返回。 */
export function reminderDateTime(time: string): string {
	const match = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}:\d{2}(?::\d{2})?)$/.exec(time.trim());
	if (!match) return time;
	const [year, month, day] = match.slice(1, 4).map(Number) as [number, number, number];
	const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay() || 7;
	const date = `${month} 月 ${day} 日 ${WEEKDAYS[weekday]} ${match[4]}`;
	return year === new Date().getFullYear() ? date : `${year} 年 ${date}`;
}

/** 定时的时间：一次性的「11 月 2 日 周一 06:00」，重复的「每天 06:00」「工作日 06:00」「每周一、三 06:00」。 */
export function reminderWhen(time: string, repeat: ReminderRepeat | string | undefined, weekDays: readonly number[] = []): string {
	switch (repeat) {
		case 'day': return `每天 ${time}`;
		case 'weekday': return `工作日 ${time}`;
		case 'week': return `每${weekDays.map(day => WEEKDAYS[day] ?? '').join('、').replace(/、周/g, '、')} ${time}`;
		default: return reminderDateTime(time);
	}
}

/** 时区的中文名，如「北美中部时间」；浏览器不认识时用时区名。 */
export function timeZoneName(timeZone: string): string {
	try {
		return new Intl.DateTimeFormat('zh-CN', { timeZone, timeZoneName: 'longGeneric' }).formatToParts(new Date()).find(part => part.type === 'timeZoneName')?.value ?? timeZone;
	} catch {
		return timeZone;
	}
}

/** 「3 分钟后」「1 小时 30 秒后」：从现在起多少秒。 */
export function delayText(seconds: number): string {
	const parts = [Math.floor(seconds / 86400) && `${Math.floor(seconds / 86400)} 天`, Math.floor(seconds / 3600) % 24 && `${Math.floor(seconds / 3600) % 24} 小时`,
		Math.floor(seconds / 60) % 60 && `${Math.floor(seconds / 60) % 60} 分钟`, seconds % 60 && `${seconds % 60} 秒`];
	return `${parts.filter(Boolean).join(' ')}后`;
}

/** 2 天 3 小时 5 分钟；不到 1 分钟时是空字符串。 */
export function durationText(ms: number): string {
	const minutes = Math.floor(ms / 60000);
	const days = Math.floor(minutes / 1440);
	const hours = Math.floor(minutes / 60) % 24;
	return [days && `${days} 天`, hours && `${hours} 小时`, minutes % 60 && `${minutes % 60} 分钟`].filter(Boolean).join(' ');
}
