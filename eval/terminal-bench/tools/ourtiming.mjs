// 从我们运行时留下的数据库里算一场的真实用时：只数模型请求的起止，不含装包、建成员、判分准备。
// 也是 report.mjs 取「运行时内部 span」的来源。
//
//   node eval/terminal-bench/tools/ourtiming.mjs eval/evidence/terminal-bench/reman-1113-2124/shadow-relay__p68oKZm
//   node eval/terminal-bench/tools/ourtiming.mjs eval/evidence/terminal-bench/reman-*/*      # 一场一行
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const CANDIDATES = [
	'artifacts/logs/artifacts/reman-data/runtime.sqlite',
	'artifacts/reman-data/runtime.sqlite',
	'reman-data/runtime.sqlite',
];

/** 秒数写成人看的样子：2 小时 9 分 / 17 分 28 秒 / 38 秒。 */
export function formatDuration(seconds) {
	const total = Math.max(0, Math.round(seconds));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const secs = total % 60;
	if (hours) return `${hours} 小时 ${minutes} 分`;
	if (minutes) return `${minutes} 分 ${secs} 秒`;
	return `${secs} 秒`;
}

/** 一场试次的运行时内部统计：span（秒）与模型请求数；找不到数据库返回 null。 */
export function trialStats(dir) {
	const dbPath = CANDIDATES.map(path => join(dir, path)).find(path => existsSync(path));
	if (!dbPath) return null;
	const db = new DatabaseSync(dbPath, { readOnly: true });
	try {
		const row = db.prepare('select count(*) as n, min(started_at) as a, max(ended_at) as b from model_requests').get();
		if (!row || !row.n || row.a == null || row.b == null) return null;
		return { span: (row.b - row.a) / 1000, requests: row.n };
	} finally {
		db.close();
	}
}

const args = process.argv.slice(2);
for (const dir of args) {
	const stats = trialStats(dir);
	console.log(stats ? `${dir}\t${formatDuration(stats.span)}\t${stats.requests} 次请求` : `${dir}\t没有运行时数据库`);
}
