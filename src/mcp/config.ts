import { existsSync, writeFileSync } from 'node:fs';
import { errorMessage, invalid } from '../common/errors.ts';
import { isRecord, readJsonFile } from '../common/json.ts';
import type { Secrets } from '../common/secrets.ts';

const NAME_MAX_LENGTH = 32;
/** 成员 tools 里写 mcp:<服务器名> 启用一个服务器的全部工具。 */
export const MCP_PREFIX = 'mcp:';

/** 停用的服务器不启动、不连接，成员用不了它的工具，作为外部事件的来源也不收事件。 */
interface IServerBase {
	readonly disabled: boolean;
}

/** 本地命令，用 stdio 连接。 */
export interface IStdioServerConfig extends IServerBase {
	readonly command: string;
	readonly args: readonly string[];
	readonly env: Readonly<Record<string, string>>;
	readonly cwd: string | null;
}

/** 远程地址，用 Streamable HTTP 连接。 */
export interface IHttpServerConfig extends IServerBase {
	readonly url: string;
	readonly headers: Readonly<Record<string, string>>;
}

/** 运行时内置的事件来源。 */
export const BUILTIN_SOURCES = ['github', 'feishu'] as const;
export type BuiltinSource = typeof BUILTIN_SOURCES[number];

/** 内置事件来源：运行时用自己的 node 执行它的脚本，用 stdio 连接。 */
export interface IBuiltinServerConfig extends IServerBase {
	readonly builtin: BuiltinSource;
	readonly env: Readonly<Record<string, string>>;
}

export type McpServerConfig = IStdioServerConfig | IHttpServerConfig | IBuiltinServerConfig;

/** 配置文件里的一个服务器：读好的配置，或者写错的原因。 */
export type McpServerEntry = { readonly config: McpServerConfig } | { readonly problem: string };

export interface IMcpConfig {
	readonly servers: ReadonlyMap<string, McpServerEntry>;
	/** 整个文件读不了的原因。 */
	readonly error: string | null;
}

export function isStdio(config: McpServerConfig): config is IStdioServerConfig {
	return 'command' in config;
}

export function isBuiltin(config: McpServerConfig): config is IBuiltinServerConfig {
	return 'builtin' in config;
}

/** 服务器名的问题：会写进工具名和成员文件，只能用英文字母、数字、横杠和下划线。 */
export function mcpNameProblem(name: string): string | undefined {
	if (!/^[A-Za-z0-9_-]+$/.test(name)) return `MCP 服务器名「${name}」只能包含英文字母、数字、横杠和下划线`;
	if (name.length > NAME_MAX_LENGTH) return `MCP 服务器名「${name}」过长，最长 ${NAME_MAX_LENGTH} 个字符`;
	return undefined;
}

/** 工具名里用的写法：英文字母、数字和下划线以外的字符换成下划线。 */
export function identifier(name: string): string {
	return name.replace(/[^A-Za-z0-9_]/g, '_');
}

/** 读 mcp.json；没有文件时没有服务器。每个服务器单独检查，写错的记下原因。 */
export function readMcpConfig(path: string | undefined): IMcpConfig {
	const servers = new Map<string, McpServerEntry>();
	if (!path || !existsSync(path)) return { servers, error: null };
	let parsed: unknown;
	try {
		parsed = readJsonFile(path);
	} catch (error) {
		return { servers, error: `mcp.json 不是合法的 JSON：${errorMessage(error)}` };
	}
	const entries = isRecord(parsed) ? parsed['mcpServers'] : undefined;
	if (!isRecord(entries)) return { servers, error: 'mcp.json 中须包含 mcpServers 对象' };
	const identifiers = new Map<string, string>();
	for (const [name, value] of Object.entries(entries)) {
		const problem = mcpNameProblem(name);
		const other = identifiers.get(identifier(name).toLowerCase());
		identifiers.set(identifier(name).toLowerCase(), name);
		if (problem) servers.set(name, { problem });
		else if (other !== undefined) servers.set(name, { problem: `与「${other}」仅大小写、横杠或下划线不同，会导致工具名重复` });
		else {
			try {
				servers.set(name, { config: parseServer(value) });
			} catch (error) {
				servers.set(name, { problem: errorMessage(error) });
			}
		}
	}
	return { servers, error: null };
}

/** 检查一个服务器的配置。也用来检查接口传来的配置。 */
export function parseServer(value: unknown): McpServerConfig {
	if (!isRecord(value)) throw invalid('配置必须是对象');
	const disabled = value['disabled'] ?? false;
	if (typeof disabled !== 'boolean') throw invalid('disabled 必须是 true 或 false');
	const type = value['type'];
	if (value['builtin'] !== undefined) {
		const builtin = value['builtin'];
		if (!BUILTIN_SOURCES.includes(builtin as BuiltinSource)) throw invalid(`builtin 只能是 ${BUILTIN_SOURCES.join('、')}`);
		if (value['command'] !== undefined || value['url'] !== undefined) throw invalid('填写 builtin 时不能再填写 command 或 url');
		return { builtin: builtin as BuiltinSource, env: stringRecord(value['env'], 'env'), disabled };
	}
	if (type === 'sse') throw invalid('不支持旧版 HTTP+SSE 传输，请改用 Streamable HTTP 地址');
	if (value['url'] !== undefined) {
		if (type !== undefined && !['http', 'streamable-http', 'streamableHttp'].includes(type as string)) throw invalid(`type「${String(type)}」与 url 不匹配`);
		const url = value['url'];
		if (typeof url !== 'string' || !/^https?:\/\//i.test(url.trim())) throw invalid('url 必须是 http:// 或 https:// 开头的地址');
		return { url: url.trim(), headers: stringRecord(value['headers'], 'headers'), disabled };
	}
	if (type !== undefined && type !== 'stdio') throw invalid(`无法识别的 type「${String(type)}」`);
	const command = value['command'];
	if (typeof command !== 'string' || !command.trim()) throw invalid('须填写 command（本地命令）或 url（远程地址）');
	const args = value['args'] ?? [];
	if (!Array.isArray(args) || !args.every(arg => typeof arg === 'string')) throw invalid('args 必须是字符串数组');
	const cwd = value['cwd'] ?? null;
	if (cwd !== null && (typeof cwd !== 'string' || !cwd.trim())) throw invalid('cwd 必须是路径');
	return { command: command.trim(), args, env: stringRecord(value['env'], 'env'), cwd: cwd === null ? null : cwd.trim(), disabled };
}

/** 新建或修改一个服务器，env、headers 的值加密后写进去；其他服务器和文件里的其他内容原样保留。 */
export function writeMcpServer(path: string, name: string, config: McpServerConfig | null, secrets: Secrets): void {
	let parsed: Record<string, unknown> = {};
	if (existsSync(path)) {
		try {
			const value: unknown = readJsonFile(path);
			if (isRecord(value)) parsed = value;
		} catch {
			throw invalid('mcp.json 不是合法的 JSON，请先修正文件后再在此处修改');
		}
	}
	const servers = { ...isRecord(parsed['mcpServers']) ? parsed['mcpServers'] : {} };
	if (config) servers[name] = serialize(config, secrets);
	else delete servers[name];
	writeFileSync(path, `${JSON.stringify({ ...parsed, mcpServers: servers }, null, '\t')}\n`);
}

/** 配置文件里 env、headers 有明文的值时加密后写回，只换这些值。文件读不了、写不回去时不管，照常读取。 */
export function encryptMcpConfig(path: string | undefined, secrets: Secrets): void {
	if (!path || !existsSync(path)) return;
	try {
		const parsed: unknown = readJsonFile(path);
		if (!isRecord(parsed) || !isRecord(parsed['mcpServers'])) return;
		let changed = false;
		const servers = Object.fromEntries(Object.entries(parsed['mcpServers']).map(([name, server]) => {
			if (!isRecord(server)) return [name, server];
			const next = { ...server };
			for (const key of ['env', 'headers']) {
				const values = server[key];
				const encrypted = isRecord(values) ? secrets.encryptValues(values) : undefined;
				if (!encrypted) continue;
				next[key] = encrypted;
				changed = true;
			}
			return [name, next];
		}));
		if (changed) writeFileSync(path, `${JSON.stringify({ ...parsed, mcpServers: servers }, null, '\t')}\n`);
	} catch (error) {
		console.error('加密 mcp.json 中的值失败：', error);
	}
}

/** 服务器的 env 或 headers：本地命令和内置事件来源是 env，远程地址是 headers。 */
export function secretValues(config: McpServerConfig): Readonly<Record<string, string>> {
	return isStdio(config) || isBuiltin(config) ? config.env : config.headers;
}

function serialize(config: McpServerConfig, secrets: Secrets): Record<string, unknown> {
	const disabled = config.disabled && { disabled: true };
	const values = secretValues(config);
	const encrypted = Object.keys(values).length > 0 ? secrets.encryptValues(values) ?? values : undefined;
	if (isBuiltin(config)) return { builtin: config.builtin, ...encrypted && { env: encrypted }, ...disabled };
	if (!isStdio(config)) return { url: config.url, ...encrypted && { headers: encrypted }, ...disabled };
	return {
		command: config.command,
		...config.args.length > 0 && { args: config.args },
		...encrypted && { env: encrypted },
		...config.cwd !== null && { cwd: config.cwd },
		...disabled,
	};
}

function stringRecord(value: unknown, key: string): Record<string, string> {
	if (value === undefined || value === null) return {};
	if (!isRecord(value) || !Object.values(value).every(item => typeof item === 'string')) throw invalid(`${key} 必须是以名称为键、字符串为值的对象`);
	return value as Record<string, string>;
}
