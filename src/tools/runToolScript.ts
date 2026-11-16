import { runScript } from '../code/quickjs.ts';
import { invalid } from '../common/errors.ts';
import { imageResourceId, resourceImage } from '../resources/resources.ts';
import { ExecutionClock } from './clock.ts';
import { BACKGROUND_AFTER_MS, CodeScope, type ToolExecutor } from './executor.ts';
import { MORE_TOOLS_NAME, type ITool, type IToolContext, type IToolText, type Tools } from './tools.ts';

const NAME = 'run_tool_script';
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_TIMEOUT_MS = 2 * 60 * 60 * 1000;
/** 纯 JS 最多执行多久（不算等工具结果的时间）。 */
const CPU_LIMIT_MS = 60 * 1000;
const MEMORY_LIMIT_BYTES = 64 * 1024 * 1024;
/** 一段脚本的结果最多附多少张图片。 */
const MAX_IMAGES = 10;

const DESCRIPTION = `编写一段 JavaScript 脚本，在脚本中调用工具，中间结果保留在脚本中，只将最终需要的内容输出给你。它节省的是多次调用之间的往返，以及中间结果占用的上下文，因此仅在以下情况下使用：
- 需要调用多次，且下一步无需你查看结果后再判断，如对一批文件、网页、条目逐一做相同的处理；
- 工具的结果很长而你只需要其中一部分，如对搜索结果、命令输出、网页内容做筛选、汇总。
只调用一个工具、进行几个互不依赖的调用（在一次回复中同时发出多个调用即可），或每一步都需要查看结果后再决定下一步时，直接调用工具。

- 仅用于调用工具：每次都是全新的环境，不能直接读写文件、访问网络或执行命令，这些操作均须通过 tools 调用工具完成。
- 脚本在 async 函数中执行，可以使用 await 和 return。调用工具的写法为 await tools.工具名({ 参数 })，返回值类型见下方的声明。工具出错时抛出 Error，可用 try/catch 处理。互不依赖的调用可用 Promise.all 并行执行；每一项需要依次调用多次时，各项之间也可并行执行。
- 用 console.log 输出；return 的值也会输出，非字符串时转换为 JSON。输出中包含工具返回的图片时，图片附在结果之后供你查看，最多 ${MAX_IMAGES} 张。
- 脚本中的调用与直接调用相同：需要审批时会等待用户审批，用户拒绝时抛出 Error。
- 执行超过 ${BACKGROUND_AFTER_MS / 1000} 秒会转为后台任务，完成后结果会送达给你。`;

export interface IRunToolScriptDependencies {
	readonly tools: Tools;
	readonly executor: ToolExecutor;
}

/** 执行脚本，脚本里可以调用这个成员能用的工具。依赖延后取得：工具列表和执行器要先包含这个工具才能创建。 */
export function createRunToolScriptTool(dependencies: () => IRunToolScriptDependencies): ITool {
	return {
		name: NAME,
		label: '用脚本调用工具',
		description: DESCRIPTION,
		parameters: {
			type: 'object',
			properties: {
				script: { type: 'string', description: 'JavaScript 脚本' },
				timeout_ms: { type: 'integer', minimum: 1, maximum: MAX_TIMEOUT_MS, description: `最长执行时间（毫秒），到时即终止脚本，与是否转为后台任务无关。默认 ${DEFAULT_TIMEOUT_MS}，最大 ${MAX_TIMEOUT_MS}。等待审批的时间不计入` },
			},
			required: ['script'],
			additionalProperties: false,
		},
		defaultPolicy: 'allow',
		approvable: false,
		background: true,
		describe(memberId) {
			const tools = dependencies().tools.available(memberId).filter(tool => tool.name !== NAME);
			return `${DESCRIPTION}\n\n脚本中可用的工具：\n\`\`\`ts\n${declareTools(tools)}\n\`\`\``;
		},
		async execute(context, args) {
			const script = args['script'];
			if (typeof script !== 'string' || !script.trim()) throw invalid('script 不能为空');
			const timeoutMs = args['timeout_ms'] ?? DEFAULT_TIMEOUT_MS;
			if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
				throw invalid(`timeout_ms 必须是 1 到 ${MAX_TIMEOUT_MS} 之间的整数`);
			}
			if (!context.call) throw invalid(`${NAME} 只能在运行中调用`);
			const { tools, executor } = dependencies();
			const available = tools.available(context.memberId).filter(tool => tool.name !== NAME);

			// 脚本结束、超时、运行中止或任务取消时，中止脚本和它还没完成的调用。
			const controller = new AbortController();
			const onAbort = () => controller.abort(context.signal.reason);
			context.signal.addEventListener('abort', onAbort, { once: true });
			const clock = context.clock ?? new ExecutionClock();
			const stopTimer = new AbortController();
			void clock.after(timeoutMs, stopTimer.signal).then(() => {
				if (!stopTimer.signal.aborted) controller.abort(new Error(`超时（${timeoutMs / 1000} 秒）`));
			});
			const nested: IToolContext = { ...context, signal: controller.signal, clock, inScript: true };
			const scope = new CodeScope();
			const images = new ScriptImages();
			const functions = new Map(available.map(tool => [tool.name, async (toolArgs: Record<string, unknown>) => {
				const result = await executor.callInCode(nested, scope, tool.name, toolArgs);
				if (result.isError) throw new Error(result.output);
				const value = result.value ?? result.output;
				images.collect(value);
				return value;
			}]));
			try {
				// 纯 JS 一直占着线程时计时器不会触发，所以 CPU 时间也不能超过超时时间。
				const cpuLimitMs = Math.min(CPU_LIMIT_MS, timeoutMs);
				const result = await runScript({
					code: script, functions, cpuLimitMs, memoryLimitBytes: MEMORY_LIMIT_BYTES, signal: controller.signal, replace: value => images.replace(value),
				});
				if (!result.ok) throw invalid(result.output);
				return images.attach(result.output);
			} finally {
				stopTimer.abort();
				context.signal.removeEventListener('abort', onAbort);
				controller.abort(new Error('脚本已结束'));
			}
		},
	};
}

/**
 * 脚本里的图片：只认这段脚本里工具返回过的图片，脚本自己拼出来的地址不认。
 * 输出里的图片换成「[图片 N：来源]」，按编号附在结果后面；同一张图只附一次，超出上限的注明没有附上。
 */
class ScriptImages {
	/** 工具返回过的图片：资源 ID 到来源。来源用工具返回时的，脚本改了也不影响。 */
	private readonly returned = new Map<string, string | undefined>();
	/** 输出里出现的图片：资源 ID 到编号。 */
	private readonly numbers = new Map<string, number>();

	collect(value: unknown): void {
		const id = imageResourceId(value);
		if (id !== undefined) {
			const source = (value as { source?: unknown }).source;
			if (!this.returned.get(id)) this.returned.set(id, typeof source === 'string' && source ? source : undefined);
		} else if (Array.isArray(value)) {
			value.forEach(item => this.collect(item));
		} else if (typeof value === 'object' && value !== null) {
			Object.values(value).forEach(item => this.collect(item));
		}
	}

	replace(value: unknown): string | undefined {
		const id = imageResourceId(value);
		if (id === undefined || !this.returned.has(id)) return undefined;
		let number = this.numbers.get(id);
		if (number === undefined) this.numbers.set(id, number = this.numbers.size + 1);
		const source = this.returned.get(id);
		return `[图片 ${number}${source ? `：${source}` : ''}${number > MAX_IMAGES ? '，未附上' : ''}]`;
	}

	attach(output: string): IToolText {
		const ids = [...this.numbers.keys()];
		const omitted = ids.length - MAX_IMAGES;
		const note = omitted > 0 ? `\n\n[最多附上 ${MAX_IMAGES} 张图片，另有 ${omitted} 张未附上，需要时可直接调用相应的工具查看]` : '';
		return { text: output + note, images: ids.slice(0, MAX_IMAGES).map(resourceImage) };
	}
}

/** 脚本里的图片类型：模型接口的图片输入，加上说明来源的 source 和存图片的文件 path。 */
const INPUT_IMAGE_DECLARATION = [
	'/** 工具返回的图片。image_url 是图片的引用，脚本中无法读取其内容；source 说明图片来源，如本地文件路径、PDF 路径加页码；path 是图片的本地文件路径，需要使用文件时（如作为附件发送）使用它。通过 return 或 console.log 输出的图片会附在结果中供你查看。 */',
	"type InputImage = { type: 'input_image'; image_url: string; detail: 'auto'; source: string; path: string };",
].join('\n');

/** 按工具的定义生成 TypeScript 风格的声明，让模型知道脚本里怎么调用、会返回什么。 */
function declareTools(tools: readonly ITool[]): string {
	const lines = [INPUT_IMAGE_DECLARATION, '', 'declare const tools: {'];
	// 工具和参数的说明都在直接调用的定义里，这里只写参数和返回的类型。渐进式工具只列名字，参数和返回类型用 more_tools 查；
	// 脚本里可以直接调用渐进式工具，不用写 more_tools。
	for (const tool of tools.filter(item => !item.progressive && item.name !== MORE_TOOLS_NAME)) {
		lines.push(`\t${tool.name}(args: ${declareType(tool.parameters, 1, false)}): Promise<${tool.returns ?? 'string'}>;`);
	}
	lines.push('};');
	const progressive = tools.filter(item => item.progressive).map(item => item.name);
	if (progressive.length > 0) lines.push(`// 还可调用以下工具，调用前先用 more_tools 的 describe 查看参数和返回类型：${progressive.join('、')}`);
	return lines.join('\n');
}

/** JSON Schema 写成 TypeScript 类型；comments 为 true 时字段的 description 写成注释。 */
export function declareType(schema: unknown, depth: number, comments = true): string {
	if (typeof schema !== 'object' || schema === null) return 'unknown';
	const { type, enum: values, items, properties, required } = schema as Record<string, unknown>;
	if (Array.isArray(values)) return values.map(value => JSON.stringify(value)).join(' | ');
	if (Array.isArray(type)) return type.map(item => declareType({ ...schema, type: item }, depth, comments)).join(' | ');
	switch (type) {
		case 'string': return 'string';
		case 'integer':
		case 'number': return 'number';
		case 'boolean': return 'boolean';
		case 'null': return 'null';
		case 'array': return `Array<${declareType(items, depth, comments)}>`;
		case 'object': {
			if (typeof properties !== 'object' || properties === null) return 'Record<string, unknown>';
			const requiredNames = new Set(Array.isArray(required) ? required : []);
			const indent = '\t'.repeat(depth + 1);
			const fields = Object.entries(properties).map(([name, property]) => {
				const description = (property as { description?: unknown }).description;
				const comment = comments && typeof description === 'string' ? ` // ${description.replace(/\s*\n\s*/g, ' ')}` : '';
				return `${indent}${name}${requiredNames.has(name) ? '' : '?'}: ${declareType(property, depth + 1, comments)};${comment}`;
			});
			return fields.length === 0 ? '{}' : `{\n${fields.join('\n')}\n${'\t'.repeat(depth)}}`;
		}
		default: return 'unknown';
	}
}
