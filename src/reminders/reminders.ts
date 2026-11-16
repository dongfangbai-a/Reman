import { invalid, notFound } from '../common/errors.ts';
import type { EventHub } from '../common/events.ts';
import { newId, wrongKind } from '../common/ids.ts';
import { addDays, describeLocal, formatClock, formatLocal, isTimeZone, localTime, parseClock, parseDateTime, systemTimeZone, toInstant, weekday, weekdayName } from '../common/time.ts';
import type { Database } from '../database/database.ts';
import type { Timeline } from '../timeline/timeline.ts';

/** 每个成员最多几个定时。 */
export const MAX_REMINDERS = 20;
export const MAX_NOTE_LENGTH = 1000;
/** delay_seconds 最长 365 天，再远的用 time。 */
export const MAX_DELAY_SECONDS = 365 * 24 * 60 * 60;
/** 用户取消定时时，告诉成员的说明里记录的事项最多写多少字：说明不会因为内容太多被拿出上下文，不能太长。 */
const CANCEL_NOTE_LENGTH = 100;
/** 每隔多久按系统时间检查一次：电脑睡眠时计时器会停，系统时间改了计时器也不知道。 */
const CHECK_INTERVAL_MS = 60 * 1000;
/** 计时器最长设多久，再长的到时重新设。 */
const MAX_TIMER_MS = 60 * 60 * 1000;
const REPEATS = ['none', 'day', 'weekday', 'week'] as const;
/** 成员没被删除的定时。 */
const ALIVE = 'member_id IN (SELECT member_id FROM members WHERE deleted_at IS NULL)';

export type ReminderRepeat = typeof REPEATS[number];

export interface IReminder {
	readonly reminderId: string;
	readonly memberId: string;
	/** 到时要做的事，成员自己写的。 */
	readonly note: string;
	/** 一次性的是 2026-11-02 06:00，重复的是 06:00，都是 timeZone 里的时刻。 */
	readonly time: string;
	readonly timeZone: string;
	readonly repeat: ReminderRepeat;
	/** repeat 是 week 时每周哪几天，1 是周一，7 是周日。 */
	readonly weekDays: readonly number[];
	/** 下一次触发的时刻。 */
	readonly nextAt: number;
	/** 时间的说明：「11 月 2 日 周一 06:00」「每天 06:00」「每周一、三 06:00」。 */
	readonly when: string;
	/** 下一次的说明，如「11 月 3 日 周二 06:00」。 */
	readonly next: string;
	readonly createdAt: number;
	readonly updatedAt: number;
}

/** 新建或修改定时的参数，和工具参数同名。修改时没给的沿用原来的。 */
export interface IReminderInput {
	readonly time?: unknown;
	readonly delay_seconds?: unknown;
	readonly timezone?: unknown;
	readonly repeat?: unknown;
	readonly week_days?: unknown;
	readonly note?: unknown;
}

/** 定时到了，进时间线的那条记录。 */
export interface IReminderFired {
	readonly reminderId: string;
	readonly note: string;
	/** 原定的时刻，timeZone 里的 2026-11-02 06:00，秒不是 0 时 2026-11-02 06:00:30。 */
	readonly time: string;
	readonly timeZone: string;
	/** 重复的定时的规则，如「每天 06:00」；一次性的是 null。 */
	readonly repeat: string | null;
	/** 重复的定时下一次的说明，如「11 月 3 日 周二 06:00」；一次性的是 null。 */
	readonly next: string | null;
	/** 比原定晚了多久。 */
	readonly lateMs: number;
}

interface IReminderRow {
	readonly reminder_id: string;
	readonly member_id: string;
	readonly note: string;
	readonly time: string;
	readonly time_zone: string;
	readonly repeat: ReminderRepeat;
	readonly week_days_json: string;
	readonly next_at: number;
	readonly created_at: number;
	readonly updated_at: number;
}

interface IResolved {
	readonly note: string;
	readonly time: string;
	readonly timeZone: string;
	readonly repeat: ReminderRepeat;
	readonly weekDays: readonly number[];
	readonly nextAt: number;
}

/**
 * 成员的定时。到点时往成员的时间线里加一条会唤醒它的记录，内容是它自己写下的要做的事。
 * 每个定时记下自己的时区，系统时区以后改了也不跟着变。对最早的那个设计时器准时触发，另外每分钟按系统时间检查一次。
 */
export class Reminders {
	private readonly db: Database;
	private readonly events: EventHub;
	private readonly timeline: Timeline;
	private readonly now: () => number;
	private timer: NodeJS.Timeout | undefined;
	private interval: NodeJS.Timeout | undefined;

	constructor(db: Database, events: EventHub, timeline: Timeline, now: () => number = Date.now) {
		this.db = db;
		this.events = events;
		this.timeline = timeline;
		this.now = now;
	}

	/** 开始计时：先补触发运行时没在运行时错过的。 */
	start(): void {
		if (this.interval) return;
		this.interval = setInterval(() => this.check(), CHECK_INTERVAL_MS);
		this.interval.unref();
		this.check();
	}

	close(): void {
		clearInterval(this.interval);
		clearTimeout(this.timer);
		this.interval = undefined;
		this.timer = undefined;
	}

	list(memberId: string): IReminder[] {
		return this.db.all<IReminderRow>('SELECT * FROM reminders WHERE member_id = ? ORDER BY next_at, created_at', memberId).map(row => this.toReminder(row));
	}

	get(reminderId: string): IReminder | undefined {
		const row = this.db.get<IReminderRow>('SELECT * FROM reminders WHERE reminder_id = ?', reminderId);
		return row && this.toReminder(row);
	}

	add(memberId: string, input: IReminderInput): IReminder {
		if (this.list(memberId).length >= MAX_REMINDERS) throw invalid(`最多 ${MAX_REMINDERS} 个定时，请先取消不再需要的定时`);
		const resolved = this.resolve(undefined, input);
		const reminderId = newId('R', id => this.db.get('SELECT 1 FROM reminders WHERE reminder_id = ?', id) !== undefined);
		const now = this.now();
		this.db.transaction(() => {
			this.db.run(`
				INSERT INTO reminders (reminder_id, member_id, note, time, time_zone, repeat, week_days_json, next_at, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`, reminderId, memberId, resolved.note, resolved.time, resolved.timeZone, resolved.repeat, JSON.stringify(resolved.weekDays), resolved.nextAt, now, now);
			this.events.emit({ type: 'reminder.changed', memberId });
		});
		this.arm();
		return this.get(reminderId)!;
	}

	/** 修改成员自己的定时。 */
	update(memberId: string, reminderId: string, input: IReminderInput): IReminder {
		const previous = this.own(memberId, reminderId);
		const resolved = this.resolve(previous, input);
		this.db.transaction(() => {
			this.db.run(`
				UPDATE reminders SET note = ?, time = ?, time_zone = ?, repeat = ?, week_days_json = ?, next_at = ?, updated_at = ? WHERE reminder_id = ?
			`, resolved.note, resolved.time, resolved.timeZone, resolved.repeat, JSON.stringify(resolved.weekDays), resolved.nextAt, this.now(), reminderId);
			this.events.emit({ type: 'reminder.changed', memberId });
		});
		this.arm();
		return this.get(reminderId)!;
	}

	/**
	 * 取消定时。给了 memberId 时只能取消这个成员自己的（成员用工具取消）；不给时是用户取消。
	 * 用户取消时在成员的时间线末尾放一条变动说明，不唤醒：不说的话，它上下文里还写着已新建这个定时，以为到时间会被提醒，
	 * 答应过别人的事会悄悄落空。说明里带上记录的事项，成员不用翻找就知道是哪件事。
	 */
	cancel(reminderId: string, memberId?: string): IReminder {
		const reminder = memberId === undefined ? this.get(reminderId) : this.own(memberId, reminderId);
		if (!reminder) throw notFound(wrongKind(reminderId, 'R') ?? `未找到定时 ${reminderId}`);
		this.db.transaction(() => {
			this.db.run('DELETE FROM reminders WHERE reminder_id = ?', reminderId);
			if (memberId === undefined) {
				const note = reminder.note.length > CANCEL_NOTE_LENGTH ? `${reminder.note.slice(0, CANCEL_NOTE_LENGTH)}…` : reminder.note;
				this.timeline.appendChangeNotice(reminder.memberId, {
					text: `用户取消了你的定时 ${reminder.reminderId}：${reminder.when}（${reminder.timeZone}），到时间后不会再提醒你。记录的事项：${note}`,
					brief: `用户取消了定时：${reminder.when}`,
				});
			}
			this.events.emit({ type: 'reminder.changed', memberId: reminder.memberId });
		});
		this.arm();
		return reminder;
	}

	/** 成员彻底删除时，它的定时一起删掉。 */
	removeMember(memberId: string): void {
		this.db.transaction(() => {
			if (this.db.run('DELETE FROM reminders WHERE member_id = ?', memberId).changes > 0) this.events.emit({ type: 'reminder.changed', memberId });
		});
		this.arm();
	}

	/**
	 * 触发到点的定时。错过的也只触发一次，重复的从现在往后算下一次。
	 * 已删除的成员的定时不触发，等它恢复后再检查，删除期间错过的那时补触发。
	 */
	check(): void {
		const now = this.now();
		for (const row of this.db.all<IReminderRow>(`SELECT * FROM reminders WHERE next_at <= ? AND ${ALIVE} ORDER BY next_at`, now)) {
			this.db.transaction(() => {
				const nextAt = row.repeat === 'none' ? undefined : nextOccurrence(row.time, row.time_zone, row.repeat, JSON.parse(row.week_days_json) as number[], now);
				const reminder = this.toReminder(row);
				this.timeline.appendReminder(row.member_id, {
					reminderId: row.reminder_id, note: row.note, time: formatLocal(localTime(row.next_at, row.time_zone)), timeZone: row.time_zone,
					repeat: row.repeat === 'none' ? null : reminder.when,
					next: nextAt === undefined ? null : describeLocal(localTime(nextAt, row.time_zone), localTime(now, row.time_zone).year),
					lateMs: Math.max(0, now - row.next_at),
				});
				if (nextAt === undefined) {
					this.db.run('DELETE FROM reminders WHERE reminder_id = ?', row.reminder_id);
				} else {
					this.db.run('UPDATE reminders SET next_at = ? WHERE reminder_id = ?', nextAt, row.reminder_id);
				}
				this.events.emit({ type: 'reminder.changed', memberId: row.member_id });
			});
		}
		this.arm();
	}

	/** 对最早的定时设计时器。 */
	private arm(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
		if (!this.interval) return;
		const next = this.db.get<{ next_at: number | null }>(`SELECT MIN(next_at) AS next_at FROM reminders WHERE ${ALIVE}`)?.next_at;
		if (next === null || next === undefined) return;
		this.timer = setTimeout(() => this.check(), Math.min(Math.max(0, next - this.now()), MAX_TIMER_MS));
		this.timer.unref();
	}

	private own(memberId: string, reminderId: string): IReminder {
		const reminder = this.get(reminderId);
		if (!reminder || reminder.memberId !== memberId) throw notFound(wrongKind(reminderId, 'R') ?? `未找到你的定时 ${reminderId}`);
		return reminder;
	}

	/** 检查参数，算出下一次触发的时刻。修改时没给的沿用原来的。 */
	private resolve(previous: IReminder | undefined, input: IReminderInput): IResolved {
		const repeat = input.repeat ?? previous?.repeat ?? 'none';
		if (!REPEATS.includes(repeat as ReminderRepeat)) throw invalid('repeat 只能是 none、day、weekday 或 week');
		const timeZone = input.timezone ?? previous?.timeZone ?? systemTimeZone();
		if (typeof timeZone !== 'string' || !isTimeZone(timeZone)) throw invalid(`无法识别的时区「${String(timeZone)}」，须为 IANA 时区名，如 Asia/Shanghai`);
		const note = input.note ?? previous?.note;
		if (typeof note !== 'string' || !note.trim()) throw invalid('note 须写明到时间后要做的事');
		if (note.length > MAX_NOTE_LENGTH) throw invalid(`note 最长 ${MAX_NOTE_LENGTH} 字`);

		let weekDays: number[] = [];
		if (repeat === 'week') {
			const days = input.week_days ?? (previous?.repeat === 'week' ? previous.weekDays : undefined);
			if (!Array.isArray(days) || days.length === 0 || !days.every(day => Number.isInteger(day) && day >= 1 && day <= 7)) {
				throw invalid('repeat 为 week 时须提供 week_days：每周的哪几天，1 为周一，7 为周日');
			}
			weekDays = [...new Set(days as number[])].sort((left, right) => left - right);
		} else if (input.week_days !== undefined) {
			throw invalid('week_days 仅在 repeat 为 week 时使用');
		}

		const now = this.now();
		// 从现在起多久：在执行的这一刻起算，存下算出来的时刻。
		if (input.delay_seconds !== undefined) {
			if (input.time !== undefined) throw invalid('time 和 delay_seconds 只能提供一个');
			if (repeat !== 'none') throw invalid('delay_seconds 仅用于一次性定时，重复定时用 time 指定时刻');
			const delay = input.delay_seconds;
			if (typeof delay !== 'number' || !Number.isInteger(delay) || delay < 1 || delay > MAX_DELAY_SECONDS) {
				throw invalid(`delay_seconds 须为 1 到 ${MAX_DELAY_SECONDS} 之间的整数秒（最多 365 天），更远的时间用 time`);
			}
			const nextAt = now + delay * 1000;
			return { note: note.trim(), time: formatLocal(localTime(nextAt, timeZone)), timeZone, repeat, weekDays, nextAt };
		}

		let time = input.time;
		if (time === undefined && previous) {
			if (previous.repeat === 'none' && repeat !== 'none') time = previous.time.slice(11);
			else if (previous.repeat !== 'none' && repeat === 'none') throw invalid('改为一次性定时时须提供 time（如 2026-11-02 06:00）或 delay_seconds');
			else time = previous.time;
		}
		if (typeof time !== 'string') throw invalid(repeat === 'none' ? '须提供 time（如 2026-11-02 06:00）或 delay_seconds' : 'time 须写成 06:00 的形式');
		if (repeat === 'none') {
			const local = parseDateTime(time);
			if (!local) throw invalid(`time「${time}」须为 2026-11-02 06:00 形式的日期和时刻，可带秒，如 2026-11-02 06:00:30`);
			const nextAt = toInstant(local, timeZone);
			const current = localTime(now, timeZone);
			if (nextAt <= now) throw invalid(`该时间已过，${timeZone} 当前时间为 ${describeLocal(current, current.year)}`);
			return { note: note.trim(), time: formatLocal(local), timeZone, repeat, weekDays, nextAt };
		}
		const clock = parseClock(time);
		if (!clock) throw invalid(`重复定时的 time 只写时刻，如 06:00 或 06:00:30，不写日期`);
		const text = formatClock(clock);
		return { note: note.trim(), time: text, timeZone, repeat: repeat as ReminderRepeat, weekDays, nextAt: nextOccurrence(text, timeZone, repeat as ReminderRepeat, weekDays, now) };
	}

	private toReminder(row: IReminderRow): IReminder {
		const weekDays = JSON.parse(row.week_days_json) as number[];
		const currentYear = localTime(this.now(), row.time_zone).year;
		const next = describeLocal(localTime(row.next_at, row.time_zone), currentYear);
		const when = row.repeat === 'none' ? next : `${repeatLabel(row.repeat, weekDays)} ${row.time}`;
		return {
			reminderId: row.reminder_id, memberId: row.member_id, note: row.note, time: row.time, timeZone: row.time_zone, repeat: row.repeat, weekDays,
			nextAt: row.next_at, when, next, createdAt: row.created_at, updatedAt: row.updated_at,
		};
	}
}

/** 一个定时在给成员看的列表里的一行。 */
export function describeReminder(reminder: IReminder): string {
	const next = reminder.repeat === 'none' ? '' : `，下次时间 ${reminder.next}`;
	return `${reminder.reminderId}：${reminder.when}（${reminder.timeZone}）${next}`;
}

function repeatLabel(repeat: ReminderRepeat, weekDays: readonly number[]): string {
	if (repeat === 'day') return '每天';
	if (repeat === 'weekday') return '工作日';
	return `每${weekDays.map(day => weekdayName(day)).join('、').replace(/、周/g, '、')}`;
}

/** 重复的定时在 after 之后的下一次。 */
function nextOccurrence(clock: string, timeZone: string, repeat: ReminderRepeat, weekDays: readonly number[], after: number): number {
	const today = { ...localTime(after, timeZone), ...parseClock(clock)! };
	for (let days = 0; days <= 8; days++) {
		const date = addDays(today, days);
		const day = weekday(date);
		if (repeat === 'weekday' && day > 5) continue;
		if (repeat === 'week' && !weekDays.includes(day)) continue;
		const instant = toInstant(date, timeZone);
		if (instant > after) return instant;
	}
	throw new Error(`无法计算定时的下一次时间：${clock} ${repeat}`);
}
