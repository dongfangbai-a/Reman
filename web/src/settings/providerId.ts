/** 域名里倒数第二段是这些时，主体在再往前一段，如 example.com.cn。 */
const SECOND_LEVEL_DOMAINS = new Set(['com', 'net', 'org', 'gov', 'edu', 'co', 'ac']);
/** 这些是通用的前缀，不能当标识。 */
const GENERIC_LABELS = new Set(['api', 'www', 'open', 'openapi', 'gateway']);

/** 按地址给新供应商想一个标识：取域名的主体，如 api.deepseek.com 取 deepseek；IP 地址、本机取不出来。重名时加数字。 */
export function suggestProviderId(url: string, taken: ReadonlySet<string>): string {
	let host: string;
	try {
		host = new URL(url.trim()).hostname.toLowerCase();
	} catch {
		return '';
	}
	if (!host.includes('.') || /^[\d.]+$/.test(host) || host.includes(':')) return '';
	const labels = host.split('.').slice(0, -1);
	while (labels.length > 1 && SECOND_LEVEL_DOMAINS.has(labels.at(-1)!)) labels.pop();
	const base = (labels.at(-1) ?? '').replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '');
	if (!base || GENERIC_LABELS.has(base)) return '';
	let id = base;
	for (let index = 2; taken.has(id); index++) id = `${base}-${index}`;
	return id;
}
