import { errorMessage, invalid } from '../common/errors.ts';
import { apiBase } from './client.ts';
import type { IUsableProvider } from './config.ts';

const TIMEOUT_MS = 15_000;

/** 上游列表里的一个模型。标准接口只保证有 ID，能认出来的上下文长度和看图能力顺便带上。 */
export interface IUpstreamModel {
	readonly model: string;
	readonly contextWindow: number | undefined;
	readonly vision: boolean | undefined;
	/** 是否已经添加到这个供应商。 */
	readonly added: boolean;
}

/** 请求供应商的 GET /v1/models，列出它提供的模型。 */
export async function fetchUpstreamModels(provider: IUsableProvider): Promise<IUpstreamModel[]> {
	const url = `${apiBase(provider.baseUrl)}/models`;
	let response: Response;
	try {
		response = await fetch(url, { headers: { Authorization: `Bearer ${provider.apiKey}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
	} catch (error) {
		throw invalid(`请求 ${url} 失败：${errorMessage(error)}`);
	}
	if (!response.ok) throw invalid(`请求 ${url} 失败（HTTP ${response.status}）：${(await response.text()).slice(0, 300)}`);
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		throw invalid(`${url} 返回的不是 JSON`);
	}
	const data = (body as { data?: unknown } | null)?.data;
	if (!Array.isArray(data)) throw invalid(`${url} 返回的内容中没有模型列表（data）`);
	const added = new Set(provider.models.map(model => model.model));
	return data.flatMap(item => {
		if (!item || typeof item !== 'object' || typeof (item as Record<string, unknown>)['id'] !== 'string') return [];
		const record = item as Record<string, unknown>;
		const model = record['id'] as string;
		return [{ model, contextWindow: contextWindow(record), vision: vision(record), added: added.has(model) }];
	}).sort((left, right) => left.model.localeCompare(right.model));
}

/** OpenRouter 写在 context_length，vLLM 写在 max_model_len，其他常见写法也认。 */
function contextWindow(record: Record<string, unknown>): number | undefined {
	for (const key of ['context_length', 'context_window', 'max_model_len', 'max_context_length']) {
		const value = record[key];
		if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
	}
	return undefined;
}

/** OpenRouter 写在 architecture.input_modalities；没有这个信息时不猜。 */
function vision(record: Record<string, unknown>): boolean | undefined {
	const architecture = record['architecture'];
	const modalities = (architecture && typeof architecture === 'object' ? (architecture as Record<string, unknown>)['input_modalities'] : undefined)
		?? record['input_modalities'];
	return Array.isArray(modalities) ? modalities.includes('image') : undefined;
}
