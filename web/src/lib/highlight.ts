import type { IHighlightRequest, IHighlightResponse } from './highlight.worker.ts';

/** 记住最近高亮过的代码，总长不超过这么多字：切走再切回文件标签、时间线重画时不重新高亮。 */
const CACHE_CHARS = 1_000_000;

let worker: Worker | undefined;
let nextId = 0;
const waiting = new Map<number, (html: string | undefined) => void>();
/** 按语言和代码记，先进先出；正在高亮的也记着，同一段只发一次。 */
const cache = new Map<string, Promise<string | undefined>>();
let cachedChars = 0;

/**
 * 代码高亮成 HTML（Shiki，浅色和深色两套主题）；不认识的语言、出错时是 undefined，显示纯文本。
 * 在 Worker 里做，不占页面的主线程：一个 19 万字的文件在主线程上高亮要约半秒。
 * 不提供同步取缓存结果的办法：切回标签时直接画高亮好的大段 HTML，反而比先画纯文本再换掉慢一倍多。
 */
export function highlight(code: string, language: string): Promise<string | undefined> {
	const key = `${language}\n${code}`;
	const cached = cache.get(key);
	if (cached) return cached;
	const result = new Promise<string | undefined>(resolve => {
		const id = nextId++;
		waiting.set(id, resolve);
		highlighter().postMessage({ id, code, language } satisfies IHighlightRequest);
	});
	cache.set(key, result);
	cachedChars += key.length;
	for (const [oldKey] of cache) {
		if (cachedChars <= CACHE_CHARS || cache.size === 1) break;
		cache.delete(oldKey);
		cachedChars -= oldKey.length;
	}
	return result;
}

function highlighter(): Worker {
	if (worker) return worker;
	worker = new Worker(new URL('./highlight.worker.ts', import.meta.url), { type: 'module' });
	worker.onmessage = (event: MessageEvent<IHighlightResponse>) => {
		waiting.get(event.data.id)?.(event.data.html);
		waiting.delete(event.data.id);
	};
	// Worker 起不来时都显示纯文本。
	worker.onerror = () => {
		for (const resolve of waiting.values()) resolve(undefined);
		waiting.clear();
	};
	return worker;
}
