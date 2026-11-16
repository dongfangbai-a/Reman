/**
 * 核对 BENCHMARKS.md 里 agent 汇总表的「合计用量」：不读 results.json 收好的 token，
 * 直接从证据文件重算——TB 用每个试次 result.json 的 agent_result，PB 用运行目录 run.json 的 usage。
 * 复测哪些场次按 results.json 的 retest 标记认，token 一律从证据里现读。
 *
 *   node eval/terminal-bench/tools/verify-usage.mjs
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = 'eval/evidence';
// 证据不进仓库，按批次放在 Release 里（见 eval/EVIDENCE.md）：没下载就跳过，不算失败。
if (!existsSync(root)) {
	console.log('没有 eval/evidence：原始证据还没下载，见 eval/EVIDENCE.md。跳过。');
	process.exit(0);
}
const rows = JSON.parse(readFileSync('eval/results.json', 'utf8')).rows;

/** 证据路径里的运行目录名：TB 指到试次的 result.json，PB 指到运行目录本身。 */
function runOf(path, bench) {
	const parts = path.replace(/\\/g, '/').split('/');
	return bench === 'Terminal-Bench' ? parts.at(-3) : parts.at(-1);
}

const retest = new Map(rows.map(row => [runOf(row.evidence, row.bench), row.retest]));
const totals = {};
const bump = (agent, key, value) => {
	const acc = (totals[agent] ??= { hit: 0, miss: 0, out: 0, runs: 0, retests: 0 });
	if (key === 'retest') {
		acc.retests += 1;
		return;
	}
	acc[key] += value;
};

// Terminal-Bench：每个试次目录下的 result.json
for (const run of readdirSync(join(root, 'terminal-bench'))) {
	const agent = run.split('-')[0];
	if (retest.get(run)) {
		bump(agent, 'retest', 0);
		continue;
	}
	const runPath = join(root, 'terminal-bench', run);
	let counted = false;
	for (const trial of readdirSync(runPath)) {
		const file = join(runPath, trial, 'result.json');
		if (!existsSync(file)) continue;
		const usage = JSON.parse(readFileSync(file, 'utf8')).agent_result;
		if (!usage) continue;
		const hit = Math.min(usage.n_cache_tokens ?? 0, usage.n_input_tokens ?? 0);
		bump(agent, 'hit', hit);
		bump(agent, 'miss', (usage.n_input_tokens ?? 0) - hit);
		bump(agent, 'out', usage.n_output_tokens ?? 0);
		counted = true;
	}
	if (counted) bump(agent, 'runs', 1);
}

// ProgramBench：每个运行目录下的 run.json
for (const run of readdirSync(join(root, 'programbench'))) {
	const file = join(root, 'programbench', run, 'run.json');
	if (!existsSync(file)) continue;
	const meta = JSON.parse(readFileSync(file, 'utf8'));
	if (retest.get(run)) {
		bump(meta.agent, 'retest', 0);
		continue;
	}
	const usage = meta.usage ?? {};
	bump(meta.agent, 'hit', usage.cacheRead ?? 0);
	bump(meta.agent, 'miss', usage.input ?? 0);
	bump(meta.agent, 'out', usage.output ?? 0);
	bump(meta.agent, 'runs', 1);
}

/** 和 BENCHMARKS.md 一样的写法：百万以上两位小数带 M，其余按千取整带 k。 */
function tokens(n) {
	return n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : `${Math.round(n / 1e3)}k`;
}

const lines = readFileSync('BENCHMARKS.md', 'utf8').split('\n');
const summary = lines.filter(line => /^\| (reman|cc|dsh) \|/.test(line));
let problems = 0;
for (const line of summary) {
	const cells = line.split('|').slice(1, -1).map(cell => cell.trim());
	const [agent, , , , , , , , usage] = cells;
	const total = totals[agent];
	if (!total) {
		console.log(`✗ 汇总合计用量 ${agent}: 文档 ${usage} / 证据里没有这个 agent 的试次`);
		problems += 1;
		continue;
	}
	const expected = `${tokens(total.hit)} / ${tokens(total.miss)} / ${tokens(total.out)}`;
	if (usage !== expected) {
		console.log(`✗ 汇总合计用量 ${agent}: 文档 ${usage} / 证据 ${expected}（首跑 ${total.runs} 场）`);
		problems += 1;
	}
}

console.log(`\n汇总 ${summary.length} 行；问题 ${problems} 处`);
if (problems > 0) process.exitCode = 1;
