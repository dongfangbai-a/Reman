import type OpenAI from 'openai';
import { errorMessage } from '../common/errors.ts';
import { clipEnd } from '../common/text.ts';
import type { IModelOutputItem } from '../timeline/timeline.ts';

/** openai 包用到时再加载：启动时加载要七八十毫秒，测试模型和没配模型时用不上。 */
type OpenAIModule = typeof import('openai').default;

/** 报错里服务给的说明最多留多少字。 */
const ERROR_CHARS = 500;

/** 模型请求失败。retryable 表示按重试规则可以再试。 */
export class ModelError extends Error {
	readonly code: string;
	readonly retryable: boolean;

	constructor(code: string, message: string, retryable: boolean) {
		super(message);
		this.code = code;
		this.retryable = retryable;
	}
}

export interface IFunctionTool {
	readonly type: 'function';
	readonly name: string;
	readonly description: string;
	readonly parameters: Record<string, unknown>;
	readonly strict: false;
}

export interface IModelRequest {
	readonly connection: { readonly baseUrl: string; readonly apiKey: string };
	readonly model: string;
	readonly reasoningEffort: string | null;
	/** 一次回复最多多少 token；没写时不发，按服务商的默认值。 */
	readonly maxOutputTokens?: number;
	readonly promptCacheKey: string;
	readonly input: readonly object[];
	readonly tools: readonly IFunctionTool[];
	/** 压缩请求用：不让模型调用工具，并用 JSON 格式约束输出。 */
	readonly toolChoice?: 'none';
	readonly textFormat?: Record<string, unknown>;
}

export interface IModelUsage {
	readonly inputTokens: number;
	readonly cachedTokens: number;
	readonly outputTokens: number;
}

export interface IModelResponse {
	readonly output: readonly IModelOutputItem[];
	readonly usage: IModelUsage | undefined;
}

export type DeltaListener = (kind: 'text' | 'reasoning', delta: string) => void;

/** 模型开始输出的一项：思考、文字，或者工具调用和工具名。 */
export type ModelOutputStart = { readonly type: 'reasoning' } | { readonly type: 'text' } | { readonly type: 'call'; readonly name: string };

/** 模型开始输出一项时调用；有的服务不说，就一次也不调用。 */
export type OutputListener = (output: ModelOutputStart) => void;

/** 调一次模型。测试里换成假的实现。 */
export interface IModelClient {
	respond(request: IModelRequest, signal: AbortSignal, onDelta: DeltaListener, onOutput: OutputListener): Promise<IModelResponse>;
}

/** 通过 openai SDK 调 Responses API，流式、不在服务端保存（store=false）。 */
export class OpenAIModelClient implements IModelClient {
	private cached: { key: string; client: OpenAI } | undefined;

	async respond(request: IModelRequest, signal: AbortSignal, onDelta: DeltaListener, onOutput: OutputListener): Promise<IModelResponse> {
		const sdk = (await import('openai')).default;
		const client = this.clientFor(sdk, request.connection.baseUrl, request.connection.apiKey);
		const params = requestBody(request) as unknown as OpenAI.Responses.ResponseCreateParamsStreaming;
		const outputs = new Map<number, IModelOutputItem>();
		/** 开始输出了的项：没收到「响应完成」时，这些都要收完才算完整的回复。 */
		const started = new Set<number>();
		let completed: OpenAI.Responses.Response | undefined;
		try {
			const stream = await client.responses.create(params, { signal });
			for await (const event of stream) {
				if ('output_index' in event) started.add(event.output_index);
				switch (event.type) {
					case 'response.output_item.added': {
						const item = event.item;
						if (item.type === 'reasoning') onOutput({ type: 'reasoning' });
						else if (item.type === 'message') onOutput({ type: 'text' });
						else if (item.type === 'function_call') onOutput({ type: 'call', name: item.name });
						break;
					}
					case 'response.output_text.delta':
						onDelta('text', event.delta);
						break;
					case 'response.reasoning_summary_text.delta':
					case 'response.reasoning_text.delta':
						onDelta('reasoning', event.delta);
						break;
					case 'response.output_item.done':
						outputs.set(event.output_index, event.item as unknown as IModelOutputItem);
						break;
					case 'response.completed':
						completed = event.response;
						break;
					case 'response.failed': {
						// 有的服务先返回 200，再在这里报错，原因开头带着状态码（「<400> …」）：带着的照状态码算能不能重试。
						const message = event.response.error?.message ?? '未知原因';
						const status = /^<(\d{3})>/.exec(message)?.[1];
						throw new ModelError('response_failed', `模型响应失败：${message}`, status === undefined || retryableStatus(Number(status)));
					}
					case 'response.incomplete':
						throw new ModelError('response_incomplete', `模型响应不完整：${event.response.incomplete_details?.reason ?? '未知原因'}`, true);
					case 'error':
						throw new ModelError('stream_error', `模型服务报错：${event.message}`, true);
				}
			}
		} catch (error) {
			throw normalizeError(sdk, error, signal);
		}
		// SDK 遇到中止时不报错，只是结束流：已经输出完的几项不能当作完整的回复。
		signal.throwIfAborted();
		const output = outputs.size > 0
			? [...outputs.entries()].sort(([left], [right]) => left - right).map(([, item]) => item)
			: (completed?.output ?? []) as unknown as IModelOutputItem[];
		// 有些兼容服务不发 response.completed：开始输出的每一项都收完了就接受。有一项没收完是连接没报错就断了，不交回半截回复。
		if (!completed && (output.length === 0 || [...started].some(index => !outputs.has(index)))) throw new ModelError('stream_incomplete', '模型输出中途断开', true);
		const usage = completed?.usage;
		return {
			output,
			usage: usage && {
				inputTokens: usage.input_tokens,
				cachedTokens: usage.input_tokens_details?.cached_tokens ?? 0,
				outputTokens: usage.output_tokens,
			},
		};
	}

	private clientFor(sdk: OpenAIModule, baseUrl: string, apiKey: string): OpenAI {
		const key = `${baseUrl}\n${apiKey}`;
		if (this.cached?.key !== key) {
			this.cached = { key, client: new sdk({ baseURL: apiBase(baseUrl), apiKey, maxRetries: 0 }) };
		}
		return this.cached.client;
	}
}

/** 接口的地址：配置里的 baseUrl 不带 /v1，末尾的斜杠可有可无。 */
export function apiBase(baseUrl: string): string {
	return `${baseUrl.replace(/\/+$/, '')}/v1`;
}

/** 发给上游的请求体，不含地址和 key。 */
export function requestBody(request: IModelRequest): Record<string, unknown> {
	return {
		model: request.model,
		input: request.input,
		stream: true,
		store: false,
		// 没有工具时（测试模型）不发：有的兼容服务不接受空的工具列表。
		...(request.tools.length > 0 ? { tools: request.tools, parallel_tool_calls: true } : {}),
		include: ['reasoning.encrypted_content'],
		stream_options: { include_obfuscation: false },
		prompt_cache_key: request.promptCacheKey,
		...(request.maxOutputTokens ? { max_output_tokens: request.maxOutputTokens } : {}),
		...(request.reasoningEffort ? { reasoning: { effort: request.reasoningEffort, summary: 'concise' } } : {}),
		...(request.toolChoice ? { tool_choice: request.toolChoice } : {}),
		...(request.textFormat ? { text: { format: request.textFormat } } : {}),
	};
}

function normalizeError(sdk: OpenAIModule, error: unknown, signal: AbortSignal): unknown {
	if (error instanceof ModelError || signal.aborted || error instanceof sdk.APIUserAbortError) return error;
	if (error instanceof sdk.APIConnectionTimeoutError) return new ModelError('timeout', '请求模型超时', true);
	if (error instanceof sdk.APIConnectionError) return new ModelError('network', `连接模型服务失败：${clipEnd(error.message, ERROR_CHARS)}`, true);
	if (error instanceof sdk.APIError) {
		const status = error.status ?? 0;
		const retryable = retryableStatus(status);
		// SDK 的说明开头已经写了状态码（「401 Incorrect API key」），没有内容时写「401 status code (no body)」：去掉，不写两遍。
		const detail = error.status === undefined ? error.message : error.message.replace(new RegExp(`^${status} (status code \\(no body\\)$)?`), '');
		return new ModelError(`http_${status}`, detail ? `模型服务返回 ${status}：${clipEnd(detail, ERROR_CHARS)}` : `模型服务返回 ${status}`, retryable);
	}
	return new ModelError('unknown', `调用模型出错：${clipEnd(errorMessage(error), ERROR_CHARS)}`, false);
}

/** 408、409、429 和 5xx 能重试；其他 4xx 是请求本身的问题，再发一次还是一样。 */
function retryableStatus(status: number): boolean {
	return [408, 409, 429].includes(status) || status >= 500;
}
