// 把两个基准的每一场结果收进三份 JSON：根目录一份（两家合起来），两个基准目录各一份。
//   node eval/collect-results.mjs
//
// TB：evidence/terminal-bench/<批次>/<单场>/result.json —— reward、执行区间（agent_execution）、三段用量。
// PB：evidence/programbench/<单场>/<题>/<题>.eval.json —— test_results 逐条状态（判分）；
//     run.json 的 usage —— 三段用量；elapsed_seconds —— 用时（run.py 只计 agent 干活那一段）。
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { costOf } from './pricing.mjs';

// 证据不进仓库，按批次放在 Release 里（见 eval/EVIDENCE.md）：没下载就跳过，不算失败。
if (!existsSync('eval/evidence')) {
	console.log('没有 eval/evidence：原始证据还没下载，见 eval/EVIDENCE.md。跳过。');
	process.exit(0);
}

const rows = [];

// 额外加测的场次：只测了 reman 一家，不并入汇总（汇总只统计三家都跑过的九道题）。
const EXTRA_ONLY = new Set(['wal-recovery-ordering']);

// ---------------- Terminal-Bench ----------------
const TB = 'eval/evidence/terminal-bench';
for (const job of readdirSync(TB)) {
	const agent = job.split('-')[0];
	for (const trial of readdirSync(join(TB, job))) {
		const dir = join(TB, job, trial);
		if (!statSync(dir).isDirectory()) continue;
		const f = join(dir, 'result.json');
		if (!existsSync(f)) continue;
		const r = JSON.parse(readFileSync(f, 'utf8'));
		if (!r.verifier_result) continue;
		const a = r.agent_result ?? {};
		const input = a.n_input_tokens ?? 0;
		const hit = Math.min(a.n_cache_tokens ?? 0, input);
		rows.push({
			bench: 'Terminal-Bench',
			task: trial.split('__')[0],
			agent,
			reward: r.verifier_result.rewards.reward,
			seconds: (Date.parse(r.agent_execution.finished_at) - Date.parse(r.agent_execution.started_at)) / 1000,
			hit,
			miss: input - hit,
			output: a.n_output_tokens ?? 0,
			time_source: 'result.json 的 agent_execution',
			evidence: join(dir, 'result.json'),
		});
	}
}

// ---------------- ProgramBench（作废那批在 eval/.local/stash/，这里没有就跑空） ----------------
const PB = 'eval/evidence/programbench';
for (const run of existsSync(PB) ? readdirSync(PB).sort() : []) {
	const dir = join(PB, run);
	const runFile = join(dir, 'run.json');
	if (!existsSync(runFile)) continue;
	const r = JSON.parse(readFileSync(runFile, 'utf8'));
	const taskDir = readdirSync(dir).find(x => x.includes('__') && statSync(join(dir, x)).isDirectory());
	if (!taskDir) continue;
	const evalFile = join(dir, taskDir, `${taskDir}.eval.json`);
	if (!existsSync(evalFile)) continue;
	const ev = JSON.parse(readFileSync(evalFile, 'utf8'));
	const results = ev.test_results ?? [];
	const passed = results.filter(x => x.status === 'passed').length;
	const usage = r.usage ?? {};

	// PB 这边 run.py 只计 agent 干活的那一段，直接用 elapsed_seconds（与结果文档一致）。
	const seconds = r.elapsed_seconds ?? null;
	const source = 'run.json 的 elapsed_seconds';
	if (seconds === null) continue;

	rows.push({
		bench: 'ProgramBench',
		task: taskDir.split('__')[1]?.split('.').slice(0, -1).join('.') ?? taskDir,
		agent: r.agent,
		reward: results.length > 0 && passed === results.length ? 1 : 0,
		tests_passed: passed,
		tests_total: results.length,
		seconds,
		hit: usage.cacheRead ?? 0,
		miss: usage.input ?? 0,
		output: usage.output ?? 0,
		time_source: source,
		evidence: dir,
	});
}

// 同一题同一家跑了不止一次时，最早那场算首跑，其余标成复测（汇总只用首跑）。
const firstOf = new Map();
for (const row of [...rows].sort((a, b) => String(a.evidence).localeCompare(String(b.evidence)))) {
	const key = `${row.bench}|${row.task}|${row.agent}`;
	const seen = firstOf.get(key);
	if (!seen) firstOf.set(key, row);
	else row.retest = true;
}

for (const row of rows) {
	row.extra = EXTRA_ONLY.has(row.task);
	row.retest = row.retest === true;
	row.cost = Number((costOf('deepseek-flash', { input: row.hit + row.miss, cached: row.hit, output: row.output })?.total ?? 0).toFixed(4));
	row.hitRate = Number(((row.hit / (row.hit + row.miss)) * 100).toFixed(2));
	row.minutes = Number((row.seconds / 60).toFixed(1));
}

const order = { reman: 0, cc: 1, dsh: 2 };
rows.sort((a, b) => a.bench.localeCompare(b.bench) || a.task.localeCompare(b.task) || order[a.agent] - order[b.agent]);

// 按基准切三份：根目录两家合一份，两个基准目录各一份，同一次计算写出来，数字不会漂。
const totalsOf = (list) => {
	const out = {};
	for (const r of list) {
		const t0 = out[r.agent] ??= { runs: 0, passed: 0, tests_passed: 0, tests_total: 0, seconds: 0, hit: 0, miss: 0, output: 0, cost: 0 };
		t0.runs += 1;
		t0.passed += r.reward === 1 ? 1 : 0;
		t0.tests_passed += r.tests_passed ?? 0;
		t0.tests_total += r.tests_total ?? 0;
		t0.seconds = Number((t0.seconds + r.seconds).toFixed(1));
		t0.hit += r.hit;
		t0.miss += r.miss;
		t0.output += r.output;
		t0.cost = Number((t0.cost + r.cost).toFixed(4));
	}
	return out;
};

const generatedAt = new Date().toISOString();
const tbRows = rows.filter(r => r.bench === 'Terminal-Bench');
const pbRows = rows.filter(r => r.bench === 'ProgramBench');
// 汇总只算首跑（复测在 rows 里带 retest 标记，单列）
const write = (file, list) => writeFileSync(file, JSON.stringify({ generatedAt, rows: list, totals: totalsOf(list.filter(r => !r.retest)) }, null, '\t') + '\n', 'utf8');
write('eval/results.json', rows);
write('eval/terminal-bench/results.json', tbRows);
write('eval/programbench/results.json', pbRows);
console.log(`写了 eval/results.json（${rows.length} 行）、eval/terminal-bench/results.json（${tbRows.length} 行）、eval/programbench/results.json（${pbRows.length} 行）`);
