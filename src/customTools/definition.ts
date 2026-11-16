import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isRecord, readJsonFile } from '../common/json.ts';
import { contains } from '../tools/paths.ts';
import type { ToolPolicy } from '../tools/tools.ts';

export const TOOL_FILE = 'tool.json';
/** 成员文件 tools 里写的名字是这个前缀加文件夹名，审批方式也记在这个名字下。 */
export const CUSTOM_PREFIX = 'custom:';
/** 自定义工具能选的审批方式。 */
export const CUSTOM_POLICIES: readonly ToolPolicy[] = ['ask', 'allow'];
/** 不写 timeoutSeconds 时最多运行多久。 */
const DEFAULT_TIMEOUT_SECONDS = 300;
const MAX_TIMEOUT_SECONDS = 7200;
const FOLDER_NAME = /^[a-z0-9_]{1,64}$/;
/** OpenAI 等接口要求工具名最长 64 个字符。 */
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const CONFIG_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/** 运行时用自己的 Node 执行的脚本。 */
const NODE_SCRIPT = /\.(js|mjs|ts)$/;

const TOP_FIELDS = ['label', 'description', 'defaultPolicy', 'config', 'tools'];
const TOOL_FIELDS = ['name', 'label', 'description', 'parameters', 'returns', 'script', 'command', 'timeoutSeconds', 'progressive'];
const CONFIG_FIELDS = ['name', 'type', 'label', 'description', 'required', 'default'];
const CONFIG_TYPES = ['text', 'secret', 'service'] as const;

export type ConfigType = typeof CONFIG_TYPES[number];

/** 要用户填的一项配置。 */
export interface IConfigField {
	readonly name: string;
	readonly type: ConfigType;
	readonly label: string;
	readonly description: string | null;
	readonly required: boolean;
	/** 只有 text 有。 */
	readonly default: string | null;
}

export interface ICustomToolDefinition {
	readonly name: string;
	readonly label: string;
	readonly description: string;
	readonly parameters: Record<string, unknown>;
	readonly returns: string | null;
	/** 执行的程序和参数：脚本用运行时自己的 Node 执行。 */
	readonly command: readonly string[];
	readonly timeoutSeconds: number;
	readonly progressive: boolean;
}

/** 一个文件夹：设置里的一项。 */
export interface ICustomToolFolder {
	readonly label: string;
	readonly description: string;
	readonly defaultPolicy: 'ask' | 'allow';
	readonly config: readonly IConfigField[];
	readonly tools: readonly ICustomToolDefinition[];
}

/** 文件夹名不合规时返回原因。 */
export function folderNameProblem(name: string): string | undefined {
	return FOLDER_NAME.test(name) ? undefined : `文件夹名「${name}」只能包含小写字母、数字和下划线，最长 64 个字符`;
}

/** 读一个文件夹的 tool.json，检查后返回；有错时报错，错误信息就是原因。 */
export function readFolder(directory: string): ICustomToolFolder {
	const path = join(directory, TOOL_FILE);
	if (!existsSync(path)) throw new Error(`缺少 ${TOOL_FILE}`);
	let value: unknown;
	try {
		value = readJsonFile(path);
	} catch {
		throw new Error(`${TOOL_FILE} 不是合法的 JSON`);
	}
	return parseFolder(value, directory);
}

function parseFolder(value: unknown, directory: string): ICustomToolFolder {
	if (!isRecord(value)) throw new Error(`${TOOL_FILE} 必须是一个对象`);
	unknownFields(value, TOP_FIELDS, '');
	const label = text(value, 'label', '');
	const description = optionalText(value, 'description', '') ?? '';
	const policy = value['defaultPolicy'] ?? 'ask';
	if (policy !== 'ask' && policy !== 'allow') throw new Error('defaultPolicy 只能是 ask 或 allow');
	const configValue = value['config'] ?? [];
	if (!Array.isArray(configValue)) throw new Error('config 必须是数组');
	const config = configValue.map((item: unknown, index) => parseConfigField(item, `config[${index}]`));
	duplicate(config.map(field => field.name), '配置项');
	const toolsValue = value['tools'];
	if (!Array.isArray(toolsValue) || toolsValue.length === 0) throw new Error('tools 必须是非空数组');
	const tools = toolsValue.map((item: unknown, index) => parseTool(item, `tools[${index}]`, directory));
	duplicate(tools.map(tool => tool.name), '工具名');
	return { label, description, defaultPolicy: policy, config, tools };
}

function parseConfigField(value: unknown, path: string): IConfigField {
	if (!isRecord(value)) throw new Error(`${path} 必须是对象`);
	unknownFields(value, CONFIG_FIELDS, `${path}.`);
	const name = text(value, 'name', path);
	if (!CONFIG_NAME.test(name)) throw new Error(`${path}.name 只能包含英文字母、数字和下划线，且不能以数字开头`);
	const type = value['type'];
	if (!CONFIG_TYPES.includes(type as ConfigType)) throw new Error(`${path}.type 只能是 ${CONFIG_TYPES.join('、')}`);
	const required = value['required'] ?? false;
	if (typeof required !== 'boolean') throw new Error(`${path}.required 必须是 true 或 false`);
	const fallback = optionalText(value, 'default', path) ?? null;
	if (fallback !== null && type !== 'text') throw new Error(`${path}.default 仅适用于 text 类型`);
	return { name, type: type as ConfigType, label: text(value, 'label', path), description: optionalText(value, 'description', path) ?? null, required, default: fallback };
}

function parseTool(value: unknown, path: string, directory: string): ICustomToolDefinition {
	if (!isRecord(value)) throw new Error(`${path} 必须是对象`);
	unknownFields(value, TOOL_FIELDS, `${path}.`);
	const name = text(value, 'name', path);
	if (!TOOL_NAME.test(name)) throw new Error(`${path}.name「${name}」只能包含小写字母、数字和下划线，须以字母开头，最长 64 个字符`);
	const parameters = value['parameters'];
	if (!isRecord(parameters) || parameters['type'] !== 'object') throw new Error(`${path}.parameters 须为 type 为 object 的 JSON Schema 对象`);
	const timeout = value['timeoutSeconds'] ?? DEFAULT_TIMEOUT_SECONDS;
	if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_SECONDS) {
		throw new Error(`${path}.timeoutSeconds 必须是 1 到 ${MAX_TIMEOUT_SECONDS} 的整数`);
	}
	const progressive = value['progressive'] ?? false;
	if (typeof progressive !== 'boolean') throw new Error(`${path}.progressive 必须是 true 或 false`);
	return {
		name, label: text(value, 'label', path), description: text(value, 'description', path), parameters,
		returns: optionalText(value, 'returns', path) ?? null, command: command(value, path, directory), timeoutSeconds: timeout, progressive,
	};
}

/** script 用运行时自己的 Node 执行；别的语言写 command，在文件夹里执行。两个只能写一个。 */
function command(value: Record<string, unknown>, path: string, directory: string): string[] {
	const script = value['script'];
	const custom = value['command'];
	if ((script === undefined) === (custom === undefined)) throw new Error(`${path} 须填写 script 或 command，且只能填写其中一个`);
	if (custom !== undefined) {
		if (!Array.isArray(custom) || custom.length === 0 || !custom.every(item => typeof item === 'string' && item)) {
			throw new Error(`${path}.command 必须是非空的字符串数组，如 ["python", "search.py"]`);
		}
		return custom as string[];
	}
	if (typeof script !== 'string' || !NODE_SCRIPT.test(script)) throw new Error(`${path}.script 必须是 .js、.mjs 或 .ts 文件；其他语言请使用 command`);
	const absolute = resolve(directory, script);
	if (absolute === resolve(directory) || !contains(directory, absolute)) throw new Error(`${path}.script 须位于工具文件夹内`);
	if (!existsSync(absolute) || !statSync(absolute).isFile()) throw new Error(`脚本 ${script} 不存在`);
	return [process.execPath, '--disable-warning=ExperimentalWarning', absolute];
}

function text(value: Record<string, unknown>, key: string, path: string): string {
	const item = value[key];
	if (typeof item !== 'string' || !item.trim()) throw new Error(`${path ? `${path}.` : ''}${key} 必须是非空字符串`);
	return item.trim();
}

function optionalText(value: Record<string, unknown>, key: string, path: string): string | undefined {
	return value[key] === undefined ? undefined : text(value, key, path);
}

function duplicate(names: readonly string[], what: string): void {
	const repeated = names.find((name, index) => names.indexOf(name) !== index);
	if (repeated) throw new Error(`${what}重复：${repeated}`);
}

function unknownFields(value: Record<string, unknown>, fields: readonly string[], path: string): void {
	const unknown = Object.keys(value).filter(key => !fields.includes(key));
	if (unknown.length > 0) throw new Error(`无法识别的字段 ${unknown.map(key => path + key).join('、')}；可用字段：${fields.join('、')}`);
}
