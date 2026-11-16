// ProgramBench 每场的用量、最大上下文和压缩次数。
//
//   node eval/programbench/usage.mjs            # 所有跑过的场次
//
// 数据来源：evidence/programbench/<时间>-<agent>-<题>/ 下的 run.json（用时、token 三段）和 agent 自己的记录：
//   cc     cc-transcript.jsonl（Claude Code 的会话记录，每条 assistant 带 usage）
//   dsh    events.jsonl（还没接）
//   reman  runtime.sqlite（还没接）
// cc 和 dsh 不写「压缩事件」，所以按「上下文比上一条少 40% 以上、且少 5 万 token 以上」推断。
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const RUNS = resolve(import.meta.dirname, '..', 'evidence', 'programbench');
const DROP_RATIO = 0.4;
const DROP_MIN = 50_000;

/** 找「上下文突然变短」的位置。series 是每条请求的上下文长度。 */
function drops(series) {
	const found = [];
	for (let i = 1; i < series.length; i += 1) {
		const before = series[i - 1];
		const after = series[i];
		if (before - after > DROP_MIN && (before - after) / before > DROP_RATIO) found.push({ before, after });
	}
	return found;
}

/** Claude Code 的会话记录：按 message.id 去重（流式会把同一条重复写），取 input + cache 读 + cache 写。 */
function ccSeries(file) {
	const series = [];
	const position = new Map();
	for (const line of readFileSync(file, 'utf8').split('\n')) {
		const text = line.trim();
		if (!text.startsWith('{')) continue;
		let event;
		try {
			event = JSON.parse(text);
		} catch {
			continue;
		}
		if (event.type !== 'assistant') continue;
		const usage = event.message?.usage;
		const id = event.message?.id;
		if (!usage || !id) continue;
		const length = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
		const at = position.get(id);
		if (at === undefined) {
			position.set(id, series.length);
			series.push(length);
		} else if (length > series[at]) {
			series[at] = length;
		}
	}
	return series;
}

/** dsh 的 NDJSON 事件：只看 step_end 里的 usage。 */
function dshSeries(file) {
	const series = [];
	for (const line of readFileSync(file, 'utf8').split('\n')) {
		const text = line.trim();
		if (!text.startsWith('{')) continue;
		let event;
		try {
			event = JSON.parse(text);
		} catch {
			continue;
		}
		if (event.type !== 'status' || event.phase !== 'step_end' || !event.usage) continue;
		const usage = event.usage;
		series.push((usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0));
	}
	return series;
}

/** reman：用 model_requests 的 input_tokens 序列算断崖（跟 cc / dsh 同一口径）。
 * 不要数 timeline_items 里 kind='summary' 的条目——那是运行时把旧内容滚动摘要的记忆条目，
 * 跟窗口压缩无关（数它会得出 37 这种虚高值）。kind='optimization' 的请求可与断崖互证。 */
function remanSeries(dir) {
	for (const rel of [['reman-data', 'runtime.sqlite'], ['artifacts', 'logs', 'artifacts', 'reman-data', 'runtime.sqlite']]) {
		const db = join(dir, ...rel);
		if (!existsSync(db)) continue;
		try {
			const base = new DatabaseSync(db, { readOnly: true });
			const rows = base
				.prepare("SELECT input_tokens AS n FROM model_requests WHERE kind = 'response' ORDER BY started_at")
				.all();
			base.close();
			return rows.map(row => Number(row.n));
		} catch {
			return null;
		}
	}
	return null;
}

const rows = [];
for (const name of readdirSync(RUNS).sort()) {
	const dir = join(RUNS, name);
	const metaPath = join(dir, 'run.json');
	if (!existsSync(metaPath)) continue;
	const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
	const usage = meta.usage ?? {};
	let series = [];
	// cc：优先用会话记录；没有就用 agent.log（也是 stream-json，assistant 消息里带 usage）。
	if (meta.agent === 'cc') {
		const file = ['cc-transcript.jsonl', 'agent.log'].map(name => join(dir, name)).find(name => existsSync(name));
		if (file) series = ccSeries(file);
	}
	if (meta.agent === 'dsh') {
		const file = ['events.jsonl', 'agent.log'].map(n => join(dir, n)).find(n => existsSync(n));
		if (file) series = dshSeries(file);
	}
	if (meta.agent === 'reman') series = remanSeries(dir) ?? [];
	const exact = null;
	const found = series.length > 0 ? drops(series) : [];
	rows.push({
		name,
		agent: meta.agent,
		task: meta.task,
		seconds: meta.elapsed_seconds,
		input: usage.input,
		cache: usage.cacheRead,
		output: usage.output,
		peak: series.length > 0 ? Math.max(...series) : null,
		compactions: exact ?? (series.length > 0 ? found.length : null),
		note: exact !== null ? '精确' : series.length > 0 ? found.map(d => `${d.before}→${d.after}`).join(' ') : '没有可算的记录',
	});
}

if (rows.length === 0) {
	console.log('evidence/programbench 下还没有跑过的场次。');
} else {
	console.log(['运行', 'agent', '题', '用时(秒)', '命中', '未命中', '输出', '最大上下文', '压缩', '依据'].join('\t'));
	for (const row of rows) {
		console.log([row.name, row.agent, row.task, row.seconds ?? '—', row.cache ?? '—', row.input ?? '—',
			row.output ?? '—', row.peak ?? '—', row.compactions ?? '—', row.note].join('\t'));
	}
}
