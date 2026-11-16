// Terminal-Bench 七道题按 agent 汇总，只读 eval/results.json（先跑 node eval/collect-results.mjs）。
//   node eval/terminal-bench/tools/agent-totals.mjs
import { readFileSync } from 'node:fs';
import { costOf } from '../../pricing.mjs';

const { rows } = JSON.parse(readFileSync('eval/results.json', 'utf8'));
const totals = {
	reman: { pass: 0, total: 0, sec: 0, hit: 0, miss: 0, out: 0 },
	cc: { pass: 0, total: 0, sec: 0, hit: 0, miss: 0, out: 0 },
	dsh: { pass: 0, total: 0, sec: 0, hit: 0, miss: 0, out: 0 },
};

for (const row of rows) {
	if (row.extra) continue; // 额外加测只跑了 reman，不进汇总
	if (row.bench !== 'Terminal-Bench') continue; // 汇总只算 Terminal-Bench
	const t = totals[row.agent];
	if (!t) continue;
	t.total += 1;
	if (row.reward === 1) t.pass += 1;
	t.sec += row.seconds;
	t.hit += row.hit;
	t.miss += row.miss;
	t.out += row.output;
}

for (const [agent, t] of Object.entries(totals)) {
	const cost = costOf('deepseek-flash', { input: t.hit + t.miss, cached: t.hit, output: t.out })?.total ?? 0;
	const minutes = Math.round(t.sec / 60);
	const h = Math.floor(minutes / 60);
	const m = minutes % 60;
	console.log([
		agent,
		`${t.pass}/${t.total}`,
		`${h ? h + ' 小时 ' : ''}${m} 分`,
		`${(t.hit / 1e6).toFixed(2)}M / ${Math.round(t.miss / 1e3)}k / ${Math.round(t.out / 1e3)}k`,
		`¥${cost.toFixed(2)}`,
		`${((t.hit / (t.hit + t.miss)) * 100).toFixed(2)}%`,
	].join('\t'));
}
