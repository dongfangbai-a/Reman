// 核对 BENCHMARKS.md 的每个数字是否和 eval/results.json 一致。
// results.json 由 collect-results.mjs 从原始证据（eval/evidence/）生成，分三份：根目录两家合一份、两个基准目录各一份。
//   node eval/collect-results.mjs && node eval/terminal-bench/tools/verify-benchmarks.mjs
import { readFileSync } from 'node:fs';

const { rows } = JSON.parse(readFileSync('eval/results.json', 'utf8'));
const lines = readFileSync('BENCHMARKS.md', 'utf8').split('\n');

const parseTime = text => {
	const h = text.match(/(\d+(?:\.\d+)?)\s*小时/);
	const m = text.match(/(\d+(?:\.\d+)?)\s*分/);
	const s = text.match(/(\d+(?:\.\d+)?)\s*秒/);
	return Number(h?.[1] ?? 0) * 60 + Number(m?.[1] ?? 0) + Number(s?.[1] ?? 0) / 60;
};
const parseTok = t => {
	const v = Number(t.replace(/[^\d.]/g, ''));
	if (t.includes('M')) return v * 1e6;
	if (t.includes('k')) return v * 1e3;
	return v;
};
const num = t => Number(t.replace(/[^\d.]/g, ''));
const near = (a, b, tol) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;

const detailRows = lines.filter(l => l.startsWith('| Terminal-Bench |') || l.startsWith('| ProgramBench |'));
let problems = 0;
const used = new Set();

for (const line of detailRows) {
	const c = line.split('|').slice(1, -1).map(s => s.trim());
	const [bench, rawTask, agent, result, time, tokens, cost, rate] = c;
	const task = rawTask.replace(/`/g, '');
	const pool = rows.filter(r => r.bench === bench && r.task === task && r.agent === agent);
	const docMinutes = parseTime(time);
	// 同一题同一家可能有多行（复测），按用时挑最接近的一条
	let found = null;
	let best = Infinity;
	for (const r of pool) {
		const key = `${bench}|${task}|${agent}|${r.evidence}`;
		if (used.has(key)) continue;
		const diff = Math.abs(r.seconds / 60 - docMinutes);
		if (diff < best) { best = diff; found = { r, key }; }
	}
	if (!found) { console.log(`✗ 找不到 ${bench} ${task} ${agent}`); problems += 1; continue; }
	used.add(found.key);
	const r = found.r;

	if (!near(docMinutes, r.seconds / 60, 1.0)) {
		console.log(`✗ 用时 ${task} ${agent}: 文档 ${time} / 数据 ${(r.seconds / 60).toFixed(1)} 分钟`); problems += 1;
	}
	const docTok = tokens.split('/').map(s => parseTok(s.trim()));
	const realTok = [r.hit, r.miss, r.output];
	for (let i = 0; i < 3; i += 1) {
		if (!near(docTok[i], realTok[i], Math.max(realTok[i] * 0.02, 2000))) {
			console.log(`✗ token 第 ${i + 1} 段 ${task} ${agent}: 文档 ${tokens} / 数据 ${realTok.join(' / ')}`); problems += 1; break;
		}
	}
	if (!near(num(cost), r.cost, 0.02)) { console.log(`✗ 花费 ${task} ${agent}: 文档 ${cost} / 数据 ¥${r.cost.toFixed(2)}`); problems += 1; }
	if (!near(num(rate), r.hitRate, 0.05)) { console.log(`✗ 命中率 ${task} ${agent}: 文档 ${rate} / 数据 ${r.hitRate.toFixed(2)}%`); problems += 1; }
	if (bench === 'Terminal-Bench') {
		if (num(result) !== r.reward) { console.log(`✗ reward ${task} ${agent}: 文档 ${result} / 数据 ${r.reward}`); problems += 1; }
	} else {
		const got = (r.tests_passed / r.tests_total) * 100;
		if (!near(num(result), got, 0.02)) {
			console.log(`✗ 通过率 ${task} ${agent}: 文档 ${result} / 数据 ${got.toFixed(2)}%（${r.tests_passed}/${r.tests_total}）`); problems += 1;
		}
	}
}

/** 和 BENCHMARKS.md 里一样的写法：百万以上两位小数带 M，其余按千取整带 k。 */
function tokens(n) {
	return n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : `${Math.round(n / 1e3)}k`;
}

// agent 汇总表：TB 通过 / PB 通过 / TB 用时 / TB 花费 / PB 用时 / PB 花费 / 合计用时 / 合计用量 / 合计花费
const tbBase = rows.filter(r => r.bench === 'Terminal-Bench' && !r.retest);
const pbBase = rows.filter(r => r.bench === 'ProgramBench' && !r.retest);
const agentRows = lines.filter(l => /^\| (reman|cc|dsh) \|/.test(l));
for (const line of agentRows) {
	const c = line.split('|').slice(1, -1).map(s => s.trim());
	const [agent, tbPass, pbPass, tbTime, tbCost, pbTime, pbCost, totalTime, totalUsage, totalCost] = c;
	const t = tbBase.filter(r => r.agent === agent);
	const p = pbBase.filter(r => r.agent === agent);
	const pass = t.filter(r => r.reward === 1).length;
	const m = tbPass.replace(/\*/g, '').match(/(\d+)\/(\d+)/);
	if (!m || Number(m[1]) !== pass || Number(m[2]) !== t.length) {
		console.log(`✗ 汇总 TB 通过 ${agent}: 文档 ${tbPass} / 数据 ${pass}/${t.length}`); problems += 1;
	}
	const resolved = new Set(p.filter(r => r.reward === 1).map(r => r.task)).size;
	const pTask = new Set(p.map(r => r.task)).size;
	const pm = pbPass.match(/(\d+)\/(\d+)/);
	if (!pm || Number(pm[1]) !== resolved || Number(pm[2]) !== pTask) {
		console.log(`✗ 汇总 PB 通过 ${agent}: 文档 ${pbPass} / 数据 ${resolved}/${pTask}`); problems += 1;
	}
	const tbSeconds = t.reduce((n, r) => n + r.seconds, 0);
	const pbSeconds = p.reduce((n, r) => n + r.seconds, 0);
	const tbCostValue = t.reduce((n, r) => n + r.cost, 0);
	const pbCostValue = p.reduce((n, r) => n + r.cost, 0);
	if (!near(parseTime(tbTime), tbSeconds / 60, 1.0)) { console.log(`✗ 汇总 TB 用时 ${agent}: 文档 ${tbTime} / 数据 ${(tbSeconds / 60).toFixed(1)} 分钟`); problems += 1; }
	if (!near(num(tbCost), tbCostValue, 0.05)) { console.log(`✗ 汇总 TB 花费 ${agent}: 文档 ${tbCost} / 数据 ¥${tbCostValue.toFixed(2)}`); problems += 1; }
	if (!near(parseTime(pbTime), pbSeconds / 60, 1.0)) { console.log(`✗ 汇总 PB 用时 ${agent}: 文档 ${pbTime} / 数据 ${(pbSeconds / 60).toFixed(1)} 分钟`); problems += 1; }
	if (!near(num(pbCost), pbCostValue, 0.05)) { console.log(`✗ 汇总 PB 花费 ${agent}: 文档 ${pbCost} / 数据 ¥${pbCostValue.toFixed(2)}`); problems += 1; }
	if (!near(parseTime(totalTime), (tbSeconds + pbSeconds) / 60, 1.0)) {
		console.log(`✗ 汇总合计用时 ${agent}: 文档 ${totalTime} / 数据 ${((tbSeconds + pbSeconds) / 60).toFixed(1)} 分钟`); problems += 1;
	}
	const usageText = [t, p].flat().reduce((acc, r) => ({ hit: acc.hit + r.hit, miss: acc.miss + r.miss, out: acc.out + r.output }), { hit: 0, miss: 0, out: 0 });
	const expectedUsage = `${tokens(usageText.hit)} / ${tokens(usageText.miss)} / ${tokens(usageText.out)}`;
	if (totalUsage !== expectedUsage) {
		console.log(`✗ 汇总合计用量 ${agent}: 文档 ${totalUsage} / 数据 ${expectedUsage}`); problems += 1;
	}
	if (!near(num(totalCost), tbCostValue + pbCostValue, 0.05)) {
		console.log(`✗ 汇总合计花费 ${agent}: 文档 ${totalCost} / 数据 ¥${(tbCostValue + pbCostValue).toFixed(2)}`); problems += 1;
	}
}

const tbRows = detailRows.filter(l => l.startsWith('| Terminal-Bench |')).length;
const pbRows = detailRows.filter(l => l.startsWith('| ProgramBench |')).length;
console.log(`\n明细 ${detailRows.length} 行（TB ${tbRows} / PB ${pbRows}）+ 汇总 ${agentRows.length} 行；`);
console.log(`数据 ${rows.length} 行（TB ${rows.filter(r => r.bench === 'Terminal-Bench').length}、PB ${rows.filter(r => r.bench === 'ProgramBench').length}，其中复测 ${rows.filter(r => r.retest).length}）；问题 ${problems} 处`);
