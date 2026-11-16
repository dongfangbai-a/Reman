import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import type { CallToolResult } from '@modelcontextprotocol/client';
import { getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import crossSpawn from 'cross-spawn';
import { errorMessage, invalid, notFound } from '../common/errors.ts';
import { isRecord } from '../common/json.ts';
import { killProcessTree } from '../common/process.ts';
import type { Secrets } from '../common/secrets.ts';
import type { ModelConfig } from '../models/config.ts';
import type { Resources } from '../resources/resources.ts';
import { NO_STRUCTURED_RETURNS, toolResultHandler } from '../tools/toolResult.ts';
import type { ITool, IToolContext, IToolGroup, ToolPolicy } from '../tools/tools.ts';
import { CustomToolConfig, type StoredConfig, type StoredValue } from './config.ts';
import {
	CUSTOM_POLICIES, CUSTOM_PREFIX, folderNameProblem, readFolder, type IConfigField, type ICustomToolDefinition, type ICustomToolFolder,
} from './definition.ts';

/** 标准输出最多收多少字节，超过时结束进程。 */
const MAX_OUTPUT_BYTES = 50 * 1024 * 1024;
/** 出错时附上标准错误的最后多少行、最多多少字。 */
const STDERR_LINES = 20;
const STDERR_CHARS = 2000;
const WATCH_DEBOUNCE_MS = 300;
/** 运行时自带的 npm 包：Node 脚本用 require 能取到（如 openai），复制到数据目录的内置工具照样能用。 */
const RUNTIME_PACKAGES = fileURLToPath(new URL('../../node_modules', import.meta.url));

export type CustomToolOrigin = 'builtin' | 'own';

/** 网页端看到的一项配置的值：密钥不给原文。 */
export interface IKeyState {
	readonly set: boolean;
	readonly undecryptable: boolean;
}

export type PublicValue =
	| { readonly type: 'text'; readonly value: string | null }
	| { readonly type: 'secret'; readonly key: IKeyState }
	| { readonly type: 'service'; readonly provider: string | null; readonly baseUrl: string | null; readonly key: IKeyState };

export interface ICustomToolInfo {
	/** 文件夹名。 */
	readonly name: string;
	readonly origin: CustomToolOrigin;
	/** 数据目录里和内置的同名，覆盖了内置的。 */
	readonly overridesBuiltin: boolean;
	readonly directory: string;
	readonly label: string;
	readonly description: string;
	readonly defaultPolicy: ToolPolicy;
	readonly tools: readonly { readonly name: string; readonly label: string; readonly description: string; readonly progressive: boolean }[];
	readonly config: readonly IConfigField[];
	readonly values: Readonly<Record<string, PublicValue>>;
	/** 停用了：调用时返回已停用，配置留着。 */
	readonly disabled: boolean;
	/** 配置不全、用不了的原因；配置好了是 null。和停用一样只影响调用的结果，成员照常有这些工具。 */
	readonly problem: string | null;
	/** 有无法解密的密钥，要重新填写。 */
	readonly undecryptable: boolean;
}

/** 读不出来的文件夹。 */
export interface ICustomToolIssue {
	readonly name: string;
	readonly origin: CustomToolOrigin;
	readonly directory: string;
	readonly message: string;
}

export interface ICustomToolsSnapshot {
	/** 数据目录里的自定义工具目录。 */
	readonly directory: string | null;
	/** custom-tools.json 读不出来的原因。 */
	readonly configError: string | null;
	readonly tools: readonly ICustomToolInfo[];
	readonly issues: readonly ICustomToolIssue[];
}

/** 加载好的一个文件夹。 */
interface ILoaded {
	readonly name: string;
	readonly origin: CustomToolOrigin;
	readonly overridesBuiltin: boolean;
	readonly directory: string;
	readonly folder: ICustomToolFolder;
	readonly tools: readonly ITool[];
}

export interface ICustomToolsOptions {
	/** 数据目录里的自定义工具，同名时覆盖内置的；不给时只有内置的（测试用）。 */
	readonly directory: string | undefined;
	/** 随运行时提供的内置自定义工具。 */
	readonly builtinDirectory: string;
	/** custom-tools.json；不给时只在内存里。 */
	readonly configPath: string | undefined;
	readonly secrets: Secrets;
	readonly models: () => ModelConfig;
	readonly resources: Resources;
	/** 存文件的目录，每个文件夹一个子目录：脚本过长结果的完整内容、运行时截断的结果都放在这里。 */
	readonly outputsDirectory: string;
	/** 内置工具的名字，自定义工具不能和它们重名。 */
	readonly reservedNames: () => ReadonlySet<string>;
	/** 文件夹或配置变了。 */
	readonly onChange: () => void;
}

/**
 * 自定义工具：一个文件夹一项，里面是 tool.json 和脚本，见运行时设计「自定义工具」。
 * 内置的在程序目录里，数据目录里同名的覆盖它。每次调用起一个进程：标准输入给参数和配置，标准输出写 MCP 形状的结果。
 */
export class CustomTools {
	readonly directory: string | undefined;
	private readonly options: ICustomToolsOptions;
	private readonly config: CustomToolConfig;
	/** 加载好的文件夹，第一次用到时加载，目录变了重新加载。 */
	private loaded: { readonly items: readonly ILoaded[]; readonly issues: readonly ICustomToolIssue[] } | undefined;
	private watcher: FSWatcher | undefined;
	private timer: NodeJS.Timeout | undefined;

	constructor(options: ICustomToolsOptions) {
		this.options = options;
		this.directory = options.directory;
		this.config = new CustomToolConfig(options.configPath, options.secrets);
	}

	/**
	 * 每个文件夹的工具组。停用的、未配置的照常列出、照常给成员，只是调用时返回错误；成员设置里按 customTool 显示状态。
	 * 查找工具时每次都取工具组，停用和配置问题只有列出工具时用到：用到时才读配置文件，一次取工具组只读一次。
	 */
	groups(): IToolGroup[] {
		const { items } = this.load();
		if (items.length === 0) return [];
		let config: ReturnType<CustomTools['readConfig']> | undefined;
		const readConfig = () => config ??= this.readConfig();
		return items.map(item => {
			let state: { readonly disabled: boolean; readonly problem: string | null } | undefined;
			const status = () => state ??= { disabled: isDisabled(item.name, readConfig()), problem: this.resolve(item, readConfig()).problem };
			return {
				name: `${CUSTOM_PREFIX}${item.name}`,
				label: item.folder.label,
				description: item.folder.description || item.folder.label,
				policies: CUSTOM_POLICIES,
				defaultPolicy: item.folder.defaultPolicy,
				autoPolicy: null,
				tools: item.tools,
				mcpServer: null,
				customTool: {
					folder: item.name,
					origin: item.origin,
					get disabled() { return status().disabled; },
					get problem() { return status().problem; },
				},
			};
		});
	}

	snapshot(): ICustomToolsSnapshot {
		const { items, issues } = this.load();
		const config = this.readConfig();
		return {
			directory: this.directory ?? null,
			configError: 'error' in config ? config.error : null,
			tools: items.map(item => {
				const resolved = this.resolve(item, config);
				const stored = 'values' in config ? config.values[item.name]?.values ?? {} : {};
				return {
					name: item.name,
					origin: item.origin,
					overridesBuiltin: item.overridesBuiltin,
					directory: item.directory,
					label: item.folder.label,
					description: item.folder.description,
					defaultPolicy: item.folder.defaultPolicy,
					tools: item.folder.tools.map(tool => ({ name: tool.name, label: tool.label, description: tool.description, progressive: tool.progressive })),
					config: item.folder.config,
					values: Object.fromEntries(item.folder.config.map(field => [field.name, this.publicValue(field, stored[field.name])])),
					disabled: isDisabled(item.name, config),
					problem: resolved.problem,
					undecryptable: resolved.undecryptable,
				};
			}),
			issues,
		};
	}

	/**
	 * 整个替换一个文件夹的配置，只留声明了的项。text 给字符串，空的算没填；secret 给字符串，null 沿用原来的；
	 * service 给 { provider } 或 { baseUrl, apiKey }，apiKey 为 null 时沿用原来单独填的 key，null 是不配置。
	 * 不检查必填：填了什么存什么，没填的必填项让工具调用时报错。
	 */
	setConfig(name: string, input: Record<string, unknown>): void {
		const item = this.load().items.find(entry => entry.name === name);
		if (!item) throw notFound(`自定义工具 ${name} 不存在`);
		const config = this.readConfig();
		if ('error' in config) throw invalid(`${config.error}，请先修复该文件`);
		const previous = config.values[name]?.values ?? {};
		const next: Record<string, StoredValue> = {};
		for (const field of item.folder.config) {
			const value = input[field.name];
			const old = previous[field.name];
			if (field.type === 'service') {
				if (value === null || value === undefined) continue;
				if (!isRecord(value)) throw invalid(`${field.label}须选择供应商，或填写地址和 key`);
				if (typeof value['provider'] === 'string' && value['provider']) {
					next[field.name] = { provider: value['provider'] };
					continue;
				}
				const baseUrl = typeof value['baseUrl'] === 'string' ? value['baseUrl'].trim() : '';
				if (!/^https?:\/\//.test(baseUrl)) throw invalid(`${field.label}的地址须为 http 或 https 地址`);
				const apiKey = typeof value['apiKey'] === 'string' && value['apiKey'] ? value['apiKey'] : old && typeof old === 'object' && 'apiKey' in old ? old.apiKey : '';
				if (!apiKey) throw invalid(`缺少${field.label}的 API key`);
				next[field.name] = { baseUrl, apiKey };
				continue;
			}
			if (field.type === 'secret' && value === null) {
				if (typeof old === 'string' && old) next[field.name] = old;
				continue;
			}
			if (value !== undefined && typeof value !== 'string') throw invalid(`${field.label}须为字符串`);
			const text = (value ?? '').trim();
			if (text) next[field.name] = text;
		}
		this.config.write(name, next, secretNames(item.folder));
		this.options.onChange();
	}

	/** 停用或启用一项。停用后所有成员调用它都返回已停用，配置留着。 */
	setDisabled(name: string, disabled: boolean): void {
		if (!this.load().items.some(entry => entry.name === name)) throw notFound(`自定义工具 ${name} 不存在`);
		const config = this.readConfig();
		if ('error' in config) throw invalid(`${config.error}，请先修复该文件`);
		this.config.setDisabled(name, disabled);
		this.options.onChange();
	}

	/** 删除数据目录里的文件夹（包括读不出来的）。它的配置留着，同名的建回来接着用；覆盖内置的删除后恢复用内置的。 */
	remove(name: string): void {
		if (folderNameProblem(name) || !this.directory) throw notFound(`自定义工具 ${name} 不存在`);
		const target = join(this.directory, name);
		if (!existsSync(target)) throw notFound(`自定义工具目录中不存在 ${name}`);
		try {
			rmSync(target, { recursive: true, force: true });
		} catch (error) {
			this.reload();
			throw invalid(`无法删除文件夹 ${name}：${errorMessage(error)}。该工具可能正在运行，请在运行结束后重试`);
		}
		this.reload();
	}

	/** 监听自定义工具目录，加了、改了、删了马上重新加载。 */
	watch(): void {
		if (this.watcher || !this.directory) return;
		mkdirSync(this.directory, { recursive: true });
		this.watcher = watch(this.directory, { recursive: true }, () => {
			clearTimeout(this.timer);
			this.timer = setTimeout(() => {
				try {
					this.reload();
				} catch (error) {
					console.error('自定义工具目录变化后重新加载失败：', error);
				}
			}, WATCH_DEBOUNCE_MS);
		});
		this.watcher.on('error', error => console.error('监听自定义工具目录失败：', error));
	}

	close(): void {
		clearTimeout(this.timer);
		this.watcher?.close();
		this.watcher = undefined;
	}

	/** 重新加载两处的文件夹。目录变了时调用，测试里也直接调用。 */
	reload(): void {
		this.loaded = undefined;
		this.options.onChange();
	}

	/** 加载两处的文件夹，数据目录里同名的覆盖内置的。工具名和内置工具、前面的自定义工具重名的整个文件夹不加载。 */
	private load(): NonNullable<CustomTools['loaded']> {
		if (this.loaded) return this.loaded;
		const builtin = scan(this.options.builtinDirectory, 'builtin');
		const own = this.directory ? scan(this.directory, 'own') : { folders: [], issues: [] };
		const ownNames = new Set([...own.folders.map(folder => folder.name), ...own.issues.map(issue => issue.name)]);
		const builtinNames = new Set(builtin.folders.map(folder => folder.name));
		const folders = [
			...builtin.folders.filter(folder => !ownNames.has(folder.name)),
			...own.folders,
		];
		const issues = [...builtin.issues.filter(issue => !ownNames.has(issue.name)), ...own.issues];
		const used = new Map([...this.options.reservedNames()].map(name => [name, '内置工具']));
		const items: ILoaded[] = [];
		for (const entry of folders) {
			const clash = entry.folder.tools.find(tool => used.has(tool.name));
			if (clash) {
				issues.push({ name: entry.name, origin: entry.origin, directory: entry.directory, message: `工具名 ${clash.name} 与${used.get(clash.name)}重名` });
				continue;
			}
			for (const tool of entry.folder.tools) used.set(tool.name, `自定义工具 ${entry.name} 的工具`);
			items.push({ ...entry, overridesBuiltin: entry.origin === 'own' && builtinNames.has(entry.name), tools: entry.folder.tools.map(tool => this.toTool(entry.name, entry.directory, entry.folder, tool)) });
		}
		this.loaded = { items, issues };
		return this.loaded;
	}

	private toTool(name: string, directory: string, folder: ICustomToolFolder, tool: ICustomToolDefinition): ITool {
		const results = toolResultHandler(this.options.resources, tool.name, tool.returns !== null, this.outputDirectory(name));
		return {
			name: tool.name,
			label: tool.label,
			description: tool.description,
			parameters: tool.parameters,
			group: `${CUSTOM_PREFIX}${name}`,
			defaultPolicy: folder.defaultPolicy,
			progressive: tool.progressive,
			background: true,
			timeoutMs: () => tool.timeoutSeconds * 1000,
			returns: tool.returns ?? NO_STRUCTURED_RETURNS,
			execute: async (context, args) => results.value(await this.call(name, directory, tool, context, args), `自定义工具 ${tool.name} 返回错误`),
			format: value => results.format(value),
		};
	}

	private outputDirectory(name: string): string {
		return join(this.options.outputsDirectory, name);
	}

	/** 执行一次调用：按现在的配置起一个进程，返回它写到标准输出的结果。 */
	private async call(name: string, directory: string, tool: ICustomToolDefinition, context: IToolContext, args: Record<string, unknown>): Promise<CallToolResult> {
		const item = this.load().items.find(entry => entry.name === name);
		if (!item) throw invalid(`自定义工具 ${name} 已不存在`);
		// 停用、未配置都只影响这次调用的结果，不起进程。
		const config = this.readConfig();
		if (isDisabled(name, config)) throw invalid(`自定义工具 ${name} 已停用`);
		const resolved = this.resolve(item, config);
		if (resolved.problem) throw invalid(`自定义工具 ${name} 不可用：${resolved.problem}`);
		const outputDirectory = this.outputDirectory(name);
		mkdirSync(outputDirectory, { recursive: true });
		const input = JSON.stringify({ arguments: args, config: resolved.values, workingDirectory: context.workingDirectory, outputDirectory });
		const run = await runProcess(tool.command, directory, input, tool.timeoutSeconds, context.signal);
		const failed = (reason: string) => invalid(`自定义工具 ${tool.name} 出错：${reason}${run.stderr ? `\n标准错误的最后几行：\n${run.stderr}` : ''}`);
		if (run.failure) throw failed(run.failure);
		if (run.exitCode !== 0) throw failed(`退出码 ${run.exitCode ?? '无'}`);
		const result = parseResult(run.stdout);
		if (typeof result === 'string') throw failed(result);
		return result;
	}

	private readConfig(): { readonly values: StoredConfig } | { readonly error: string } {
		try {
			return {
				values: this.config.read(folder => {
					const item = this.loaded?.items.find(entry => entry.name === folder);
					return item ? secretNames(item.folder) : new Set();
				}),
			};
		} catch (error) {
			return { error: errorMessage(error) };
		}
	}

	/** 按保存的值算出交给脚本的配置；配置不全、用不了时写原因。 */
	private resolve(item: ILoaded, config: { readonly values: StoredConfig } | { readonly error: string }): { values: Record<string, unknown>; problem: string | null; undecryptable: boolean } {
		if ('error' in config) return { values: {}, problem: config.error, undecryptable: false };
		const stored = config.values[item.name]?.values ?? {};
		const values: Record<string, unknown> = {};
		const missing: string[] = [];
		const problems: string[] = [];
		let undecryptable = false;
		for (const field of item.folder.config) {
			const value = stored[field.name];
			if (value === undefined || value === '') {
				if (field.default !== null) values[field.name] = field.default;
				else if (field.required) missing.push(field.label);
				continue;
			}
			if (field.type === 'text' || field.type === 'secret') {
				if (typeof value !== 'string') {
					problems.push(`${field.label}的值格式有误，需重新填写`);
					continue;
				}
				const plain = field.type === 'secret' ? this.options.secrets.decrypt(value) : value;
				if (plain === undefined) {
					undecryptable = true;
					problems.push(`${field.label}无法解密，需重新填写`);
					continue;
				}
				values[field.name] = plain;
				continue;
			}
			if (typeof value === 'string') {
				problems.push(`${field.label}的值格式有误，需重新填写`);
				continue;
			}
			if ('provider' in value) {
				const service = this.providerService(value.provider);
				if (typeof service === 'string') problems.push(service);
				else values[field.name] = service;
				continue;
			}
			const apiKey = this.options.secrets.decrypt(value.apiKey);
			if (apiKey === undefined) {
				undecryptable = true;
				problems.push(`${field.label}的 API key 无法解密，需重新填写`);
				continue;
			}
			values[field.name] = { baseUrl: value.baseUrl, apiKey };
		}
		if (missing.length > 0) problems.unshift(`缺少${missing.join('、')}`);
		return { values, problem: problems.length > 0 ? problems.join('；') : null, undecryptable };
	}

	/** 模型设置里一个供应商的地址和 key；用不了时返回原因。 */
	private providerService(id: string): { baseUrl: string; apiKey: string } | string {
		const models = this.options.models();
		const list = models.list();
		if (list.error) return `无法读取模型配置：${list.error}`;
		const provider = list.providers.find(item => item.id === id);
		if (!provider) return `供应商 ${id} 已删除`;
		if (provider.apiKey.undecryptable) return `供应商 ${id} 的 key 无法解密，需在模型设置中重新填写`;
		const usable = models.provider(id);
		return { baseUrl: usable.baseUrl, apiKey: usable.apiKey };
	}

	private publicValue(field: IConfigField, value: StoredValue | undefined): PublicValue {
		const key = (stored: string | undefined): IKeyState => ({ set: Boolean(stored), undecryptable: stored ? this.options.secrets.decrypt(stored) === undefined : false });
		if (field.type === 'text') return { type: 'text', value: typeof value === 'string' && value ? value : null };
		if (field.type === 'secret') return { type: 'secret', key: key(typeof value === 'string' ? value : undefined) };
		if (value && typeof value === 'object' && 'provider' in value) return { type: 'service', provider: value.provider, baseUrl: null, key: key(undefined) };
		if (value && typeof value === 'object') return { type: 'service', provider: null, baseUrl: value.baseUrl, key: key(value.apiKey) };
		return { type: 'service', provider: null, baseUrl: null, key: key(undefined) };
	}
}

/** 停用了没有；配置文件读不出来时不算停用，按未配置处理。 */
function isDisabled(name: string, config: { readonly values: StoredConfig } | { readonly error: string }): boolean {
	return 'values' in config && config.values[name]?.disabled === true;
}

function secretNames(folder: ICustomToolFolder): ReadonlySet<string> {
	return new Set(folder.config.filter(field => field.type === 'secret').map(field => field.name));
}

/** 一处目录里的文件夹：读出来的和读不出来的。目录不存在时都是空的。 */
function scan(root: string, origin: CustomToolOrigin): { folders: { name: string; origin: CustomToolOrigin; directory: string; folder: ICustomToolFolder }[]; issues: ICustomToolIssue[] } {
	const folders: { name: string; origin: CustomToolOrigin; directory: string; folder: ICustomToolFolder }[] = [];
	const issues: ICustomToolIssue[] = [];
	if (!existsSync(root)) return { folders, issues };
	const names = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).map(entry => entry.name).sort();
	for (const name of names) {
		const directory = join(root, name);
		const problem = folderNameProblem(name);
		if (problem) {
			issues.push({ name, origin, directory, message: problem });
			continue;
		}
		try {
			folders.push({ name, origin, directory, folder: readFolder(directory) });
		} catch (error) {
			issues.push({ name, origin, directory, message: errorMessage(error) });
		}
	}
	return { folders, issues };
}

interface IProcessRun {
	readonly stdout: string;
	/** 标准错误的最后几行。 */
	readonly stderr: string;
	readonly exitCode: number | null;
	/** 没正常结束的原因：启动失败、超时、取消、输出太多。 */
	readonly failure: string | undefined;
}

/** 起一个进程，把 input 写进标准输入，收标准输出和标准错误。超时、取消、输出太多时结束整个进程树。 */
function runProcess(command: readonly string[], cwd: string, input: string, timeoutSeconds: number, signal: AbortSignal): Promise<IProcessRun> {
	return new Promise(resolve => {
		if (signal.aborted) {
			resolve({ stdout: '', stderr: '', exitCode: null, failure: '已取消' });
			return;
		}
		let child: ChildProcessWithoutNullStreams;
		try {
			// 和 MCP 的 stdio 服务器一样用 cross-spawn 起进程：Windows 上 npx、pnpm 这类 .cmd 命令也能执行。三个标准流都是管道。
			child = crossSpawn(command[0]!, command.slice(1), {
				// Python 3.15 以前在 Windows 上按系统代码页读写标准输入输出，中文会乱码，改为 UTF-8。
				cwd, env: { ...getDefaultEnvironment(), PYTHONUTF8: '1', ...command[0] === process.execPath && { NODE_PATH: RUNTIME_PACKAGES } },
				stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32',
			}) as ChildProcessWithoutNullStreams;
		} catch (error) {
			// 参数里有 NUL 这类无法起进程的情况会同步报错，和异步的启动失败一样返回原因。
			resolve({ stdout: '', stderr: '', exitCode: null, failure: `启动失败：${startFailure(command[0]!, error)}` });
			return;
		}
		const chunks: Buffer[] = [];
		let size = 0;
		let stderr = '';
		const decoder = new StringDecoder('utf8');
		let failure: string | undefined;
		let done = false;
		// 只结束一次：输出超过上限后每来一块数据都会调用。
		const stop = (reason: string) => {
			if (failure !== undefined) return;
			failure = reason;
			killProcessTree(child);
		};
		const timer = setTimeout(() => stop(`运行超过 ${timeoutSeconds} 秒，已终止`), timeoutSeconds * 1000);
		const onAbort = () => stop('已取消，进程已终止');
		signal.addEventListener('abort', onAbort, { once: true });
		const finish = (exitCode: number | null) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			signal.removeEventListener('abort', onAbort);
			resolve({ stdout: Buffer.concat(chunks).toString('utf8'), stderr: tail(stderr + decoder.end()), exitCode, failure });
		};
		child.stdout.on('data', (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_OUTPUT_BYTES) stop(`标准输出超过 ${MAX_OUTPUT_BYTES / 1024 / 1024} MB，已终止`);
			else chunks.push(chunk);
		});
		child.stderr.on('data', (chunk: Buffer) => {
			stderr = (stderr + decoder.write(chunk)).slice(-STDERR_CHARS * 2);
		});
		// 进程不读标准输入就退出时，写入会出错，不用管。
		child.stdin.on('error', () => {});
		child.stdin.end(input);
		child.on('error', error => {
			failure ??= `启动失败：${startFailure(command[0]!, error)}`;
			finish(null);
		});
		child.on('close', code => finish(code));
	});
}

/** 进程起不来的原因。 */
function startFailure(program: string, error: unknown): string {
	return (error as NodeJS.ErrnoException).code === 'ENOENT' ? `未找到命令 ${program}` : errorMessage(error);
}

/** 标准错误的最后几行。 */
function tail(text: string): string {
	return text.trim().split(/\r?\n/).slice(-STDERR_LINES).join('\n').slice(-STDERR_CHARS);
}

/** 标准输出里的结果；不是工具结果的形状时返回原因。 */
function parseResult(stdout: string): CallToolResult | string {
	let value: unknown;
	try {
		value = JSON.parse(stdout);
	} catch {
		return stdout.trim() ? '标准输出不是合法的 JSON' : '未输出结果';
	}
	if (!isRecord(value) || !Array.isArray(value['content'])) return '输出须为 { "content": [...] }';
	for (const block of value['content']) {
		if (!isRecord(block)) return 'content 中的每一项须为对象';
		if (block['type'] === 'text' && typeof block['text'] === 'string') continue;
		if (block['type'] === 'image' && typeof block['data'] === 'string' && typeof block['mimeType'] === 'string') continue;
		return 'content 中只能包含 { "type": "text", "text" } 和 { "type": "image", "data", "mimeType" }';
	}
	if (value['isError'] !== undefined && typeof value['isError'] !== 'boolean') return 'isError 必须是 true 或 false';
	const structured = value['structuredContent'];
	if (structured !== undefined && (typeof structured !== 'object' || structured === null)) return 'structuredContent 须为对象或数组';
	return value as CallToolResult;
}
