import { formatLocal, formatOffset, localTime, offset, systemTimeZone, weekday, weekdayName } from '../common/time.ts';

/** 一个时刻，按哪个时区看。 */
export interface IClock {
	readonly at: number;
	readonly timeZone: string;
}

/**
 * 收到的内容带的时间（运行时设计第 5 部分「时间」）：text 是上下文里内容编号后面的那段，at、timeZone 是写下的时刻和时区，
 * full 是不是完整的时间（带星期、时区和 UTC 偏移）。写下就不再改。
 */
export interface ITimeNote extends IClock {
	readonly text: string;
	readonly full: boolean;
}

/** 不需要完整的时间时，离最晚的一条时间满这么久才带到分钟的。 */
const MINUTE_NOTE_INTERVAL_MS = 10 * 60 * 1000;

/** 这一刻，按运行时所在机器的时区。 */
export function clockAt(at: number): IClock {
	return { at, timeZone: systemTimeZone() };
}

/** 完整的时间，到分钟：2026-11-01 20:05 周日（America/Chicago，UTC-06:00）。 */
export function fullTime(clock: IClock): string {
	const local = localTime(clock.at, clock.timeZone);
	return `${formatLocal({ ...local, second: 0 })} ${weekdayName(weekday(local))}（${clock.timeZone}，${formatOffset(offset(clock.at, clock.timeZone))}）`;
}

/**
 * 收到的内容这时要带的时间，和上下文里还留着的内容带的时间比；不带时是 undefined。
 * 带完整的时间：还没有完整的时间，或者日期、时区、UTC 偏移和最晚的那条完整时间不同。和最晚的完整时间比，
 * 不和最晚的任意一条比：压缩可能把当天带完整时间的那条摘要掉、只留下后面带到分钟的几条，和到分钟的比就补不回星期和时区。
 * 不需要完整的时间时，离最晚的一条时间满 10 分钟带到分钟的。
 */
export function nextTimeNote(latestFull: IClock | undefined, latest: IClock | undefined, now: IClock): ITimeNote | undefined {
	if (!latestFull || !sameDayAndZone(latestFull, now)) return { ...now, full: true, text: `时间：${fullTime(now)}` };
	if (!latest || now.at - latest.at < MINUTE_NOTE_INTERVAL_MS) return undefined;
	return { ...now, full: false, text: `时间：${formatLocal({ ...localTime(now.at, now.timeZone), second: 0 })}` };
}

/** 日期、时区和 UTC 偏移（包括夏令时切换）都没变。日期各按各的时区算。 */
function sameDayAndZone(before: IClock, after: IClock): boolean {
	const left = localTime(before.at, before.timeZone);
	const right = localTime(after.at, after.timeZone);
	return left.year === right.year && left.month === right.month && left.day === right.day
		&& before.timeZone === after.timeZone && offset(before.at, before.timeZone) === offset(after.at, after.timeZone);
}

/**
 * 摘要和拿出上下文的说明里的时间范围（运行时设计第 5 部分「压缩」）：两端写到分钟，时区写一次跟在后面；
 * 两端的 UTC 偏移不同时（中间跨了夏令时切换）两个都写，按先后对应两端。写下时按当时的时区写，之后不再改。
 */
export function timeRangeText(startAt: number, endAt: number, timeZone: string = systemTimeZone()): string {
	const minute = (at: number) => formatLocal({ ...localTime(at, timeZone), second: 0 });
	const start = formatOffset(offset(startAt, timeZone));
	const end = formatOffset(offset(endAt, timeZone));
	return `${minute(startAt)} 到 ${minute(endAt)}（${timeZone}，${start === end ? start : `${start} 到 ${end}`}）`;
}
