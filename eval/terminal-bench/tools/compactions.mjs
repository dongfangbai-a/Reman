// 数每家每场「上下文压缩了几次」。
//
//   node eval/terminal-bench/tools/compactions.mjs            # 所有试次
//   node eval/terminal-bench/tools/compactions.mjs dsh-...    # 只看一场
//
// 三家的证据来源不同：
//   reman    从 runtime.sqlite 的 model_requests 里取 input_tokens 序列（跟 cc / dsh 同一口径）
//   cc       从 claude-code.txt 的 stream-json 里取每条 assistant 的 usage（input + cache_read）
//   dsh      从 events.jsonl 的 step_end 里取 usage（inputTokens + cacheReadTokens + cacheWriteTokens）
// 三家都按「上下文长度突然大幅下降」判：比上一条少 40% 以上、且少掉 5 万 token 以上，算一次压缩。
// 注意：不要数 timeline_items 里 kind='summary' 的条目——那是把旧内容滚动摘要的记忆条目，
// 跟窗口压缩无关（2026-11-13 在 ProgramBench 踩过，虚高到 37 次）。
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const JOBS = resolve(import.meta.dirname, '..', '..', 'evidence', 'terminal-bench');
const DROP_RATIO = 0.4;
const DROP_MIN = 50_000;

/** 找「突然变短」的位置。series 是每条请求的上下文长度。 */
function drops(series) {
	const found = [];
	let peak = 0;
	for (let i = 1; i < series.length; i += 1) {
		const before = series[i - 1];
		const after = series[i];
		peak = Math.max(peak, before);
		if (before - after > DROP_MIN && (before - after) / before > DROP_RATIO) {
			found.push({ at: i, before, after });
		}
	}
	return { found, peak: Math.max(peak, ...series, 0) };
}

function ccSeries(file) {
	const series = [];
	const byMessage = new Map();
	for (const line of readFileSync(file, 'utf8').split('\n')) {
		const text = line.trim();
		if (!text.startsWith('{') || !text.includes('"usage"')) continue;
		let event;
		try {
			event = JSON.parse(text);
		} catch {
			continue;
		}
		// 只认 assistant：末条 result 事件带的是整场累计，不是单次请求的上下文。
		if (event.type !== 'assistant') continue;
		const usage = event.message?.usage;
		const id = event.message?.id;
		if (!usage || !id) continue;
		const length = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
		// 流式输出会把同一条 message 重复发好几次，按 id 去重、取最大值。
		const seen = byMessage.get(id);
		if (seen === undefined) {
			byMessage.set(id, length);
			series.push(length);
		} else if (length > seen) {
			byMessage.set(id, length);
			series[series.indexOf(seen)] = length;
		}
	}
	return series;
}

function dshSeries(file) {
	const series = [];
	for (const line of readFileSync(file, 'utf8').split('\n')) {
		const text = line.trim();
		if (!text.startsWith('{') || !text.includes('step_end')) continue;
		let event;
		try {
			event = JSON.parse(text);
		} catch {
			continue;
		}
		if (event.type !== 'status' || event.phase !== 'step_end' || !event.usage) continue;
		const usage = event.usage;
		const length = (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
		series.push(length);
	}
	return series;
}

/** reman：跟 cc / dsh 同口径——取每条回复请求的输入 token（model_requests.input_tokens）算断崖。
 * 不要数 kind='summary'，那是滚动摘要的记忆条目，跟窗口压缩无关。 */
function remanSeries(dbPath) {
	if (!existsSync(dbPath)) return [];
	try {
		const db = new DatabaseSync(dbPath, { readOnly: true });
		const rows = db.prepare("SELECT input_tokens AS n FROM model_requests WHERE kind = 'response' ORDER BY started_at").all();
		db.close();
		return rows.map(row => Number(row.n));
	} catch {
		return [];
	}
}

/** reman 试次里运行时数据库的位置（Harbor 会把数据目录搬出来）。 */
function findDb(dir) {
	for (const candidate of [
		join(dir, 'artifacts', 'logs', 'artifacts', 'reman-data', 'runtime.sqlite'),
		join(dir, 'artifacts', 'reman-data', 'runtime.sqlite'),
		join(dir, 'reman-data', 'runtime.sqlite'),
	]) {
		if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
	}
	return null;
}

const jobFilter = process.argv[2];
const rows = [];
for (const job of readdirSync(JOBS).sort()) {
	if (jobFilter && !job.startsWith(jobFilter)) continue;
	const jobDir = join(JOBS, job);
	for (const trial of readdirSync(jobDir)) {
		const dir = join(jobDir, trial);
		if (!existsSync(join(dir, 'result.json'))) continue;
		const agent = job.split('-')[0];
		const task = trial.split('__')[0];
		let series = [];
		if (agent === 'reman') {
			const db = findDb(dir);
			series = db ? remanSeries(db) : [];
		} else if (agent === 'cc' && existsSync(join(dir, 'agent', 'claude-code.txt'))) {
			series = ccSeries(join(dir, 'agent', 'claude-code.txt'));
		} else if (agent === 'dsh') {
			const f = ['events.jsonl', 'dsh.log'].map(n => join(dir, 'agent', n)).find(n => existsSync(n));
			if (f) series = dshSeries(f);
		}
		if (series.length === 0) {
			rows.push({ job, task, agent, requests: 0, peak: null, compactions: null, note: '没有可算的用量序列' });
			continue;
		}
		const { found, peak } = drops(series);
		rows.push({ job, task, agent, requests: series.length, peak, compactions: found.length, note: found.map(d => `${d.before}→${d.after}`).join(' ') });
	}
}

console.log('job\t题\tagent\t请求数\t最大上下文\t压缩次数\t依据');
for (const row of rows) {
	console.log([row.job, row.task, row.agent, row.requests, row.peak ?? '—', row.compactions ?? '—', row.note].join('\t'));
}
