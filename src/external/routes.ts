import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runModule } from '../code/quickjs.ts';
import { errorMessage, notFound } from '../common/errors.ts';
import { isRecord } from '../common/json.ts';
import { MAX_TEXT_LENGTH } from '../messages/messages.ts';
import type { IExternalEvent } from './eventLog.ts';

/** 路由每次执行的上限：路由只做简单的判断，正常远用不到。 */
const CPU_LIMIT_MS = 500;
const MEMORY_LIMIT_BYTES = 32 * 1024 * 1024;
const SOURCES_PROBLEM = "须导出 sources，写明要处理的事件来源，如 export const sources = ['github']";
const MEMBER_KEYS = ['to', 'text', 'wake'];
const GROUP_KEYS = ['to', 'from', 'text', 'mentions'];

/** 路由返回的一个投递，检查过格式，text 还没换成正文。 */
export type RouteDelivery =
	| { readonly kind: 'member'; readonly to: string; readonly text: string | undefined; readonly wake: boolean }
	| { readonly kind: 'group'; readonly to: string; readonly from: string; readonly text: string | undefined; readonly mentions: readonly string[] | 'all' };

export interface IRouteResult {
	readonly deliveries: readonly RouteDelivery[];
	readonly error: string | null;
	readonly logs: readonly string[];
}

/** 路由目录 event-routes/：一个 .js 文件一条路由，文件名是路由名。每次都重新读文件，改了立即生效。 */
export class EventRoutes {
	readonly directory: string;

	constructor(directory: string) {
		this.directory = directory;
	}

	/** 路由名，按名字排。 */
	names(): string[] {
		if (!existsSync(this.directory)) return [];
		return readdirSync(this.directory, { withFileTypes: true })
			.filter(entry => entry.isFile() && entry.name.endsWith('.js'))
			.map(entry => entry.name.slice(0, -'.js'.length))
			.sort();
	}

	read(name: string): string {
		if (!this.names().includes(name)) throw notFound(`不存在路由 ${name}`);
		return readFileSync(join(this.directory, `${name}.js`), 'utf8');
	}

	/** 路由导出的 sources；路由有错时返回错误说明。 */
	async sources(name: string, code: string): Promise<readonly string[] | string> {
		let sources: readonly string[] = [];
		const result = await runModule({
			code, fileName: `${name}.js`, input: null, cpuLimitMs: CPU_LIMIT_MS, memoryLimitBytes: MEMORY_LIMIT_BYTES,
			accept: value => {
				sources = checkSources(value);
				return false;
			},
		});
		return result.error ?? sources;
	}

	/** 用一条路由处理一个事件；路由不处理这个来源时返回 undefined。 */
	async run(name: string, code: string, event: IExternalEvent): Promise<IRouteResult | undefined> {
		const result = await runModule({
			code, fileName: `${name}.js`, input: event, cpuLimitMs: CPU_LIMIT_MS, memoryLimitBytes: MEMORY_LIMIT_BYTES,
			accept: value => checkSources(value).includes(event.source),
		});
		if (!result.called && result.error === null) return undefined;
		if (result.error !== null) return { deliveries: [], error: result.error, logs: result.logs };
		try {
			return { deliveries: parseDeliveries(result.value), error: null, logs: result.logs };
		} catch (error) {
			return { deliveries: [], error: `返回的投递格式有误：${errorMessage(error)}`, logs: result.logs };
		}
	}
}

function checkSources(value: unknown): readonly string[] {
	if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error(SOURCES_PROBLEM);
	return value as string[];
}

/** 路由的返回值：空、一个投递或几个投递。格式不对时抛出 Error。 */
function parseDeliveries(value: unknown): RouteDelivery[] {
	if (value === null || value === undefined) return [];
	return (Array.isArray(value) ? value : [value]).map(parseDelivery);
}

function parseDelivery(value: unknown): RouteDelivery {
	if (!isRecord(value)) throw new Error('每个投递须为一个对象，如 { to: \'M_…\' }');
	const record = value;
	const to = record['to'];
	if (typeof to !== 'string' || !/^[MG]_/.test(to)) throw new Error('to 须为 AI 成员的 ID（M_…）或群聊的 ID（G_…）');
	const isGroup = to.startsWith('G_');
	const unknown = Object.keys(record).find(key => !(isGroup ? GROUP_KEYS : MEMBER_KEYS).includes(key));
	if (unknown !== undefined) throw new Error(`${isGroup ? '投递到群聊' : '投递给成员'}时不能包含 ${unknown}，只能包含 ${(isGroup ? GROUP_KEYS : MEMBER_KEYS).join('、')}`);
	const text = record['text'];
	if (text !== undefined && (typeof text !== 'string' || !text.trim())) throw new Error('text 须为非空字符串；不填写时使用事件的正文');
	if (typeof text === 'string' && text.length > MAX_TEXT_LENGTH) throw new Error(`text 过长，最多 ${MAX_TEXT_LENGTH} 个字符`);
	if (!isGroup) {
		const wake = record['wake'] ?? true;
		if (typeof wake !== 'boolean') throw new Error('wake 须为 true 或 false');
		return { kind: 'member', to, text, wake };
	}
	const from = record['from'];
	if (typeof from !== 'string' || !from.startsWith('M_')) throw new Error('投递到群聊时，须用 from 指定代发的真人成员的 ID（M_…）');
	const mentions = record['mentions'] ?? [];
	if (mentions !== 'all' && (!Array.isArray(mentions) || mentions.some(item => typeof item !== 'string'))) throw new Error("mentions 须为成员 ID 的列表或 'all'");
	return { kind: 'group', to, from, text, mentions: mentions as readonly string[] | 'all' };
}
