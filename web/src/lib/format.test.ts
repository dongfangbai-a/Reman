import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clockTime, compactDuration, dayTime, elapsedText, formatPercent, formatSize, formatTokens, fullTime, listTime, shortTime } from './format.ts';

// 都按本地时间造，和显示时一样。
const now = new Date(2026, 10, 7, 12, 0, 0).getTime();
const today = new Date(2026, 10, 7, 8, 5, 3).getTime();
const thisYear = new Date(2026, 10, 2, 8, 5, 3).getTime();
const lastYear = new Date(2025, 10, 2, 8, 5, 3).getTime();

test('时间线上的时间：今天只有时分秒，今年的加月-日，更早的带年份', () => {
	assert.equal(shortTime(today, now), '08:05:03');
	assert.equal(shortTime(thisYear, now), '11-02 08:05:03');
	assert.equal(shortTime(lastYear, now), '2025-11-02 08:05:03');
	assert.equal(clockTime(lastYear), '08:05:03');
	assert.equal(fullTime(thisYear), '2026-11-02 08:05:03');
});

test('百分比：整数不带小数，有小数时保留两位', () => {
	assert.equal(formatPercent(0.75), '75%');
	assert.equal(formatPercent(0), '0%');
	assert.equal(formatPercent(1), '100%');
	assert.equal(formatPercent(0.868874), '86.89%');
	assert.equal(formatPercent(2 / 3), '66.67%');
	assert.equal(formatPercent(0.505), '50.50%');
});

test('对话列表的时间：今天时:分，其他只有日期，月日不补零', () => {
	assert.equal(listTime(today, now), '08:05');
	assert.equal(listTime(thisYear, now), '11-2');
	assert.equal(listTime(lastYear, now), '2025-11-2');
});

test('「11 月 2 日 08:05」，不是今年的带年份', () => {
	assert.equal(dayTime(thisYear, now), '11 月 2 日 08:05');
	assert.equal(dayTime(lastYear, now), '2025 年 11 月 2 日 08:05');
});

test('token 数：不到 1000 原样，再大写成 k、M，整数不带小数', () => {
	assert.equal(formatTokens(999), '999');
	assert.equal(formatTokens(2000), '2k');
	assert.equal(formatTokens(41_234), '41.2k');
	assert.equal(formatTokens(1_234_567), '1.2M');
	// 进位的边上：取整后够了就用大一级的单位。
	assert.equal(formatTokens(999_949), '999.9k');
	assert.equal(formatTokens(999_999), '1M');
});

test('文件大小：B、KB、MB', () => {
	assert.equal(formatSize(500), '500 B');
	assert.equal(formatSize(1536), '1.5 KB');
	assert.equal(formatSize(3 * 1024 * 1024), '3.0 MB');
	assert.equal(formatSize(1024 * 1024 - 1), '1.0 MB');
});

test('运行用时：秒、分秒、小时分，整的不带零头', () => {
	assert.equal(elapsedText(500), '不到 1 秒');
	assert.equal(elapsedText(42_000), '42 秒');
	assert.equal(elapsedText(192_000), '3 分 12 秒');
	assert.equal(elapsedText(180_000), '3 分');
	assert.equal(elapsedText(3_900_000), '1 小时 5 分');
	assert.equal(elapsedText(3_600_000), '1 小时');
});

test('后台任务的耗时：4s、1m3s、2h4m5s，负数当 0', () => {
	assert.equal(compactDuration(400), '0s');
	assert.equal(compactDuration(4000), '4s');
	assert.equal(compactDuration(63_000), '1m3s');
	assert.equal(compactDuration(3_600_000), '1h0m0s');
	assert.equal(compactDuration(7_445_000), '2h4m5s');
	assert.equal(compactDuration(-5), '0s');
});
