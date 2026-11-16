/**
 * 供应商地址怎么变成请求地址。
 *
 * 各家的路径不统一：有的就是 OpenAI 的 `/v1/responses`，有的在前面垫一段（`/api/openai/v1`），
 * 有的干脆不用 `/responses` 结尾。所以配置里只给一个地址，按两种方式解析：
 *
 * - `auto`：按 OpenAI 的约定补。只填域名时补 `/v1/responses`；填到版本段（`/v1`、`/v2`）时补
 *   `/responses`；已经以 `/responses` 结尾、或者路径更长时，原样使用。
 * - `exact`：完全按填的来，一个字符都不追加。
 */
export type EndpointMode = 'auto' | 'exact';

/** 地址里的路径部分：去掉末尾的斜杠，查询和锚点不算地址的一部分。 */
function pathOf(baseUrl: string): { readonly origin: string; readonly path: string } {
	const url = new URL(baseUrl);
	if (url.search || url.hash) throw new Error('地址里不能带查询或锚点');
	return { origin: url.origin, path: url.pathname.replace(/\/+$/, '') };
}

/**
 * 回复接口的完整地址，不含查询和锚点。
 * `https://host` → `https://host/v1/responses`；`https://host/v1` → `https://host/v1/responses`；
 * `https://host/api/openai` → 原样；`https://host/api/v1/responses` → 原样。
 */
export function apiEndpoint(baseUrl: string, mode: EndpointMode = 'auto'): string {
	const { origin, path } = pathOf(baseUrl);
	if (mode === 'exact') return `${origin}${path}`;
	if (path === '') return `${origin}/v1/responses`;
	if (/\/responses$/i.test(path)) return `${origin}${path}`;
	// 版本段带后缀的（/v1beta、/v4a）也算：那是版本号的一部分，不是接口路径。
	if (/\/v\d+[a-z0-9]*$/i.test(path)) return `${origin}${path}/responses`;
	return `${origin}${path}`;
}

/** 模型列表（`GET …/models`）的地址：和回复接口同一个前缀。 */
export function modelsEndpoint(baseUrl: string, mode: EndpointMode = 'auto'): string {
	return `${apiEndpoint(baseUrl, mode).replace(/\/responses$/i, '')}/models`;
}
