import { invalid } from '../common/errors.ts';
import { MORE_TOOLS_NAME, toolSummary, type ITool, type Tools } from './tools.ts';

/**
 * 渐进式提供的工具：说明里只列名字和用途，describe 返回完整定义，call 执行目标工具。
 * call 由执行器换成对目标工具的调用（成员设置、审批、转后台都按目标工具），不会走到这里的 execute。
 * 看过完整定义后，模型也可以直接调用目标工具。
 * 能查看和调用成员能用的任何工具，不限于渐进式的：工具列表是快照，之后新增的直接提供的工具在重新生成快照之前不在列表里，靠它调用。
 */
export function createMoreTools(tools: () => Tools): ITool {
	return {
		name: MORE_TOOLS_NAME,
		label: '使用更多工具',
		description: '查看和调用渐进式工具。',
		parameters: {
			type: 'object',
			properties: {
				action: { type: 'string', enum: ['describe', 'call'], description: 'describe：查看工具的完整说明和参数；call：调用工具' },
				tool_name: { type: 'string', description: '工具名' },
				arguments: { type: 'object', description: 'call 时传给工具的参数，按 describe 返回的参数定义填写' },
			},
			required: ['action', 'tool_name'],
			additionalProperties: false,
		},
		// describe 返回说明文字，call 返回目标工具的结果。
		returns: 'any',
		describe(memberId) {
			const progressive = tools().available(memberId).filter(tool => tool.progressive);
			return [
				'查看和调用渐进式工具。下方只列出工具名和用途；使用某个工具前，如尚未查看其参数，先用 describe 查看，不要猜测参数。',
				'查看后，可以用 call 调用，也可以直接调用该工具。',
				'',
				...progressive.map(tool => `- ${tool.name}：${toolSummary(tool)}`),
			].join('\n');
		},
		execute(context, args) {
			const name = args['tool_name'];
			if (typeof name !== 'string' || !name) throw invalid('tool_name 不能为空');
			if (args['action'] !== 'describe') throw invalid('action 只能是 describe 或 call');
			const tool = tools().available(context.memberId).find(item => item.name === name);
			if (!tool || tool.name === MORE_TOOLS_NAME) throw invalid(`不存在工具 ${name}`);
			return [
				`工具 ${tool.name}`,
				'',
				tool.describe?.(context.memberId) ?? tool.description,
				'',
				'参数（JSON Schema）：',
				JSON.stringify(tool.parameters, null, 2),
				'',
				`在 run_tool_script 的脚本中调用时的返回类型：${tool.returns ?? 'string'}`,
			].join('\n');
		},
	};
}

/** more_tools 的 call：找出目标工具和参数。参数写成 JSON 字符串也接受。不是 call 时返回 undefined。 */
export function resolveMoreToolsCall(tools: Tools, tool: ITool, args: Record<string, unknown>): { tool: ITool; args: Record<string, unknown> } | { error: string } | undefined {
	if (tool.name !== MORE_TOOLS_NAME || args['action'] !== 'call') return undefined;
	const name = args['tool_name'];
	const target = typeof name === 'string' ? tools.get(name) : undefined;
	if (!target || target.name === MORE_TOOLS_NAME) return { error: `不存在工具 ${String(name)}` };
	let targetArgs = args['arguments'] ?? {};
	if (typeof targetArgs === 'string') {
		try {
			targetArgs = JSON.parse(targetArgs);
		} catch {
			return { error: 'arguments 不是合法的 JSON' };
		}
	}
	if (typeof targetArgs !== 'object' || targetArgs === null || Array.isArray(targetArgs)) return { error: 'arguments 必须是对象' };
	return { tool: target, args: targetArgs as Record<string, unknown> };
}
