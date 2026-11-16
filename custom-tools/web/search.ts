// web_search：用 DeepSeek 的搜索接口搜索网页，每条给标题、网址、站点、日期和长摘要，不要正文。

import { fail, post, readInput, reply } from './common.ts';

const TIMEOUT_MS = 30_000;
const DEFAULT_COUNT = 5;
const MAX_COUNT = 20;

interface IResult {
	readonly title: string;
	readonly url: string;
	readonly siteName: string | null;
	readonly date: string | null;
	readonly summary: string;
}

const input = await readInput<{ query?: unknown; count?: unknown }>();
try {
	const query = typeof input.arguments.query === 'string' ? input.arguments.query.trim() : '';
	if (!query) throw new Error('query 不能为空');
	if ([...query].length > 128) throw new Error('搜索关键词最多 128 个字符');
	const count = input.arguments.count ?? DEFAULT_COUNT;
	if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > MAX_COUNT) throw new Error(`count 须为 1 至 ${MAX_COUNT} 的整数`);
	const body = await post(input.config.service, 'search', { query, count }, TIMEOUT_MS, '搜索', '该供应商可能未提供搜索接口');
	const items = (body as { results?: unknown }).results;
	if (!Array.isArray(items)) throw new Error('搜索供应商返回的内容缺少 results');
	const results = items.map((item: Record<string, unknown>): IResult => ({
		title: typeof item['title'] === 'string' ? item['title'] : '',
		url: typeof item['url'] === 'string' ? item['url'] : '',
		siteName: typeof item['site_name'] === 'string' && item['site_name'] ? item['site_name'] : null,
		date: typeof item['date'] === 'string' && item['date'] ? item['date'] : null,
		summary: typeof item['summary'] === 'string' && item['summary'] ? item['summary'] : typeof item['snippet'] === 'string' ? item['snippet'] : '',
	}));
	reply(results.length === 0 ? '未找到相关结果' : results.map(format).join('\n\n'), results);
} catch (error) {
	fail(error instanceof Error ? error.message : String(error));
}

/** 一条结果写成几行：序号和标题、网址、站点和日期（没有的不写）、摘要。 */
function format(result: IResult, index: number): string {
	const source = [result.siteName, result.date?.slice(0, 10)].filter(Boolean).join(' · ');
	return [`${index + 1}. ${result.title || '（无标题）'}`, result.url, source, result.summary].filter(Boolean).join('\n');
}
