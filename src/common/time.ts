/** 某个时区里的日期和时刻。month 从 1 开始；weekday 1 是周一，7 是周日。 */
export interface ILocalTime {
	readonly year: number;
	readonly month: number;
	readonly day: number;
	readonly hour: number;
	readonly minute: number;
	readonly second: number;
}

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const WEEKDAY_NAMES = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const formatters = new Map<string, Intl.DateTimeFormat>();

/** 运行时所在机器的系统时区。 */
export function systemTimeZone(): string {
	return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** 是不是认识的 IANA 时区名。 */
export function isTimeZone(timeZone: string): boolean {
	try {
		formatter(timeZone);
		return true;
	} catch {
		return false;
	}
}

/** 某一时刻在这个时区里是几月几号几点。 */
export function localTime(instant: number, timeZone: string): ILocalTime {
	const parts = Object.fromEntries(formatter(timeZone).formatToParts(new Date(instant)).map(part => [part.type, part.value]));
	return {
		year: Number(parts['year']), month: Number(parts['month']), day: Number(parts['day']),
		hour: Number(parts['hour']), minute: Number(parts['minute']), second: Number(parts['second']),
	};
}

/** 这一天是星期几，1 是周一，7 是周日。 */
export function weekday(time: Pick<ILocalTime, 'year' | 'month' | 'day'>): number {
	return new Date(Date.UTC(time.year, time.month - 1, time.day)).getUTCDay() || 7;
}

/** 这个时区在这一时刻比 UTC 快多少毫秒。 */
export function offset(instant: number, timeZone: string): number {
	return asUtc(localTime(instant, timeZone)) - Math.floor(instant / 1000) * 1000;
}

/**
 * 这个时区里的某个时刻对应的绝对时刻。夏令时开始那天不存在的时刻往后顺延（按切换前的偏移算），
 * 结束那天出现两次的时刻用第一次。
 */
export function toInstant(time: ILocalTime, timeZone: string): number {
	return instantsOf(time, timeZone)[0] ?? asUtc(time) - offset(asUtc(time) - DAY_MS, timeZone);
}

/** 这个时区里的某个时刻对应的全部绝对时刻，按先后排：一般一个；秋天往回拨那天出现两次的有两个；春天往前拨跳过的一个都没有。 */
export function instantsOf(time: ILocalTime, timeZone: string): number[] {
	const guess = asUtc(time);
	const candidates = new Set([guess - offset(guess - DAY_MS, timeZone), guess - offset(guess + DAY_MS, timeZone)]);
	return [...candidates].filter(instant => sameTime(localTime(instant, timeZone), time)).sort((left, right) => left - right);
}

/** 这个时区里从某个时刻起的第一个绝对时刻：出现两次的用第一次；春天往前拨跳过的时刻是切换的那一刻。 */
export function firstInstantFrom(time: ILocalTime, timeZone: string): number {
	const first = instantsOf(time, timeZone)[0];
	if (first !== undefined) return first;
	// 跳过的时刻按切换后的偏移算落在切换前，按切换前的偏移算落在切换后，切换的那一刻在两者之间。
	const guess = asUtc(time);
	let low = guess - offset(guess + DAY_MS, timeZone);
	let high = guess - offset(guess - DAY_MS, timeZone);
	const before = offset(low, timeZone);
	while (high - low > 1) {
		const middle = Math.floor((low + high) / 2);
		if (offset(middle, timeZone) === before) low = middle;
		else high = middle;
	}
	return high;
}

/** 从某一天往后数几天。 */
export function addDays(time: ILocalTime, days: number): ILocalTime {
	const date = new Date(Date.UTC(time.year, time.month - 1, time.day + days));
	return { ...time, year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

/** 读 2026-11-02 06:00 或 2026-11-02 06:00:30 这样的日期和时刻；写法不对或日期不存在时是 undefined。 */
export function parseDateTime(text: string): ILocalTime | undefined {
	const match = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}:\d{2}(?::\d{2})?)$/.exec(text.trim());
	const clock = match && parseClock(match[4]!);
	if (!clock) return undefined;
	const [year, month, day] = match.slice(1, 4).map(Number) as [number, number, number];
	const local = { year, month, day, ...clock };
	const normalized = addDays(local, 0);
	if (normalized.month !== month || normalized.day !== day) return undefined;
	return local;
}

/** 读 06:00 或 06:00:30 这样的时刻；写法不对时是 undefined。 */
export function parseClock(text: string): Pick<ILocalTime, 'hour' | 'minute' | 'second'> | undefined {
	const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text.trim());
	if (!match) return undefined;
	const [hour, minute, second] = [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
	if (hour > 23 || minute > 59 || second > 59) return undefined;
	return { hour, minute, second };
}

/** 06:00，秒不是 0 时 06:00:30；seconds 是 always 时总带秒。 */
export function formatClock(time: Pick<ILocalTime, 'hour' | 'minute' | 'second'>, seconds: 'auto' | 'always' = 'auto'): string {
	const clock = `${pad(time.hour)}:${pad(time.minute)}`;
	return time.second !== 0 || seconds === 'always' ? `${clock}:${pad(time.second)}` : clock;
}

/** 2026-11-02 06:00，秒不是 0 时 2026-11-02 06:00:30；seconds 是 always 时总带秒。 */
export function formatLocal(time: ILocalTime, seconds: 'auto' | 'always' = 'auto'): string {
	return `${time.year}-${pad(time.month)}-${pad(time.day)} ${formatClock(time, seconds)}`;
}

/** 11 月 2 日 周一 06:00，秒不是 0 时写到秒；不是 currentYear 这一年时前面加年份。 */
export function describeLocal(time: ILocalTime, currentYear: number): string {
	const date = `${time.month} 月 ${time.day} 日 ${WEEKDAY_NAMES[weekday(time)]} ${formatClock(time)}`;
	return time.year === currentYear ? date : `${time.year} 年 ${date}`;
}

/** UTC+08:00、UTC-05:30。 */
export function formatOffset(offsetMs: number): string {
	const minutes = Math.round(Math.abs(offsetMs) / MINUTE_MS);
	return `UTC${offsetMs < 0 ? '-' : '+'}${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

export function weekdayName(day: number): string {
	return WEEKDAY_NAMES[day] ?? '';
}

/** 2 小时 5 分钟；withSeconds 时带上秒，如 2 分钟 20 秒。不够最小的单位时是空字符串。 */
export function formatDuration(ms: number, withSeconds = false): string {
	const seconds = Math.floor(ms / 1000);
	const minutes = Math.floor(seconds / 60);
	const days = Math.floor(minutes / (24 * 60));
	const hours = Math.floor(minutes / 60) % 24;
	const parts = [days && `${days} 天`, hours && `${hours} 小时`, minutes % 60 && `${minutes % 60} 分钟`, withSeconds && seconds % 60 && `${seconds % 60} 秒`];
	return parts.filter(Boolean).join(' ');
}

/** 把这个时刻当成 UTC 的时间戳，用来和时区偏移一起换算。 */
function asUtc(time: ILocalTime): number {
	return Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute, time.second);
}

function sameTime(left: ILocalTime, right: ILocalTime): boolean {
	return left.year === right.year && left.month === right.month && left.day === right.day && left.hour === right.hour && left.minute === right.minute && left.second === right.second;
}

function formatter(timeZone: string): Intl.DateTimeFormat {
	let cached = formatters.get(timeZone);
	if (!cached) {
		cached = new Intl.DateTimeFormat('en-US', {
			timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
		});
		formatters.set(timeZone, cached);
	}
	return cached;
}

function pad(value: number): string {
	return String(value).padStart(2, '0');
}
