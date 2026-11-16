import { watch, type FSWatcher } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { Client, SdkError, SdkErrorCode, StreamableHTTPClientTransport, type CallToolResult, type Tool } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { errorMessage, invalid, notFound } from '../common/errors.ts';
import { isRecord, readJsonFile } from '../common/json.ts';
import { undecryptable, type Secrets } from '../common/secrets.ts';
import { clipEnd } from '../common/text.ts';
import type { Resources } from '../resources/resources.ts';
import { declareType } from '../tools/runToolScript.ts';
import { NO_STRUCTURED_RETURNS, toolResultHandler } from '../tools/toolResult.ts';
import type { IAutoPolicy, ITool, IToolGroup } from '../tools/tools.ts';
import {
	encryptMcpConfig, identifier, isBuiltin, isStdio, MCP_PREFIX, mcpNameProblem, parseServer, readMcpConfig, secretValues, writeMcpServer,
	type BuiltinSource, type McpServerConfig, type McpServerEntry,
} from './config.ts';

/** 连接时报给服务器的客户端名字和版本，和 package.json 一致。 */
const CLIENT_INFO = { name: 'reman-runtime', version: (readJsonFile(fileURLToPath(new URL('../../package.json', import.meta.url))) as { version: string }).version };
const AUTO_POLICY: IAutoPolicy = { label: '只读操作免审批', description: '服务器标记为只读的工具直接执行，其他工具均须审批' };
/** 连接（包括取工具列表）最多等多久。 */
const CONNECT_TIMEOUT_MS = 60 * 1000;
/** HTTP 服务器先按新版协议试探，多久没回应就当作连不上。 */
const PROBE_TIMEOUT_MS = 10 * 1000;
/** 一次调用最多等多久；服务器报告进度时重新计时。超过等待时间会先转为后台任务。 */
const CALL_TIMEOUT_MS = 30 * 60 * 1000;
/** 连接失败时附上本地命令最后输出的多少错误信息。 */
const STDERR_CHARS = 2000;
/** 来源的一条警告（stderr 的一行）最多记多少字。 */
const WARNING_CHARS = 1000;
/** OpenAI 等接口要求工具名最长 64 个字符。 */
const TOOL_NAME_MAX_LENGTH = 64;
const WATCH_DEBOUNCE_MS = 300;
/** 外部事件的来源断了或连不上时，隔多久重连：依次用，用完了一直用最后一个；连上后从头算。 */
const RECONNECT_DELAYS_MS = [5_000, 30_000, 5 * 60_000, 30 * 60_000];
/** 外部事件的来源声明的能力和推送事件用的通知（Claude Code channels 的约定）。 */
const CHANNEL_CAPABILITY = 'claude/channel';
const CHANNEL_NOTIFICATION = 'notifications/claude/channel';

export type McpStatus = 'disabled' | 'connecting' | 'connected' | 'failed';

/** 声明了 claude/channel 能力的服务器是外部事件的来源：推来的事件、连接的变化和警告交给它。 */
export interface IChannelListener {
	/** params 是服务器推来的原样参数，由收的一方检查。 */
	event(source: string, params: unknown): void;
	status(source: string, status: 'connected' | 'disconnected' | 'failed', error: string | null): void;
	/** 来源连上以后写到 stderr 的一行。 */
	warning(source: string, text: string): void;
}

export interface IMcpToolInfo {
	/** 服务器上的工具名。 */
	readonly name: string;
	/** 成员调用时用的工具名。 */
	readonly toolName: string;
	readonly description: string;
	readonly readOnly: boolean;
}

export interface IMcpServerInfo {
	readonly name: string;
	readonly transport: 'stdio' | 'http' | null;
	/** 内置事件来源；其他服务器是 null。 */
	readonly builtin: BuiltinSource | null;
	readonly command: string | null;
	readonly args: readonly string[];
	readonly cwd: string | null;
	/** 环境变量和请求头只给名字，不给值。 */
	readonly envNames: readonly string[];
	readonly url: string | null;
	readonly headerNames: readonly string[];
	/** 加密保存、解不开的环境变量或请求头的名字，要重新填写。 */
	readonly undecryptableNames: readonly string[];
	readonly status: McpStatus;
	readonly error: string | null;
	/** 声明了 claude/channel 能力，是外部事件的来源。没连上过时是 false。 */
	readonly channel: boolean;
	readonly tools: readonly IMcpToolInfo[];
}

export interface IMcpSnapshot {
	/** 配置文件的路径。 */
	readonly path: string | null;
	/** 整个配置文件读不了的原因。 */
	readonly error: string | null;
	readonly servers: readonly IMcpServerInfo[];
}

/** 接口传来的服务器配置：env、headers 里值为 null 的沿用原来的值。 */
export type McpServerInput = Record<string, unknown>;

/**
 * mcp.json 里配置的 MCP 服务器。每个服务器一个连接，所有成员共用；每个服务器的工具是一个工具组，成员按组开关。
 * env、headers 的值加密保存，连接时解密。
 * onChange：状态或工具变了；onServersChange：服务器增减了（成员文件夹的警告要跟着更新）。
 */
export class McpServers {
	readonly path: string | undefined;
	private readonly sourcesDirectory: string;
	private readonly resources: Resources;
	private readonly outputsDirectory: string;
	private readonly secrets: Secrets;
	private readonly onChange: () => void;
	private readonly onServersChange: () => void;
	private readonly channels: IChannelListener | undefined;
	private connections = new Map<string, Connection>();
	private error: string | null = null;
	private watcher: FSWatcher | undefined;
	private timer: NodeJS.Timeout | undefined;

	/** sourcesDirectory：内置事件来源的状态，每个来源一个文件夹；outputsDirectory：过长的工具结果存成文件，每个服务器一个子目录。 */
	constructor(
		path: string | undefined, sourcesDirectory: string, resources: Resources, outputsDirectory: string, secrets: Secrets, onChange: () => void, onServersChange: () => void, channels?: IChannelListener,
	) {
		this.path = path;
		this.sourcesDirectory = sourcesDirectory;
		this.resources = resources;
		this.outputsDirectory = outputsDirectory;
		this.secrets = secrets;
		this.onChange = onChange;
		this.onServersChange = onServersChange;
		this.channels = channels;
	}

	/** 重新读配置文件：明文的值先加密写回；去掉删掉的服务器，重连改过的，连接新加的。 */
	reload(): void {
		encryptMcpConfig(this.path, this.secrets);
		const config = readMcpConfig(this.path);
		this.error = config.error;
		const before = [...this.connections.keys()].join('\n');
		const next = new Map<string, Connection>();
		for (const [name, entry] of config.servers) {
			const existing = this.connections.get(name);
			if (existing && existing.sameEntry(entry)) {
				next.set(name, existing);
				continue;
			}
			existing?.close();
			const connection = new Connection(name, entry, join(this.sourcesDirectory, name), this.resources, join(this.outputsDirectory, name), this.secrets, () => this.onChange(), this.channels);
			next.set(name, connection);
			void connection.connect();
		}
		for (const [name, connection] of this.connections) if (!next.has(name)) connection.close();
		this.connections = next;
		this.onChange();
		if ([...next.keys()].join('\n') !== before) this.onServersChange();
	}

	snapshot(): IMcpSnapshot {
		return { path: this.path ?? null, error: this.error, servers: [...this.connections.values()].map(connection => connection.info()) };
	}

	/** 每个服务器的工具组。连接失败的服务器保留上次取到的工具，调用时再重连。 */
	groups(): IToolGroup[] {
		return [...this.connections.values()].map(connection => connection.group());
	}

	/** 新建或修改一个服务器，写进配置文件。沿用的值是原来保存的（加密后的）值。 */
	update(name: string, input: McpServerInput): void {
		if (!this.path) throw invalid('缺少配置文件');
		const problem = mcpNameProblem(name);
		if (problem) throw invalid(problem);
		const clash = [...this.connections.keys()].find(other => other !== name && identifier(other).toLowerCase() === identifier(name).toLowerCase());
		if (clash) throw invalid(`与「${clash}」仅大小写、横杠或下划线不同，会导致工具名重复`);
		const previous = this.connections.get(name)?.config;
		const keep = (key: 'env' | 'headers') => {
			const value = input[key];
			if (!isRecord(value)) return value;
			const old: Readonly<Record<string, string>> = !previous ? {} : key === 'env' ? ('env' in previous ? previous.env : {}) : ('headers' in previous ? previous.headers : {});
			return Object.fromEntries(Object.entries(value).map(([field, item]) => [field, item === null ? old[field] : item]).filter(([, item]) => item !== undefined));
		};
		// 没说启用还是停用时沿用原来的。
		const config = parseServer({ ...input, env: keep('env'), headers: keep('headers'), disabled: input['disabled'] ?? previous?.disabled });
		writeMcpServer(this.path, name, config, this.secrets);
		this.reload();
	}

	/** 启用或停用一个服务器，写进配置文件。停用的不启动进程，启用时再连接。 */
	setDisabled(name: string, disabled: boolean): void {
		if (!this.path) throw invalid('缺少配置文件');
		const connection = this.connections.get(name);
		if (!connection) throw notFound(`不存在 MCP 服务器 ${name}`);
		const config = connection.config;
		if (!config) throw invalid(`MCP 服务器 ${name} 的配置有误，请先修正配置`);
		writeMcpServer(this.path, name, { ...config, disabled }, this.secrets);
		this.reload();
	}

	remove(name: string): void {
		if (!this.path) throw invalid('缺少配置文件');
		if (!this.connections.has(name)) throw notFound(`不存在 MCP 服务器 ${name}`);
		writeMcpServer(this.path, name, null, this.secrets);
		this.reload();
	}

	reconnect(name: string): void {
		const connection = this.connections.get(name);
		if (!connection) throw notFound(`不存在 MCP 服务器 ${name}`);
		if (connection.config?.disabled) throw invalid(`MCP 服务器 ${name} 已停用`);
		void connection.connect();
	}

	/** 监听配置文件，改了自动重新读取。 */
	watch(): void {
		if (this.watcher || !this.path) return;
		const file = basename(this.path);
		this.watcher = watch(dirname(this.path), (_, changed) => {
			if (changed !== file) return;
			clearTimeout(this.timer);
			this.timer = setTimeout(() => {
				try {
					this.reload();
				} catch (error) {
					console.error('重新读取 MCP 配置失败：', error);
				}
			}, WATCH_DEBOUNCE_MS);
		});
		this.watcher.on('error', error => console.error('监听 MCP 配置失败：', error));
	}

	close(): void {
		clearTimeout(this.timer);
		this.watcher?.close();
		this.watcher = undefined;
		for (const connection of this.connections.values()) connection.close();
		this.connections.clear();
	}
}

/** 和一个 MCP 服务器的连接。 */
class Connection {
	readonly name: string;
	private readonly entry: McpServerEntry;
	/** 内置事件来源的状态文件夹。 */
	private readonly stateDirectory: string;
	private readonly resources: Resources;
	/** 过长的工具结果存成文件的目录。 */
	private readonly outputDirectory: string;
	private readonly secrets: Secrets;
	private readonly onChange: () => void;
	private readonly channels: IChannelListener | undefined;
	/** 解不开的环境变量或请求头的名字。 */
	private readonly undecryptableNames: readonly string[];
	private status: McpStatus = 'connecting';
	private error: string | null = null;
	private client: Client | undefined;
	private connecting: Promise<void> | undefined;
	/** 每次连接加一，旧连接的回调不再生效。 */
	private generation = 0;
	private closed = false;
	private stderr = '';
	/** stderr 里还没换行的部分。 */
	private stderrLine = '';
	private tools: readonly ITool[] = [];
	private toolInfos: readonly IMcpToolInfo[] = [];
	/** 最近一次连上时声明了 claude/channel 能力。连不上时沿用，断开、出错照样记给来源。 */
	private channel = false;
	/** 来源等着重连的计时器，和已经连续重连了几次。 */
	private reconnectTimer: NodeJS.Timeout | undefined;
	private reconnects = 0;

	constructor(name: string, entry: McpServerEntry, stateDirectory: string, resources: Resources, outputDirectory: string, secrets: Secrets, onChange: () => void, channels?: IChannelListener) {
		this.name = name;
		this.entry = entry;
		this.stateDirectory = stateDirectory;
		this.resources = resources;
		this.outputDirectory = outputDirectory;
		this.secrets = secrets;
		this.onChange = onChange;
		this.channels = channels;
		const values = 'config' in entry ? secretValues(entry.config) : {};
		this.undecryptableNames = Object.keys(values).filter(key => secrets.decrypt(values[key]!) === undefined);
		if ('problem' in entry) {
			this.status = 'failed';
			this.error = `配置有误：${entry.problem}`;
		} else {
			// 内置事件来源一定是外部事件的来源，还没连上过时连接失败也记给来源。
			this.channel = isBuiltin(entry.config);
			if (entry.config.disabled) this.status = 'disabled';
		}
	}

	get config(): McpServerConfig | undefined {
		return 'config' in this.entry ? this.entry.config : undefined;
	}

	sameEntry(entry: McpServerEntry): boolean {
		return JSON.stringify(entry) === JSON.stringify(this.entry);
	}

	info(): IMcpServerInfo {
		const config = this.config;
		const builtin = config && isBuiltin(config) ? config : undefined;
		const stdio = config && isStdio(config) ? config : undefined;
		const http = config && !isStdio(config) && !isBuiltin(config) ? config : undefined;
		return {
			name: this.name,
			transport: stdio || builtin ? 'stdio' : http ? 'http' : null,
			builtin: builtin?.builtin ?? null,
			command: stdio?.command ?? null,
			args: stdio?.args ?? [],
			cwd: stdio?.cwd ?? null,
			envNames: Object.keys(stdio?.env ?? builtin?.env ?? {}),
			url: http?.url ?? null,
			headerNames: Object.keys(http?.headers ?? {}),
			undecryptableNames: this.undecryptableNames,
			status: this.status,
			error: this.error,
			channel: this.channel,
			tools: this.toolInfos,
		};
	}

	group(): IToolGroup {
		const descriptions: Record<McpStatus, string> = {
			disabled: '已停用',
			connecting: '正在连接',
			connected: `${this.tools.length} 个工具`,
			failed: `连接失败：${this.error ?? ''}`,
		};
		return {
			name: `${MCP_PREFIX}${this.name}`, label: null, description: `MCP 服务器 ${this.name}，${descriptions[this.status]}`,
			policies: ['ask', 'auto', 'allow'], defaultPolicy: 'ask', autoPolicy: AUTO_POLICY, tools: this.tools, mcpServer: this.name, customTool: null,
		};
	}

	/** 连接并取工具列表。已经在连接时等那一次。停用的不连接。 */
	connect(): Promise<void> {
		if (this.closed || !this.config || this.config.disabled) return Promise.resolve();
		this.connecting ??= this.open().finally(() => this.connecting = undefined);
		return this.connecting;
	}

	async call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<CallToolResult> {
		if (this.status === 'disabled') throw invalid(`MCP 服务器 ${this.name} 已停用`);
		if (this.status !== 'connected') await this.connect();
		if (this.status !== 'connected' || !this.client) throw invalid(`MCP 服务器 ${this.name} 连接失败：${this.error ?? '未连接'}`);
		return await this.client.callTool({ name, arguments: args }, { signal, timeout: CALL_TIMEOUT_MS, resetTimeoutOnProgress: true }) as CallToolResult;
	}

	close(): void {
		this.closed = true;
		clearTimeout(this.reconnectTimer);
		this.generation++;
		void this.client?.close().catch(() => {});
		this.client = undefined;
	}

	private async open(): Promise<void> {
		const config = this.config!;
		const generation = ++this.generation;
		clearTimeout(this.reconnectTimer);
		this.reconnectTimer = undefined;
		void this.client?.close().catch(() => {});
		this.client = undefined;
		this.status = 'connecting';
		this.error = null;
		this.stderr = '';
		this.stderrLine = '';
		this.onChange();
		// 解不开的值当作没填：不启动，等用户重新填写。
		if (this.undecryptableNames.length > 0) {
			this.status = 'failed';
			this.error = undecryptable(this.undecryptableNames.join('、'));
			if (this.channel) this.channels?.status(this.name, 'failed', this.error);
			this.onChange();
			return;
		}
		const decrypt = (values: Readonly<Record<string, string>>) => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, this.secrets.decrypt(value)!]));
		const current = () => generation === this.generation && !this.closed;
		const client = new Client(CLIENT_INFO, {
			// stdio 服务器直接用旧版握手：SDK 试探新版协议时会用同样的命令多起一个进程，
			// 一启动就干活的服务器（如外部事件的来源）会被多启动一次，事件可能被那个马上关掉的进程收走。
			// HTTP 服务器在同一个连接上试探，不多起进程。
			versionNegotiation: isStdio(config) || isBuiltin(config) ? { mode: 'legacy' } : { mode: 'auto', probe: { timeoutMs: PROBE_TIMEOUT_MS } },
			// 需要用户补充信息的调用（多轮请求）暂不支持，直接报错。
			inputRequired: { autoFulfill: false },
			listChanged: {
				tools: {
					onChanged: (error, tools) => {
						if (!current() || error || !tools) return;
						this.setTools(tools);
						this.onChange();
					},
				},
			},
		});
		// 外部事件：只收声明了 claude/channel 能力的服务器推来的。
		client.fallbackNotificationHandler = async notification => {
			if (!current() || notification.method !== CHANNEL_NOTIFICATION || !isChannel(client)) return;
			this.channels?.event(this.name, notification.params);
		};
		try {
			let transport;
			if (isStdio(config) || isBuiltin(config)) {
				// 内置事件来源用运行时自己的 node 执行，状态文件夹作为参数传给它。
				const command = isBuiltin(config)
					? { command: process.execPath, args: ['--disable-warning=ExperimentalWarning', builtinScript(config.builtin), this.stateDirectory], cwd: undefined }
					: { command: config.command, args: [...config.args], cwd: config.cwd ?? undefined };
				const stdio = new StdioClientTransport({ ...command, env: { ...getDefaultEnvironment(), ...decrypt(config.env) }, stderr: 'pipe' });
				// 一个字的几个字节可能分在两段里。
				const decoder = new StringDecoder('utf8');
				stdio.stderr?.on('data', (chunk: Buffer) => {
					if (!current()) return;
					const text = decoder.write(chunk);
					this.stderr = (this.stderr + text).slice(-STDERR_CHARS);
					this.warn(text);
				});
				transport = stdio;
			} else {
				transport = new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: decrypt(config.headers) } });
			}
			// 连接过程中断开的由下面的出错处理记下。
			client.onclose = () => {
				if (!current() || this.status !== 'connected') return;
				this.status = 'failed';
				this.error = `连接已断开${this.stderrHint()}`;
				this.client = undefined;
				if (this.channel) this.channels?.status(this.name, 'disconnected', this.error);
				this.scheduleReconnect();
				this.onChange();
			};
			await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
			// 服务器连上后就可能推事件，先认出是不是来源，再取工具列表。
			this.channel = isChannel(client);
			// 只推事件的来源没有工具。
			const { tools } = client.getServerCapabilities()?.tools ? await client.listTools(undefined, { timeout: CONNECT_TIMEOUT_MS }) : { tools: [] };
			if (!current()) {
				void client.close().catch(() => {});
				return;
			}
			this.client = client;
			this.setTools(tools);
			this.status = 'connected';
			this.reconnects = 0;
			if (this.channel) this.channels?.status(this.name, 'connected', null);
		} catch (error) {
			void client.close().catch(() => {});
			if (!current()) return;
			this.status = 'failed';
			const closed = error instanceof SdkError && error.code === SdkErrorCode.ConnectionClosed;
			this.error = `${closed ? '连接已断开' : errorMessage(error)}${this.stderrHint()}`;
			if (this.channel) this.channels?.status(this.name, 'failed', this.error);
			this.scheduleReconnect();
		}
		this.onChange();
	}

	/**
	 * 外部事件的来源断了或连不上时过一阵自己重连。别的服务器等下次调用时重连；来源只推事件，多半没有工具，等不到调用。
	 * 还没连上过的普通服务器不知道是不是来源，不重连；解不开的密钥要用户重新填，重连也没用。
	 */
	private scheduleReconnect(): void {
		if (this.closed || !this.channel || this.undecryptableNames.length > 0 || this.config?.disabled) return;
		clearTimeout(this.reconnectTimer);
		const delay = RECONNECT_DELAYS_MS[Math.min(this.reconnects, RECONNECT_DELAYS_MS.length - 1)]!;
		this.reconnects++;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined;
			void this.connect();
		}, delay);
		this.reconnectTimer.unref();
	}

	private stderrHint(): string {
		const text = this.stderr.trim();
		return text ? `\n${text}` : '';
	}

	/** 来源连上以后写到 stderr 的每一行是一条警告；连上之前的只在连接失败时附在错误里。还没换行的部分等下次。 */
	private warn(text: string): void {
		const lines = (this.stderrLine + text).split('\n');
		this.stderrLine = lines.pop()!.slice(0, WARNING_CHARS);
		if (this.status !== 'connected' || !this.channel) return;
		for (const line of lines) {
			const trimmed = line.trim();
			if (trimmed) this.channels?.warning(this.name, clipEnd(trimmed, WARNING_CHARS));
		}
	}

	/** 把服务器的工具转成成员的工具。工具名去重，太长时截短。 */
	private setTools(tools: readonly Tool[]): void {
		const used = new Set<string>();
		const converted: ITool[] = [];
		const infos: IMcpToolInfo[] = [];
		for (const tool of tools) {
			let name = `${identifier(this.name)}__${identifier(tool.name)}`.slice(0, TOOL_NAME_MAX_LENGTH);
			for (let index = 2; used.has(name); index++) name = `${name.slice(0, TOOL_NAME_MAX_LENGTH - String(index).length - 1)}_${index}`;
			used.add(name);
			const readOnly = tool.annotations?.readOnlyHint === true;
			converted.push(this.toTool(tool, name, readOnly));
			infos.push({ name: tool.name, toolName: name, description: tool.description ?? tool.title ?? '', readOnly });
		}
		this.tools = converted;
		this.toolInfos = infos;
	}

	private toTool(tool: Tool, name: string, readOnly: boolean): ITool<unknown> {
		const structured = tool.outputSchema !== undefined;
		const results = toolResultHandler(this.resources, name, structured, this.outputDirectory);
		return {
			name,
			group: `${MCP_PREFIX}${this.name}`,
			description: `${(tool.description ?? tool.title ?? '').trim() || tool.name}\n\n（MCP 服务器 ${this.name} 的工具 ${tool.name}${readOnly ? '，只读' : ''}）`,
			parameters: tool.inputSchema as Record<string, unknown>,
			defaultPolicy: 'ask',
			autoPolicy: AUTO_POLICY,
			needsApproval: () => readOnly ? undefined : '工具未标记为只读',
			progressive: true,
			background: true,
			returns: structured ? declareType(tool.outputSchema, 0) : NO_STRUCTURED_RETURNS,
			execute: async (context, args) => {
				let result: CallToolResult;
				try {
					result = await this.call(tool.name, args, context.signal);
				} catch (error) {
					throw invalid(`MCP 服务器 ${this.name}：${errorMessage(error)}`);
				}
				return results.value(result, 'MCP 工具返回了错误');
			},
			format: value => results.format(value),
		};
	}
}

function isChannel(client: Client): boolean {
	const experimental = client.getServerCapabilities()?.experimental;
	return typeof experimental?.[CHANNEL_CAPABILITY] === 'object' && experimental[CHANNEL_CAPABILITY] !== null;
}

/** 内置事件来源的脚本。 */
function builtinScript(builtin: BuiltinSource): string {
	return fileURLToPath(new URL(`../sources/${builtin}.ts`, import.meta.url));
}
