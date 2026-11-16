import variant from '@jitl/quickjs-wasmfile-release-sync';
import {
	newQuickJSWASMModuleFromVariant, type QuickJSContext, type QuickJSDeferredPromise, type QuickJSHandle, type QuickJSSyncVariant, type QuickJSWASMModule,
} from 'quickjs-emscripten-core';
import { errorMessage } from '../common/errors.ts';
import { clipMiddle } from '../common/text.ts';

/** 输出太长时保留开头和结尾。 */
const HEAD_CHARS = 8_000;
const TAIL_CHARS = 12_000;
/** 收集输出时最多留多少字，再多就不收了（最后还会裁成首尾两段）。 */
const MAX_COLLECTED_CHARS = 1_000_000;
/** 代码放进 async 函数里执行；包装放在第一行开头，代码的行号不变。 */
const WRAPPER_PREFIX = '(async () => {';
const FILE_NAME = 'script.js';
/** 模块的 console 输出最多记多少字。 */
const MAX_MODULE_LOG_CHARS = 4_000;

export interface IScriptOptions {
	readonly code: string;
	/** 代码里能调用的函数：tools.<名字>(参数)。返回字符串或能转成 JSON 的值；出错时抛出 Error，message 交给代码。 */
	readonly functions: ReadonlyMap<string, (args: Record<string, unknown>) => Promise<unknown>>;
	/** 输出里的值换成一段文字时返回这段文字，例如把图片换成「[图片 1]」；不换时返回 undefined。 */
	readonly replace?: (value: unknown) => string | undefined;
	/** 纯 JS 最多执行多久（不算等函数结果的时间），防止死循环。 */
	readonly cpuLimitMs: number;
	readonly memoryLimitBytes: number;
	/** 触发时中断代码（超时、运行中止、任务取消），reason 的 message 作为说明。 */
	readonly signal: AbortSignal;
}

export interface IScriptResult {
	readonly ok: boolean;
	/** console 输出、返回值，出错时还有错误说明。 */
	readonly output: string;
}

let quickjs: Promise<QuickJSWASMModule> | undefined;

/** 第一次用时加载 QuickJS，之后共用。 */
function loadQuickJS(): Promise<QuickJSWASMModule> {
	// 这个包的类型声明按 CommonJS 解析，Node 实际加载的是 ESM，默认导出就是 variant。
	return quickjs ??= newQuickJSWASMModuleFromVariant(variant as unknown as QuickJSSyncVariant);
}

/** 在全新的 QuickJS 环境里执行一段代码。代码只能调用给定的函数，不能读写文件、联网或执行命令。 */
export async function runScript(options: IScriptOptions): Promise<IScriptResult> {
	options.signal.throwIfAborted();
	const runtime = (await loadQuickJS()).newRuntime();
	runtime.setMemoryLimit(options.memoryLimitBytes);
	runtime.setMaxStackSize(1024 * 1024);
	const context = runtime.newContext();
	const output = new Output(options.replace);
	const pending = new Set<QuickJSDeferredPromise>();
	let cpuUsed = 0;
	let segmentStart: number | undefined;
	let closed = false;
	let cpuExceeded = false;
	runtime.setInterruptHandler(() => {
		if (segmentStart !== undefined && cpuUsed + Date.now() - segmentStart > options.cpuLimitMs) cpuExceeded = true;
		return cpuExceeded || options.signal.aborted;
	});
	/** 代码出错时的说明；因为超过 CPU 时间被中断时换成更好懂的说法。 */
	const describeFailure = (error: unknown) => cpuExceeded
		? `错误：脚本执行超过 ${options.cpuLimitMs / 1000} 秒仍未结束（可能是死循环），已中断`
		: `错误：${describeError(error, true)}`;
	/** 执行一段 JS，并计入 CPU 时间。 */
	const runJs = <T>(work: () => T): T => {
		segmentStart = Date.now();
		try {
			return work();
		} finally {
			cpuUsed += Date.now() - segmentStart;
			segmentStart = undefined;
		}
	};
	const drain = () => {
		const result = runJs(() => runtime.executePendingJobs());
		if (result.error) result.error.dispose();
	};
	const onAbort = () => abort?.();
	let abort: (() => void) | undefined;
	options.signal.addEventListener('abort', onAbort, { once: true });

	try {
		installConsole(context, text => output.log(text), value => output.format(value));
		/** 函数的返回值放进代码里：字符串直接放，其他的按 JSON 转过去。 */
		const toHandle = (value: unknown): QuickJSHandle => typeof value === 'string' ? context.newString(value) : jsonHandle(context, value);
		const tools = context.newObject();
		for (const [name, implementation] of options.functions) {
			const handle = context.newFunction(name, argsHandle => {
				const deferred = context.newPromise();
				pending.add(deferred);
				const args = argsHandle ? context.dump(argsHandle) as unknown : undefined;
				const settle = (work: () => void) => {
					pending.delete(deferred);
					if (closed) return;
					work();
					if (deferred.alive) deferred.dispose();
					drain();
				};
				Promise.resolve()
					.then(() => {
						if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) throw new Error(`tools.${name} 的参数必须是对象`);
						return implementation((args ?? {}) as Record<string, unknown>);
					})
					.then(
						value => settle(() => {
							const handle = toHandle(value);
							deferred.resolve(handle);
							if (handle.alive && handle !== context.undefined) handle.dispose();
						}),
						(error: unknown) => settle(() => context.newError(errorMessage(error)).consume(result => deferred.reject(result))),
					);
				return deferred.handle;
			});
			context.setProp(tools, name, handle);
			handle.dispose();
		}
		context.setProp(context.global, 'tools', tools);
		tools.dispose();

		const evaluated = runJs(() => context.evalCode(`${WRAPPER_PREFIX}${options.code}\n})()`, FILE_NAME));
		if (evaluated.error) {
			output.error(describeFailure(context.dump(evaluated.error) as unknown));
			evaluated.error.dispose();
			return output.result(false);
		}
		const settled = context.resolvePromise(evaluated.value);
		evaluated.value.dispose();
		drain();
		const aborted = new Promise<'aborted'>(resolve => {
			abort = () => resolve('aborted');
			if (options.signal.aborted) resolve('aborted');
		});
		const outcome = await Promise.race([settled, aborted]);
		if (outcome === 'aborted') {
			const reason: unknown = options.signal.reason;
			output.error(`脚本被中止：${reason instanceof Error ? reason.message : String(reason ?? '')}`);
			return output.result(false);
		}
		if (outcome.error) {
			output.error(describeFailure(context.dump(outcome.error) as unknown));
			outcome.error.dispose();
			return output.result(false);
		}
		output.returned(context.dump(outcome.value) as unknown);
		outcome.value.dispose();
		return output.result(true);
	} finally {
		closed = true;
		options.signal.removeEventListener('abort', onAbort);
		// 代码结束时可能还有没完成的工具调用，先释放它们的 promise，再释放整个环境。
		for (const deferred of pending) if (deferred.alive) deferred.dispose();
		try {
			context.dispose();
			runtime.dispose();
		} catch {
			// 还有没释放的对象时 QuickJS 可能报错；环境已经不用了，忽略。
		}
	}
}

export interface IModuleOptions {
	readonly code: string;
	/** 出错位置里显示的文件名。 */
	readonly fileName: string;
	/** 看模块导出的 sources，返回 false 时不调用函数；sources 写得不对时抛出 Error，message 作为错误说明。 */
	readonly accept: (sources: unknown) => boolean;
	/** 传给默认导出的函数，按 JSON 转过去。 */
	readonly input: unknown;
	readonly cpuLimitMs: number;
	readonly memoryLimitBytes: number;
}

export interface IModuleResult {
	/** sources 接受了，调用了函数。 */
	readonly called: boolean;
	/** 函数的返回值，按 JSON 取出；没调用或出错时是 undefined。 */
	readonly value: unknown;
	readonly error: string | null;
	/** console 的输出，每次调用一行。 */
	readonly logs: readonly string[];
}

/**
 * 在全新的 QuickJS 环境里执行一个模块（事件路由）：模块导出 sources 和默认的函数，sources 接受时用 input 调用函数。
 * 不能调用任何外部函数，同步执行完；函数可以是 async 的，返回的 Promise 要在执行完时已经完成。
 */
export async function runModule(options: IModuleOptions): Promise<IModuleResult> {
	const runtime = (await loadQuickJS()).newRuntime();
	runtime.setMemoryLimit(options.memoryLimitBytes);
	runtime.setMaxStackSize(1024 * 1024);
	const deadline = Date.now() + options.cpuLimitMs;
	let timedOut = false;
	runtime.setInterruptHandler(() => timedOut ||= Date.now() > deadline);
	const context = runtime.newContext();
	const logs: string[] = [];
	let logSize = 0;
	let called = false;
	const result = (value: unknown, error: string | null): IModuleResult => ({ called, value, error, logs });
	const fail = (error: unknown) => result(undefined, timedOut
		? `执行超过 ${options.cpuLimitMs / 1000} 秒仍未结束（可能是死循环），已中断`
		: describeError(error, false));
	/** 执行完排队的任务，取出 promise 的结果；不是 promise 时就是它自己。handle 由这里接管。 */
	const settle = (handle: QuickJSHandle): { value: QuickJSHandle } | { error: unknown } => {
		const jobs = runtime.executePendingJobs();
		if (jobs.error) {
			handle.dispose();
			return { error: jobs.error.consume(error => context.dump(error) as unknown) };
		}
		const state = context.getPromiseState(handle);
		if (state.type === 'fulfilled' && state.notAPromise) return { value: handle };
		handle.dispose();
		if (state.type === 'fulfilled') return { value: state.value };
		if (state.type === 'rejected') return { error: state.error.consume(error => context.dump(error) as unknown) };
		return { error: '返回的 Promise 始终未完成：只能进行同步计算，不能等待' };
	};

	try {
		installConsole(context, text => {
			if (logSize > MAX_MODULE_LOG_CHARS) return;
			logSize += text.length;
			logs.push(logSize > MAX_MODULE_LOG_CHARS ? '……（输出过多，此后的输出未记录）' : text);
		}, value => format(value));
		const evaluated = context.evalCode(options.code, options.fileName, { type: 'module' });
		if (evaluated.error) return fail(evaluated.error.consume(error => context.dump(error) as unknown));
		const loaded = settle(evaluated.value);
		if ('error' in loaded) return fail(loaded.error);
		const exports = loaded.value;
		const sources = context.getProp(exports, 'sources').consume(handle => context.dump(handle) as unknown);
		let accepted: boolean;
		try {
			accepted = options.accept(sources);
		} catch (error) {
			exports.dispose();
			return result(undefined, errorMessage(error));
		}
		const fn = context.getProp(exports, 'default');
		exports.dispose();
		if (!accepted || context.typeof(fn) !== 'function') {
			fn.dispose();
			return result(undefined, accepted ? '缺少默认导出的函数：须写为 export default function (event) { … }' : null);
		}
		called = true;
		const input = jsonHandle(context, options.input);
		const call = context.callFunction(fn, context.undefined, input);
		input.dispose();
		fn.dispose();
		if (call.error) return fail(call.error.consume(error => context.dump(error) as unknown));
		const returned = settle(call.value);
		if ('error' in returned) return fail(returned.error);
		return result(returned.value.consume(handle => context.dump(handle) as unknown), null);
	} finally {
		try {
			context.dispose();
			runtime.dispose();
		} catch {
			// 还有没释放的对象时 QuickJS 可能报错；环境已经不用了，忽略。
		}
	}
}

/** 值按 JSON 转进环境里；undefined 就是 undefined。 */
function jsonHandle(context: QuickJSContext, value: unknown): QuickJSHandle {
	if (value === undefined) return context.undefined;
	const json = context.newString(JSON.stringify(value));
	const JSONObject = context.getProp(context.global, 'JSON');
	const parse = context.getProp(JSONObject, 'parse');
	try {
		return context.unwrapResult(context.callFunction(parse, JSONObject, json));
	} finally {
		json.dispose();
		parse.dispose();
		JSONObject.dispose();
	}
}

function installConsole(context: QuickJSContext, log: (text: string) => void, format: (value: unknown) => string): void {
	const consoleObject = context.newObject();
	for (const name of ['log', 'info', 'warn', 'error', 'debug']) {
		const handle = context.newFunction(name, (...args: QuickJSHandle[]) => {
			log(args.map(arg => format(context.dump(arg) as unknown)).join(' '));
		});
		context.setProp(consoleObject, name, handle);
		handle.dispose();
	}
	context.setProp(context.global, 'console', consoleObject);
	consoleObject.dispose();
}

function format(value: unknown, replace?: (value: unknown) => string | undefined): string {
	if (typeof value === 'string') return value;
	if (value === undefined) return 'undefined';
	const replaced = replace?.(value);
	if (replaced !== undefined) return replaced;
	try {
		return JSON.stringify(value, replace && ((_key, item: unknown) => replace(item) ?? item), 2) ?? String(value);
	} catch {
		return String(value);
	}
}

/** 错误类型、说明和位置。代码放在包装里执行的（wrapped），第一行的列号去掉包装的长度；包装函数自己那一层不显示。 */
function describeError(error: unknown, wrapped: boolean): string {
	if (typeof error !== 'object' || error === null) return format(error);
	const { name, message, stack } = error as { name?: unknown; message?: unknown; stack?: unknown };
	const lines = [`${typeof name === 'string' ? name : 'Error'}: ${typeof message === 'string' ? message : format(error)}`];
	if (typeof stack === 'string') {
		const frames = stack.split('\n').map(line => line.trim()).filter(line => line && !line.includes('<eval>'))
			.map(line => wrapped ? line.replace(new RegExp(`${FILE_NAME}:1:(\\d+)`), (_, column: string) => `${FILE_NAME}:1:${Math.max(1, Number(column) - WRAPPER_PREFIX.length)}`) : line);
		if (frames.length > 0) lines.push(...frames.map(frame => `  ${frame}`));
	}
	return lines.join('\n');
}

class Output {
	private readonly replace: ((value: unknown) => string | undefined) | undefined;
	private readonly parts: string[] = [];
	private size = 0;
	private dropped = false;

	constructor(replace: ((value: unknown) => string | undefined) | undefined) {
		this.replace = replace;
	}

	/** console 的一个参数或返回值写成文字。 */
	format(value: unknown): string {
		return format(value, this.replace);
	}

	log(text: string): void {
		if (this.size >= MAX_COLLECTED_CHARS) {
			this.dropped = true;
			return;
		}
		this.parts.push(text);
		this.size += text.length;
	}

	returned(value: unknown): void {
		if (value !== undefined) this.parts.push(this.format(value));
	}

	error(text: string): void {
		this.parts.push(text);
	}

	result(ok: boolean): IScriptResult {
		const text = this.parts.join('\n') + (this.dropped ? '\n……（输出过多，此后的 console 输出未收集）' : '');
		return { ok, output: clipMiddle(text, HEAD_CHARS, TAIL_CHARS) || '（无输出）' };
	}
}
