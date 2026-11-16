import { invalid } from '../../common/errors.ts';
import type { ExternalEvents, ITrialResult } from '../../external/external.ts';
import type { ITool } from '../tools.ts';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/** 用事件日志里最近的外部事件试跑一条事件路由，不真的投递。 */
export function createTestEventRouteTool(external: ExternalEvents): ITool<ITrialResult[]> {
	return {
		name: 'test_event_route',
		label: '试运行事件路由',
		progressive: true,
		description: [
			'用事件日志中最近的外部事件试运行一条事件路由，返回每个事件将产生的投递，不实际投递。',
			'只使用该路由 sources 中所列来源的事件，按从新到旧排列。route 和 code 二者提供一个。',
		].join('\n'),
		defaultPolicy: 'allow',
		enabledByDefault: false,
		parameters: {
			type: 'object',
			properties: {
				route: { type: 'string', description: '已有的路由名：event-routes 中的文件名，不含 .js' },
				code: { type: 'string', description: '尚未保存的路由全文' },
				source: { type: 'string', description: '仅使用该来源的事件' },
				limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, description: `使用最近的事件数量，默认 ${DEFAULT_LIMIT}` },
			},
			additionalProperties: false,
		},
		returns: '{ time: string; source: string; content: string; deliveries: string[]; error: string | null; logs: string[] }[]',
		async execute(_context, args) {
			const { route, code, source } = args;
			const limit = args['limit'] ?? DEFAULT_LIMIT;
			if ((route === undefined) === (code === undefined)) throw invalid('route 和 code 须提供其中一个');
			if (route !== undefined && typeof route !== 'string') throw invalid('route 须为路由名');
			if (code !== undefined && (typeof code !== 'string' || !code.trim())) throw invalid('code 须为路由全文');
			if (source !== undefined && typeof source !== 'string') throw invalid('source 须为来源名');
			if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw invalid(`limit 须为 1 到 ${MAX_LIMIT} 的整数`);
			return typeof route === 'string'
				? await external.trial(route, external.routes.read(route), source, limit)
				: await external.trial('route', code as string, source, limit);
		},
		format(results) {
			if (results.length === 0) return '事件日志中尚无该路由所处理来源的事件';
			return results.map(result => [
				`[${result.time}] ${result.source}：${result.content}`,
				...result.error !== null ? [`执行出错：${result.error}`] : result.deliveries.length > 0 ? result.deliveries.map(delivery => `- ${delivery}`) : ['不投递'],
				...result.logs.length > 0 ? ['console 输出：', ...result.logs] : [],
			].join('\n')).join('\n\n');
		},
	};
}
