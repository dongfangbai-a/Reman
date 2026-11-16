// web_fetch：用 DeepSeek 的读取网页接口取网页的标题和 Markdown 正文。
// 正文过长时只返回开头（网页的结尾多是页脚和推荐），完整内容存成 outputDirectory 下的文件，结果里写明路径。

import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fail, post, readInput, reply } from './common.ts';

const TIMEOUT_MS = 60_000;
/** 返回的正文最多多少个字符。 */
const MAX_CHARS = 19_000;
/** 运行时交给模型的文字上限（自定义工具 2 万字，和运行时一样按 JavaScript 字符串长度计）：标题、网址、正文和说明合计不超过它，运行时不再截断。 */
const RESULT_LIMIT = 20_000;

const input = await readInput<{ url?: unknown }>();
try {
	const url = typeof input.arguments.url === 'string' ? input.arguments.url.trim() : '';
	if (!/^https?:\/\/[^/]/i.test(url)) throw new Error('url 须为 http 或 https 地址');
	const body = await post(input.config.service, 'fetch', { url }, TIMEOUT_MS, '读取网页', '无法获取该网页的内容：网页无法访问、被站点拦截，或页面没有正文');
	const record = body as { title?: unknown; content?: unknown };
	const title = typeof record.title === 'string' ? record.title : '';
	const full = typeof record.content === 'string' ? record.content : '';
	const prefix = `${title ? `标题：${title}\n` : ''}网址：${url}\n\n`;
	let content = full;
	let fullContentPath: string | null = null;
	let note = '';
	if (full.length > MAX_CHARS || prefix.length + full.length > RESULT_LIMIT) {
		fullContentPath = join(input.outputDirectory, fileName(url));
		writeFileSync(fullContentPath, [...title ? [`# ${title}`, ''] : [], `网址：${url}`, '', full].join('\n'));
		const describe = (chars: number) => `\n\n（正文共 ${full.length} 个字符，仅返回前 ${chars} 个字符；完整内容已保存到 ${fullContentPath}）`;
		// 说明里的字符数不会比 MAX_CHARS 的位数多，按它留出说明的长度。
		let end = Math.max(0, Math.min(MAX_CHARS, RESULT_LIMIT - prefix.length - describe(MAX_CHARS).length));
		// 不把一个字拆成两半。
		if (end > 0 && /[\uD800-\uDBFF]/.test(full[end - 1]!)) end--;
		content = full.slice(0, end);
		note = describe(end);
	}
	reply(prefix + content + note, { url, title, content, fullContentPath });
} catch (error) {
	fail(error instanceof Error ? error.message : String(error));
}

/** <本地时间>-<主机名>-<随机>.md：按时间排得开，看得出是哪个网站，同一秒的也不重名。 */
function fileName(url: string): string {
	const now = new Date();
	const pad = (value: number) => String(value).padStart(2, '0');
	const time = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
	const host = new URL(url).hostname.replace(/[^a-z0-9.-]/gi, '_');
	return `${time}-${host}-${randomBytes(3).toString('hex')}.md`;
}
