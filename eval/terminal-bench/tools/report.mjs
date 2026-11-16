// 看三家（reman / Claude Code / dsh）在同一道题上的结果：reward、用时、三段费用、缓存命中率。
//
//   node eval/terminal-bench/tools/report.mjs
//
// 只扫 eval/evidence/terminal-bench 下面的试次目录，按 agent 名字分列。
// 口径见 eval/terminal-bench/RESULTS.md：用时要 Harbor 记的 agent 执行区间，费用按 eval/pricing.json 的价格算。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { formatDuration, trialStats } from './ourtiming.mjs';
import { costOf, pricingConfig } from '../../pricing.mjs';

const JOBS = resolve(import.meta.dirname, '..', '..', 'evidence', 'terminal-bench');
/** agent 的显示名：job 目录名前缀。 */
const LABELS = { reman: 'reman', cc: 'cc', dsh: 'dsh' };

function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, 'utf8'));
	} catch {
		return null;
	}
}

/** 试次目录：job 目录下带 result.json 的那一层。 */
function trials(jobDir) {
	const found = [];
	for (const name of readdirSync(jobDir)) {
		const dir = join(jobDir, name);
		if (!statSync(dir).isDirectory()) continue;
		const result = readJson(join(dir, 'result.json'));
		if (result) found.push({ name, dir, result });
	}
	return found;
}

/** job 目录名开头的 agent：reman-1112-0824 / cc-… / dsh-… */
function agentOf(jobName, result) {
	const prefix = jobName.split('-')[0];
	if (LABELS[prefix]) return LABELS[prefix];
	const name = (result.agent_info?.name ?? '').toLowerCase();
	if (name.includes('claude')) return 'cc';
	if (name.includes('harness')) return 'dsh';
	return 'reman';
}

/** 用时：Harbor 记的 agent 执行区间（started_at → finished_at）。 */
function executionSeconds(result) {
	const start = result.agent_execution?.started_at;
	const end = result.agent_execution?.finished_at;
	if (!start || !end) return null;
	return (Date.parse(end) - Date.parse(start)) / 1000;
}

/** 三段用量：命中（缓存读）、未命中（输入减缓存）、输出。 */
/** 三段用量：命中（缓存读）、未命中（输入减缓存）、输出。 */
function usageOf(result) {
	const context = result.agent_result ?? {};
	const input = context.n_input_tokens ?? 0;
	const hit = Math.min(context.n_cache_tokens ?? 0, input);
	return { hit, miss: input - hit, output: context.n_output_tokens ?? 0 };
}

function money(value) {
	return value === null || value === undefined ? '—' : `¥${value.toFixed(2)}`;
}

/** 命中率：最多两位小数，整数就不带小数点（98.21%、100%、98.4%）。 */
function percent(value) {
	return `${Number(value.toFixed(2))}%`;
}

function tokensText(value) {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
	if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
	return String(value);
}

const rows = [];
for (const jobName of readdirSync(JOBS)) {
	const jobDir = join(JOBS, jobName);
	if (!statSync(jobDir).isDirectory()) continue;
	for (const trial of trials(jobDir)) {
		const agent = agentOf(jobName, trial.result);
		const model = trial.result.agent_info?.model ?? 'deepseek-flash';
		const usage = usageOf(trial.result);
		const cost = costOf(model.includes('/') ? model.split('/').at(-1) : model, {
			input: usage.hit + usage.miss, cached: usage.hit, output: usage.output,
		});
		rows.push({
			task: (trial.result.task_name ?? trial.name).replace('terminal-bench/', ''),
			agent,
			reward: trial.result.verifier_result?.rewards?.reward ?? null,
			seconds: executionSeconds(trial.result),
			usage,
			cost,
			trial,
		});
	}
}

if (rows.length === 0) {
	console.log('eval/evidence/terminal-bench 下还没有试次。跑一道：./eval/terminal-bench/compare.sh -a reman -i <题>');
	process.exit(0);
}

const { currency } = pricingConfig();
rows.sort((a, b) => a.task.localeCompare(b.task) || a.agent.localeCompare(b.agent));

let currentTask = '';
console.log('题 / agent            reward   用时     命中      未命中    输出     花费   命中率');
for (const row of rows) {
	if (row.task !== currentTask) {
		currentTask = row.task;
		console.log(`\n${currentTask}`);
	}
	const total = row.usage.hit + row.usage.miss;
	const hitRate = total === 0 ? '—' : percent((row.usage.hit / total) * 100);
	console.log([
		`  ${row.agent.padEnd(6)}`,
		`${row.reward === null ? '—' : row.reward.toFixed(2)}`.padStart(7),
		`${formatDuration(row.seconds)}`.padStart(9),
		`${tokensText(row.usage.hit)}`.padStart(8),
		`${tokensText(row.usage.miss)}`.padStart(9),
		`${tokensText(row.usage.output)}`.padStart(7),
		`${money(row.cost?.total)}`.padStart(7),
		`${hitRate}`.padStart(6),
	].join('  '));
}

// 按 agent 汇总：把几道题累加起来看整体倾向。单题只跑一次时随机性很大，累加能抵消一部分（见 RESULTS.md「局限」）。
console.log('\n按 agent 汇总（同一批题累加）');
const byAgent = new Map();
for (const row of rows) {
	const entry = byAgent.get(row.agent) ?? { agent: row.agent, trials: 0, passed: 0, seconds: 0, hit: 0, miss: 0, output: 0, cost: 0 };
	entry.trials += 1;
	entry.passed += row.reward === null ? 0 : row.reward >= 0.999 ? 1 : 0;
	entry.seconds += row.seconds ?? 0;
	entry.hit += row.usage.hit;
	entry.miss += row.usage.miss;
	entry.output += row.usage.output;
	entry.cost += row.cost?.total ?? 0;
	byAgent.set(row.agent, entry);
}
console.log('agent   题数  通过  总用时      命中      未命中    输出     总花费   命中率');
for (const entry of [...byAgent.values()].sort((a, b) => a.agent.localeCompare(b.agent))) {
	const total = entry.hit + entry.miss;
	console.log([
		`  ${entry.agent.padEnd(6)}`,
		String(entry.trials).padStart(3),
		String(entry.passed).padStart(5),
		`${formatDuration(entry.seconds)}`.padStart(9),
		`${tokensText(entry.hit)}`.padStart(8),
		`${tokensText(entry.miss)}`.padStart(9),
		`${tokensText(entry.output)}`.padStart(7),
		`${money(entry.cost)}`.padStart(7),
		`${total === 0 ? '—' : percent((entry.hit / total) * 100)}`.padStart(7),
	].join('  '));
}

console.log(`\n价格：${currency}，见 eval/pricing.json（命中 / 未命中 / 输出 三段）。`);
// reman 额外给一条内部用时：从运行时的库算，和 Harbor 的区间互相核对（不含装包、建成员）。
for (const row of rows.filter(item => item.agent === 'reman')) {
	const stats = trialStats(row.trial.dir);
	if (stats) console.log(`  reman ${row.task}：运行时内部 span ${formatDuration(stats.span)}，${stats.requests} 次请求`);
}
