import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fullTime, nextTimeNote, timeRangeText, type IClock } from './clock.ts';

const CHICAGO = 'America/Chicago';
const at = (iso: string, timeZone = CHICAGO): IClock => ({ at: Date.parse(iso), timeZone });
const MINUTES = 60_000;

test('完整的时间带星期、时区和 UTC 偏移，按写下时的时区算；到分钟的只有日期和时刻', () => {
	assert.equal(fullTime(at('2026-11-05T20:00:00Z')), '2026-11-05 14:00 周四（America/Chicago，UTC-06:00）');
	assert.equal(fullTime(at('2026-11-05T20:00:00Z', 'Asia/Shanghai')), '2026-11-06 04:00 周五（Asia/Shanghai，UTC+08:00）');
	const now = at('2026-11-05T20:15:40Z');
	assert.deepEqual(nextTimeNote(at('2026-11-05T20:00:00Z'), at('2026-11-05T20:00:00Z'), now), { ...now, full: false, text: '时间：2026-11-05 14:15' });
});

test('上下文里还没有完整的时间时写完整的：新成员，或者完整的时间都被压缩掉了，只剩到分钟的', () => {
	const now = at('2026-11-05T20:00:00Z');
	assert.deepEqual(nextTimeNote(undefined, undefined, now), { ...now, full: true, text: '时间：2026-11-05 14:00 周四（America/Chicago，UTC-06:00）' });
	assert.equal(nextTimeNote(undefined, at('2026-11-05T19:58:00Z'), now)?.full, true);
});

test('和最晚的完整时间比：日期、时区或 UTC 偏移变了写完整的；最晚的到分钟的是同一天也一样', () => {
	const full = at('2026-11-05T20:00:00Z');
	// 换了一天（按各自的时区算日期）：最晚一条是 1 分钟前到分钟的，也写完整的。
	assert.equal(nextTimeNote(full, at('2026-11-06T05:58:00Z'), at('2026-11-06T06:00:00Z'))?.full, true);
	assert.equal(nextTimeNote(full, at('2026-11-06T05:58:00Z'), at('2026-11-06T05:59:00Z')), undefined);
	// 换了时区：同一时刻也写完整的。
	assert.equal(nextTimeNote(full, full, at('2026-11-05T20:01:00Z', 'America/New_York'))?.full, true);
	// 夏令时结束：同一天、同一时区，偏移从 UTC-05:00 变成 UTC-06:00。
	const daylight = at('2026-11-01T06:00:00Z');
	const standard = at('2026-11-01T08:30:00Z');
	assert.equal(fullTime(daylight), '2026-11-01 01:00 周日（America/Chicago，UTC-05:00）');
	assert.deepEqual(nextTimeNote(daylight, daylight, standard), { ...standard, full: true, text: '时间：2026-11-01 02:30 周日（America/Chicago，UTC-06:00）' });
});

test('不需要完整的时间时：离最晚的一条时间（不管哪种）满 10 分钟写到分钟的，不满不写', () => {
	const full = at('2026-11-05T20:00:00Z');
	const minute = at('2026-11-05T20:30:00Z');
	const plus = (clock: IClock, minutes: number): IClock => ({ ...clock, at: clock.at + minutes * MINUTES });
	assert.equal(nextTimeNote(full, minute, plus(minute, 9)), undefined);
	assert.equal(nextTimeNote(full, minute, plus(minute, 10))?.full, false);
	assert.equal(nextTimeNote(full, full, plus(full, 9)), undefined);
});

test('时间范围两端写到分钟（秒舍掉），时区和 UTC 偏移写一次跟在后面', () => {
	assert.equal(timeRangeText(Date.parse('2026-11-01T16:02:59Z'), Date.parse('2026-11-01T17:40:30Z'), CHICAGO),
		'2026-11-01 10:02 到 2026-11-01 11:40（America/Chicago，UTC-06:00）');
	assert.equal(timeRangeText(Date.parse('2026-11-01T16:02:00Z'), Date.parse('2026-11-01T16:02:00Z'), 'Asia/Shanghai'),
		'2026-11-02 00:02 到 2026-11-02 00:02（Asia/Shanghai，UTC+08:00）');
});

test('时间范围中间跨了夏令时切换，两端的 UTC 偏移按先后都写', () => {
	assert.equal(timeRangeText(Date.parse('2027-03-14T07:30:00Z'), Date.parse('2027-03-14T08:30:00Z'), CHICAGO),
		'2027-03-14 01:30 到 2027-03-14 03:30（America/Chicago，UTC-06:00 到 UTC-05:00）');
	assert.equal(timeRangeText(Date.parse('2026-11-01T06:30:00Z'), Date.parse('2026-11-01T07:30:00Z'), CHICAGO),
		'2026-11-01 01:30 到 2026-11-01 01:30（America/Chicago，UTC-05:00 到 UTC-06:00）');
});
