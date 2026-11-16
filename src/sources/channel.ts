import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { format } from 'node:util';
import { fromJsonSchema, McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { errorMessage } from '../common/errors.ts';

/** 来源同时提供的工具。call 返回给成员看的结果，出错时抛出。 */
export interface IChannelTool {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: Record<string, unknown>;
	readonly call: (args: Record<string, unknown>) => Promise<string>;
}

/** 外部事件的来源：声明 claude/channel 能力的 stdio MCP 服务器，用 notifications/claude/channel 推送事件。 */
export class Channel {
	private readonly server: McpServer;

	constructor(name: string, tools: readonly IChannelTool[] = []) {
		this.server = new McpServer({ name, version: '1' }, { capabilities: { experimental: { 'claude/channel': {} }, ...tools.length > 0 && { tools: {} } } });
		for (const tool of tools) {
			this.server.registerTool(tool.name, { description: tool.description, inputSchema: fromJsonSchema<Record<string, unknown>>(tool.inputSchema) }, async (args): Promise<CallToolResult> => {
				try {
					return { content: [{ type: 'text', text: await tool.call(args) }] };
				} catch (error) {
					return { content: [{ type: 'text', text: errorMessage(error) }], isError: true };
				}
			});
		}
	}

	/**
	 * 开始和运行时通信；运行时关掉连接时退出。
	 * stdout 是和运行时通信用的；连上以后写到 stderr 的每一行，运行时都记成一条警告。所以依赖库的一般日志丢掉，警告和错误写到 stderr。
	 */
	async start(): Promise<void> {
		for (const level of ['log', 'info', 'debug'] as const) console[level] = () => {};
		console.warn = (...args: unknown[]) => process.stderr.write(`${format(...args)}\n`);
		const transport = new StdioServerTransport();
		transport.onclose = () => process.exit(0);
		await this.server.connect(transport);
	}

	/** 推送一个事件。meta 里取不到的项不写。 */
	async emit(content: string, meta: Readonly<Record<string, string | undefined>>): Promise<void> {
		const defined = Object.fromEntries(Object.entries(meta).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== ''));
		await this.server.server.notification({ method: 'notifications/claude/channel', params: { content, meta: defined } });
	}
}

/** 来源的状态（处理到哪了），存在运行时给的文件夹里；读不了时是 undefined。 */
export class SourceState<T> {
	private readonly path: string;

	constructor(directory: string) {
		mkdirSync(directory, { recursive: true });
		this.path = join(directory, 'state.json');
	}

	read(): T | undefined {
		try {
			return JSON.parse(readFileSync(this.path, 'utf8')) as T;
		} catch {
			return undefined;
		}
	}

	/** 先写临时文件再换过去，写到一半退出也不会坏。 */
	write(value: T): void {
		writeFileSync(`${this.path}.tmp`, JSON.stringify(value));
		renameSync(`${this.path}.tmp`, this.path);
	}
}

/** 必须的环境变量；没有时说明原因并退出。 */
export function requiredEnv(name: string): string {
	const value = process.env[name]?.trim();
	if (value) return value;
	console.error(`未填写环境变量 ${name}`);
	process.exit(1);
}

/** 运行时把状态文件夹作为第一个参数传进来。 */
export function stateDirectory(): string {
	const directory = process.argv[2];
	if (!directory) {
		console.error('缺少状态文件夹参数');
		process.exit(1);
	}
	return directory;
}
