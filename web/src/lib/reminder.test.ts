import assert from 'node:assert/strict';
import { test } from 'node:test';
import { delayText, durationText, reminderDateTime, reminderWhen, timeZoneName } from './reminder.ts';

test('一次性定时的时间：写成几月几日周几，带秒的照写，不是今年的加年份', () => {
	assert.equal(reminderDateTime('2020-11-02 06:00'), '2020 年 11 月 2 日 周一 06:00');
	assert.equal(reminderDateTime('2020-11-01T6:00:30'), '2020 年 11 月 1 日 周日 6:00:30');
	assert.match(reminderDateTime(`${new Date().getFullYear()}-01-01 06:00`), /^1 月 1 日 周[一二三四五六日] 06:00$/);
});

test('写法不对的时间原样返回', () => {
	assert.equal(reminderDateTime('明天 6 点'), '明天 6 点');
});

test('重复的定时：每天、工作日、每周几', () => {
	assert.equal(reminderWhen('06:00', 'day'), '每天 06:00');
	assert.equal(reminderWhen('06:00', 'weekday'), '工作日 06:00');
	assert.equal(reminderWhen('06:00', 'week', [1, 3]), '每周一、三 06:00');
	assert.equal(reminderWhen('2020-11-02 06:00', undefined), '2020 年 11 月 2 日 周一 06:00');
});

test('多久以后：跳过是 0 的单位', () => {
	assert.equal(delayText(90), '1 分钟 30 秒后');
	assert.equal(delayText(3630), '1 小时 30 秒后');
	assert.equal(delayText(86_400 + 7200), '1 天 2 小时后');
});

test('持续多久：精确到分钟，不到 1 分钟是空的', () => {
	assert.equal(durationText(59_000), '');
	assert.equal(durationText(((2 * 24 + 3) * 60 + 5) * 60_000), '2 天 3 小时 5 分钟');
	assert.equal(durationText(60 * 60_000), '1 小时');
});

test('浏览器不认识的时区用时区名', () => {
	assert.equal(timeZoneName('Not/AZone'), 'Not/AZone');
});
