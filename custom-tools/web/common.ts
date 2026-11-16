// 网络搜索的两个脚本共用：读标准输入、写结果、请求 DeepSeek 的搜索接口。

/** 运行时从标准输入给的内容。 */
export interface IInput<A> {
	readonly arguments: A;
	readonly config: { readonly service: IService };
	readonly workingDirectory: string;
	/** 存放文件的目录，调用前已建好。 */
	readonly outputDirectory: string;
}

/** 配置里选的供应商：地址不带 /v1。 */
export interface IService {
	readonly baseUrl: string;
	readonly apiKey: string;
}

/** 失败后再试几次，每次等多久。 */
const RETRY_DELAYS_MS = [1000, 2000];

export async function readInput<A>(): Promise<IInput<A>> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
	return JSON.parse(Buffer.concat(chunks).toString('utf8')) as IInput<A>;
}

/** 写出结果：给模型看的文字和脚本里拿到的结构化结果。 */
export function reply(text: string, structured: unknown): void {
	process.stdout.write(JSON.stringify({ content: [{ type: 'text', text }], structuredContent: structured }));
}

/** 写出错误：成员看到的原因。 */
export function fail(message: string): void {
	process.stdout.write(JSON.stringify({ content: [{ type: 'text', text: message }], isError: true }));
}

/** 按状态码写的原因，成员知道该不该重试。 */
const REASONS: Readonly<Record<number, string>> = { 401: 'key 无效', 402: '账号余额不足' };

/**
 * POST 一个接口，返回 JSON。429、5xx、408、超时和连不上时等一会儿再试，最多两次；还不行或者是别的错误时抛出写好的原因。
 * notFound 是 404 时的原因：搜索是该供应商未提供搜索接口，读取网页是无法获取网页内容。
 */
export async function post(service: IService, path: string, body: unknown, timeoutMs: number, kind: '搜索' | '读取网页', notFound: string): Promise<unknown> {
	const url = `${service.baseUrl.replace(/\/+$/, '')}/v1/tools/${path}`;
	const name = `${kind === '搜索' ? '搜索供应商' : '搜索供应商的网页读取接口'}（${new URL(url).host}）`;
	for (let attempt = 0; ; attempt++) {
		let response: Response;
		try {
			response = await fetch(url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${service.apiKey}` },
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(timeoutMs),
			});
		} catch (error) {
			const timedOut = error instanceof Error && error.name === 'TimeoutError';
			if (attempt < RETRY_DELAYS_MS.length) {
				await wait(RETRY_DELAYS_MS[attempt]!);
				continue;
			}
			throw new Error(timedOut ? `${name}在 ${timeoutMs / 1000} 秒内未响应` : `连接${name}失败：${error instanceof Error ? error.message : String(error)}`);
		}
		if (response.ok) return await response.json();
		const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
		if (retryable && attempt < RETRY_DELAYS_MS.length) {
			await wait(RETRY_DELAYS_MS[attempt]!);
			continue;
		}
		const detail = await serviceMessage(response);
		const reason = response.status === 404 ? notFound
			: response.status === 403 && kind === '读取网页' ? '被搜索供应商的安全策略拒绝'
				: REASONS[response.status] ?? detail;
		throw new Error(`${name}返回 ${response.status}${reason ? `：${reason}` : ''}`);
	}
}

/** 供应商给的说明：OpenAI 兼容的 { error: { message } }，不是这个形状时取开头的文字。 */
async function serviceMessage(response: Response): Promise<string> {
	const text = await response.text().catch(() => '');
	try {
		const message = (JSON.parse(text) as { error?: { message?: unknown } }).error?.message;
		if (typeof message === 'string') return message.slice(0, 500);
	} catch {
		// 不是 JSON。
	}
	return text.trim().slice(0, 500);
}

function wait(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}
