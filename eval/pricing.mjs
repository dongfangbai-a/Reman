// 按模型算一次试次花多少钱。
//
//   import { costOf, priceOf } from './pricing.mjs';
//   costOf('deepseek-flash', { input, cached, output })   // → { hit, miss, output, total } 或 null
//
// 价格写在 eval/pricing.json：每个模型一条，单位是元 / 百万 token。换模型只要加一条，再把这个模型名
// 传给 report.mjs（--model）。每个模型只配一种价格——比较的是不同 agent 之间的花费，峰谷折扣不影响结论。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CONFIG = join(import.meta.dirname, 'pricing.json');

/** 读配置：currency、unit、default、models。文件很小，每次现读，不缓存。 */
export function pricingConfig() {
	const config = JSON.parse(readFileSync(CONFIG, 'utf8'));
	if (!config.models || typeof config.models !== 'object') throw new Error('pricing.json 里没有 models');
	return config;
}

/** 某个模型的价格；没配过返回 null（不要默默按别的模型算）。 */
export function priceOf(model) {
	const config = pricingConfig();
	return config.models[model] ?? null;
}

/**
 * 一次试次的费用，拆成三块。usage 里的 input 是累计输入（含缓存命中的部分），cached 是其中命中的。
 * 配置里没有这个模型、或者没有用量时返回 null，让调用方显示「—」而不是算出个假数。
 */
export function costOf(model, usage) {
	const config = pricingConfig();
	const price = config.models[model];
	if (!price || !usage || usage.input === null || usage.input === undefined) return null;
	const unit = config.unit ?? 1_000_000;
	const hitTokens = Math.min(usage.cached ?? 0, usage.input);
	const missTokens = usage.input - hitTokens;
	const outputTokens = usage.output ?? 0;
	const hit = (hitTokens / unit) * price.hit;
	const miss = (missTokens / unit) * price.miss;
	const output = (outputTokens / unit) * price.output;
	return { hit, miss, output, total: hit + miss + output };
}
