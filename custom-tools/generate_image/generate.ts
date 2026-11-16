// generate_image：代理一次 openai SDK 的 images.generate。参数名和取值和 SDK 一样，原样传过去；结果是 SDK 的返回，图片附在后面。
// 按 gpt-image 系列的接口写：图片以 base64 返回。
// 用 require 取运行时自带的 openai 包（运行时设了 NODE_PATH），复制到数据目录后照样能用。

import { createRequire } from 'node:module';
import type { ImageGenerateParamsNonStreaming } from 'openai/resources/images';

const require = createRequire(import.meta.url);
const { OpenAI, APIError, APIConnectionTimeoutError, APIUserAbortError } = require('openai') as typeof import('openai');

/** 包括 SDK 的重试在内最多等多久；工具整体最多 10 分钟，到时运行时结束进程。 */
const TIMEOUT_MS = 590_000;
/** 原样传给 SDK 的参数，和 tool.json 里的一致。model 来自配置；流式的、SDK 标为弃用的不给。 */
const PARAMETERS = [
	'prompt', 'size', 'quality', 'complexity', 'background', 'output_format', 'output_compression', 'n', 'moderation', 'frame_count', 'frame_duration_ms', 'svg',
] as const;
const MIME_TYPES: Readonly<Record<string, string>> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
/** 按状态码写的原因，成员知道该不该重试。 */
const REASONS: Readonly<Record<number, string>> = { 401: 'key 无效', 402: '账号余额不足', 404: '该供应商可能未提供图片生成接口，或不支持该模型' };

interface IInput {
	readonly arguments: Readonly<Record<string, unknown>>;
	readonly config: { readonly service: { readonly baseUrl: string; readonly apiKey: string }; readonly model: string };
}

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as IInput;
const { service, model } = input.config;
const name = `图片生成供应商（${new URL(service.baseUrl).host}）`;
try {
	const params = Object.fromEntries(PARAMETERS.filter(key => input.arguments[key] !== undefined).map(key => [key, input.arguments[key]])) as Omit<ImageGenerateParamsNonStreaming, 'model'>;
	if (typeof params.prompt !== 'string' || !params.prompt.trim()) throw new Error('prompt 不能为空');
	// 429、5xx、超时由 SDK 自动重试两次；signal 限定包括重试在内的总时长，在运行时结束进程之前给出原因。
	const client = new OpenAI({ baseURL: `${service.baseUrl.replace(/\/+$/, '')}/v1`, apiKey: service.apiKey, maxRetries: 2, timeout: TIMEOUT_MS });
	const response = await client.images.generate({ ...params, model }, { signal: AbortSignal.timeout(TIMEOUT_MS) });
	const images = response.data ?? [];
	if (images.length === 0 || images.some(image => !image.b64_json)) throw new Error(`${name}未返回图片数据：模型须为 gpt-image 系列，其他模型可能只返回网址`);
	const format = response.output_format ?? params.output_format ?? 'png';
	// b64_json 换成第几张图片，图片附在后面；SVG 不是图片，解码成源码。
	const data = images.map(({ b64_json, ...rest }, index) => format === 'svg' ? { ...rest, svg: Buffer.from(b64_json!, 'base64').toString('utf8') } : { ...rest, image: index + 1 });
	const content: object[] = [{ type: 'text', text: JSON.stringify({ ...response, data }, null, 2) }];
	if (format !== 'svg') {
		for (const image of images) content.push({ type: 'image', data: image.b64_json, mimeType: MIME_TYPES[format] ?? 'image/png' });
	}
	process.stdout.write(JSON.stringify({ content }));
} catch (error) {
	process.stdout.write(JSON.stringify({ content: [{ type: 'text', text: describe(error) }], isError: true }));
}

function describe(error: unknown): string {
	if (error instanceof APIConnectionTimeoutError || error instanceof APIUserAbortError) return `${name}在 ${TIMEOUT_MS / 1000} 秒内未响应`;
	if (error instanceof APIError && error.status !== undefined) {
		// SDK 的说明开头已经写了状态码，去掉，不写两遍。
		const detail = error.message.replace(new RegExp(`^${error.status} (status code \\(no body\\)$)?`), '').trim();
		const reason = REASONS[error.status] ?? detail;
		return `${name}返回 ${error.status}${reason ? `：${reason}` : ''}`;
	}
	if (error instanceof APIError) return `连接${name}失败：${error.message}`;
	return error instanceof Error ? error.message : String(error);
}
