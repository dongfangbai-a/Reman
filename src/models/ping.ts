import { errorMessage } from '../common/errors.ts';
import type { IModelClient, IModelUsage } from './client.ts';
import type { IModelRef, ModelConfig } from './config.ts';

/** 测试最多等这么久，没完成算失败。 */
const TIMEOUT_MS = 60_000;
/** 只是测通不通，用英文。 */
const INSTRUCTIONS = 'This is a connectivity test. Reply with only: pong';

/** 测试的结果。不能用也是正常的结果，不抛出。 */
export type PingResult =
	| {
		readonly ok: true;
		/** 回复的文字，可能为空。 */
		readonly reply: string;
		/** 开始输出第一项（思考或文字）用了多久；服务没说时是 null。 */
		readonly firstOutputMs: number | null;
		readonly totalMs: number;
		readonly usage: IModelUsage | null;
	}
	| { readonly ok: false; readonly error: string };

/**
 * 测试一个已添加的模型现在能不能用（网页端设计「设置 → 模型」的「测试」）：用已保存的地址和 key，和成员运行时一样发一次请求。
 * 不带工具、不设思考强度、不限输出长度、不重试；不算运行，什么都不记下来。
 */
export async function pingModel(config: ModelConfig, client: IModelClient, ref: IModelRef, now: () => number = () => performance.now()): Promise<PingResult> {
	const signal = AbortSignal.timeout(TIMEOUT_MS);
	const started = now();
	let firstOutputAt: number | undefined;
	const outputStarted = () => {
		firstOutputAt ??= now();
	};
	try {
		const { provider, entry } = config.resolve(ref);
		const response = await client.respond({
			connection: { baseUrl: provider.baseUrl, endpointMode: provider.endpointMode, apiKey: provider.apiKey },
			model: entry.model,
			reasoningEffort: null,
			promptCacheKey: 'reman-runtime:model-test',
			input: [message('developer', INSTRUCTIONS), message('user', 'ping')],
			tools: [],
		}, signal, outputStarted, outputStarted);
		const reply = response.output
			.flatMap(output => output.type === 'message' && Array.isArray(output['content']) ? output['content'] as { text?: unknown }[] : [])
			.map(part => typeof part.text === 'string' ? part.text : '')
			.join('')
			.trim();
		return {
			ok: true, reply, firstOutputMs: firstOutputAt === undefined ? null : Math.round(firstOutputAt - started),
			totalMs: Math.round(now() - started), usage: response.usage ?? null,
		};
	} catch (error) {
		if (signal.aborted) return { ok: false, error: `${TIMEOUT_MS / 1000} 秒内未完成` };
		return { ok: false, error: errorMessage(error) };
	}
}

function message(role: 'developer' | 'user', text: string): object {
	return { type: 'message', role, content: [{ type: 'input_text', text }] };
}
