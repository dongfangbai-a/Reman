import { errorMessage, RuntimeError } from '../common/errors.ts';
import type { Workspaces } from '../members/workspaces.ts';
import type { Approvals } from './approvals.ts';
import { compactDuration, RECENT_LINES, recentOutput } from './backgroundText.ts';
import { ExecutionClock } from './clock.ts';
import type { CodeCalls } from './codeCalls.ts';
import type { LiveOutputs } from './liveOutputs.ts';
import { resolveMoreToolsCall } from './moreTools.ts';
import type { Tasks } from './tasks.ts';
import type { ITool, IToolCallResult, IToolContext, Tools } from './tools.ts';

/** 可能耗时很久的工具执行多久还没完成就转为后台任务。工具说明里写的时间也用它。 */
export const BACKGROUND_AFTER_MS = 30 * 1000;
/** 要早点转后台的调用（shell 的 background）等多久：一启动就报错的多在一两秒内结束，等一会儿能当场拿到结果；还在跑的也带上这几秒的输出。 */
export const EARLY_BACKGROUND_AFTER_MS = 3 * 1000;

const STOPPED_BEFORE: IToolCallResult = { output: '未执行：运行在执行前已停止', isError: true, stopped: 'before' };
const STOPPED_DURING: IToolCallResult = { output: '执行中被中止：运行已停止，可能已执行了一部分', isError: true, stopped: 'during' };

/** 转后台时要知道是谁的、哪次运行、哪个调用：直接发起的调用有 itemId，脚本里的调用共用脚本那次的。 */
export interface IBackgroundCall {
	readonly memberId: string;
	readonly runId: number;
	readonly callId: string;
}

export interface IToolCall extends IBackgroundCall {
	/** 这次调用在时间线里的条目。 */
	readonly itemId: number;
	readonly name: string;
	readonly rawArguments: string;
	/** 这次运行的中止信号。 */
	readonly signal: AbortSignal;
	/** 等用户审批时调用，返回等完时调用的函数。 */
	readonly waitingApproval?: () => () => void;
	/** 这次运行里用户选了「本次运行中允许此工具」的工具，一次运行一份。 */
	readonly runAllowed?: Set<string>;
}

/** 一段 run_tool_script 脚本的状态：调用计数，以及用户选了「这段脚本里都允许」的工具。 */
export class CodeScope {
	readonly allowedTools = new Set<string>();
	nextIndex = 0;
}

/** 等多久转为后台任务：一般的调用，和要早点转的（shell 的 background）。 */
export interface IBackgroundTiming {
	readonly backgroundAfterMs: number;
	readonly earlyBackgroundAfterMs: number;
}

/** 执行模型发起的工具调用：检查成员设置，需要时等用户审批，执行太久的转为后台任务。 */
export class ToolExecutor {
	private readonly tools: Tools;
	private readonly approvals: Approvals;
	private readonly tasks: Tasks;
	private readonly codeCalls: CodeCalls;
	private readonly workspaces: Workspaces;
	private readonly liveOutputs: LiveOutputs;
	private readonly timing: IBackgroundTiming;

	constructor(tools: Tools, approvals: Approvals, tasks: Tasks, codeCalls: CodeCalls, workspaces: Workspaces, liveOutputs: LiveOutputs, timing: IBackgroundTiming) {
		this.tools = tools;
		this.approvals = approvals;
		this.tasks = tasks;
		this.codeCalls = codeCalls;
		this.workspaces = workspaces;
		this.liveOutputs = liveOutputs;
		this.timing = timing;
	}

	/** 运行时启动时处理上次留下的审批、后台任务和脚本里的调用。 */
	recover(): void {
		this.approvals.recover();
		this.tasks.recover();
		this.codeCalls.recover();
	}

	async call(call: IToolCall): Promise<IToolCallResult> {
		if (call.signal.aborted) return STOPPED_BEFORE;
		const parsed = this.tools.parse(call.name, call.rawArguments);
		if (!parsed.ok) return parsed.result;
		const target = this.target(parsed.tool, parsed.args);
		if ('output' in target) return target;
		const { tool, args } = target;
		const context: IToolContext = {
			memberId: call.memberId, workingDirectory: this.workspaces.directory(call.memberId), signal: call.signal,
			call: { runId: call.runId, callId: call.callId, itemId: call.itemId }, waitingApproval: call.waitingApproval, runAllowed: call.runAllowed,
			liveOutput: read => this.liveOutputs.open(call.memberId, call.runId, call.callId, read),
		};
		// 运行停止时记下这次调用停在哪一步：过了审批才算开始执行。
		let authorized: IToolContext | IToolCallResult;
		try {
			authorized = await this.authorize(tool, context, args, undefined);
		} catch (error) {
			if (call.signal.aborted) return STOPPED_BEFORE;
			throw error;
		}
		if ('output' in authorized) return authorized;
		let result: IToolCallResult;
		try {
			result = await this.execute(call, tool, authorized, args);
		} catch (error) {
			if (call.signal.aborted) return STOPPED_DURING;
			throw error;
		}
		// 有的工具把中止写成自己的出错结果（如脚本里已经打印的日志），保留下来接在后面。
		if (call.signal.aborted && result.isError && !result.stopped) {
			return { ...STOPPED_DURING, output: `${STOPPED_DURING.output}\n\n${result.output}` };
		}
		return result;
	}

	/**
	 * 执行 run_tool_script 脚本里的一次工具调用：设置和审批规则与直接调用相同，每次调用都记录下来。
	 * 可能转后台的工具在脚本里也能转（同样等一段时间、或者工具自己要求现在转），这时脚本拿到的是「已转到后台」的说明，
	 * 脚本接着往下执行，任务结果之后照常推送。等审批时暂停脚本的计时。成功时 value 是交给脚本的结构化结果。
	 */
	async callInCode(context: IToolContext, scope: CodeScope, name: string, args: Record<string, unknown>): Promise<IToolCallResult & { value?: unknown }> {
		const found = this.tools.get(name);
		if (!found) return { output: `不存在工具 ${name}`, isError: true };
		const target = this.target(found, args);
		if ('output' in target) return target;
		const tool = target.tool;
		args = target.args;
		const { runId, callId } = context.call!;
		// 脚本里的调用和脚本共用调用编号，执行中的输出不单独给：整段脚本按脚本的结果看。
		context = { ...context, liveOutput: undefined };
		const index = scope.nextIndex++;
		// 经 more_tools 的调用记下实际调用的工具，和参数对得上。
		this.codeCalls.start(context.memberId, runId, callId, index, tool.name, args);
		let result: IToolCallResult;
		let value: unknown;
		try {
			const authorized = await this.authorize(tool, context, args, { scope, index });
			if ('output' in authorized) result = authorized;
			else if (tool.background && !tool.staysForeground?.(authorized, args)) {
				// 脚本里也能转后台：这里拿到的是说明，脚本接着往下跑，任务结果由运行时推送。任务可能在脚本还没跑完时就结束、
				// 结果先送达（它排在那次调用的结果之后只对直接调用成立）：结果里有后台任务 ID，脚本的返回里也有，对得上。
				// 没转后台时原样是这次调用的结果，结构化结果（value）要一起还给脚本，少了它脚本拿到的是 undefined。
				const outcome = await this.runBackgroundable(
					{ memberId: context.memberId, runId, callId }, tool, authorized, args,
					async running => {
						const invoked = await this.tools.runWithValue(tool, running, args);
						return { ...invoked.result, value: invoked.value };
					}, tool.backgroundSoon?.(args) === true,
				);
				result = outcome;
				value = outcome.value;
			} else ({ result, value } = await this.tools.runWithValue(tool, authorized, args));
		} catch (error) {
			this.codeCalls.finish(context.memberId, runId, callId, index, 'failed', errorMessage(error));
			throw error;
		}
		this.codeCalls.finish(context.memberId, runId, callId, index, result.isError ? 'failed' : 'completed', result.output);
		return { ...result, value };
	}

	/** more_tools 的 call 换成对目标工具的调用。 */
	private target(tool: ITool, args: Record<string, unknown>): { tool: ITool; args: Record<string, unknown> } | IToolCallResult {
		const resolved = resolveMoreToolsCall(this.tools, tool, args);
		if (!resolved) return { tool, args };
		return 'error' in resolved ? { output: resolved.error, isError: true } : resolved;
	}

	/**
	 * 按成员设置检查这次调用，需要时等用户审批。用户选过「这段脚本里都允许」「本次运行中允许此工具」的不再审批，受保护的调用除外。可以执行时返回执行用的上下文（选了「这个终端里都允许」时带上），
	 * 否则返回要交给模型的错误结果。
	 */
	private async authorize(
		tool: ITool, context: IToolContext, args: Record<string, unknown>, nested: { readonly scope: CodeScope; readonly index: number } | undefined,
	): Promise<IToolContext | IToolCallResult> {
		if (!this.tools.enabled(context.memberId, tool)) return { output: `未为你启用工具 ${tool.name}`, isError: true };
		// 不能做的调用直接报错，不用等审批。
		const refused = await this.check(() => tool.refuseReason?.(context, args));
		if (typeof refused === 'object') return refused;
		if (refused !== undefined) return { output: refused, isError: true };
		const policy = this.tools.policy(context.memberId, tool);
		// 改运行时的数据、读令牌和密钥：不管审批方式和用户选过的「都允许」，每次单独审批。
		const protectedReasons = await this.check(async () => await tool.protectedReasons?.(context, args) ?? []);
		if (isFailure(protectedReasons)) return protectedReasons;
		const isProtected = protectedReasons.length > 0;
		const runKey = this.tools.approvalKey(tool);
		if (!isProtected && (context.runAllowed?.has(runKey) || nested?.scope.allowedTools.has(tool.name))) return context;
		// 免审批：用户明确选了它，表示信任这个工具，直接执行；受保护的原因上面已经拦下，仍须审批。
		if (!isProtected && policy === 'allow') return context;
		// 到沙箱外执行：写进审批原因，让用户知道这次是在宿主上跑（auto 和 ask 都要审批）。
		const alwaysReasons = await this.check(async () => await tool.alwaysReasons?.(context, args) ?? []);
		if (isFailure(alwaysReasons)) return alwaysReasons;
		let reasons = alwaysReasons;
		if (policy === 'auto') {
			const checked = await this.checkApproval(tool, context, args);
			if (isFailure(checked)) return checked;
			// 受保护的调用也写上工具自己的原因，用户一次看全。
			reasons = [...alwaysReasons, ...checked === undefined ? [] : typeof checked === 'string' ? [checked] : checked];
			if (reasons.length === 0 && !isProtected) return context;
		}
		const resume = context.clock?.pause();
		const waited = context.waitingApproval?.();
		try {
			const decision = await this.approvals.request({
				memberId: context.memberId, runId: context.call!.runId, callId: context.call!.callId, nestedIndex: nested?.index ?? null,
				toolName: tool.name, args, reasons, protectedReasons, runKey,
			}, context.signal);
			if (!decision.approved) return { output: decision.message, isError: true };
			if (decision.scope === 'code') nested?.scope.allowedTools.add(tool.name);
			if (decision.scope === 'run') context.runAllowed?.add(runKey);
			return decision.scope === 'terminal' ? { ...context, trustTerminal: true } : context;
		} finally {
			resume?.();
			waited?.();
		}
	}

	/** auto 策略：问工具这次要不要审批，返回审批原因或 undefined；判断时发现参数不对，返回错误结果。 */
	private checkApproval(tool: ITool, context: IToolContext, args: Record<string, unknown>): Promise<string | readonly string[] | undefined | IToolCallResult> {
		if (!tool.needsApproval) return Promise.resolve('该工具没有自动判断规则');
		return this.check(() => tool.needsApproval!(context, args));
	}

	/** 执行工具的审批判断；判断时发现参数不对，返回错误结果。 */
	private async check<T>(judge: () => T | Promise<T>): Promise<T | IToolCallResult> {
		try {
			return await judge();
		} catch (error) {
			if (error instanceof RuntimeError) return { output: error.message, isError: true };
			throw error;
		}
	}

	private async execute(call: IToolCall, tool: ITool, context: IToolContext, args: Record<string, unknown>): Promise<IToolCallResult> {
		// 问完马上开始执行，中间不让出，见 ITool.staysForeground。
		if (!tool.background || tool.staysForeground?.(context, args)) return this.tools.run(tool, context, args);
		return this.runBackgroundable(call, tool, context, args, running => this.tools.run(tool, running, args), tool.backgroundSoon?.(args) === true);
	}

	/**
	 * 执行一次可能转后台的调用：先等一段时间（只算执行时间，等审批的时间不算；要早点转的只等几秒），或者工具执行到一半
	 * 自己要求现在转（context.backgroundNow，如 terminal 的 background），还没结束就转为后台任务。直接调用和脚本里的
	 * 调用共用这一段。转后台之前，运行被中止、任务被取消也会中止它。返回的是这次调用交给模型或脚本的结果：转了后台时
	 * 是一句说明，任务结束时的输出由运行时另外推送。
	 */
	private async runBackgroundable(
		call: IBackgroundCall, tool: ITool, context: IToolContext, args: Record<string, unknown>,
		start: (context: IToolContext) => Promise<IToolCallResult & { value?: unknown }>, soon: boolean,
	): Promise<IToolCallResult & { value?: unknown }> {
		const controller = new AbortController();
		const onAbort = () => controller.abort(context.signal.reason);
		context.signal.addEventListener('abort', onAbort, { once: true });
		// 工具自己要求现在转后台时，用它叫醒下面这个赛跑。
		let requestBackground!: () => void;
		const requested = new Promise<void>(resolve => { requestBackground = resolve; });
		const clock = new ExecutionClock();
		const startedAt = Date.now();
		const background: IToolContext = { ...context, signal: controller.signal, clock, mayBackground: true, backgroundNow: () => requestBackground() };
		const running = start(background);
		const stopTimer = new AbortController();
		try {
			const first = await Promise.race([
				running,
				clock.after(soon ? this.timing.earlyBackgroundAfterMs : this.timing.backgroundAfterMs, stopTimer.signal).then(() => undefined),
				requested.then(() => undefined),
			]);
			if (first) return first;
		} finally {
			stopTimer.abort();
			context.signal.removeEventListener('abort', onAbort);
		}
		context.signal.throwIfAborted();
		// 任务的结果要排在这次调用的结果后面：这次调用的结果在这里返回以后，由运行在同一轮微任务里记进时间线，
		// 所以等这一轮都跑完（setImmediate）再放行。任务恰好在转后台的时候结束，顺序也不会反。
		let recorded!: () => void;
		const taskId = this.tasks.adopt(call.memberId, call.runId, call.callId, tool.name, args, startedAt, controller, running, {
			recorded: new Promise<void>(resolve => { recorded = resolve; }),
			...tool.taskDelivery && { delivery: () => tool.taskDelivery!(args) },
		});
		try {
			return { output: await this.backgroundNotice(call, tool, background, args, taskId, soon), isError: false };
		} finally {
			setImmediate(recorded);
		}
	}

	/** 转为后台任务时交给模型的内容：工具自己写的，或者通用的写法。 */
	private async backgroundNotice(call: IBackgroundCall, tool: ITool, context: IToolContext, args: Record<string, unknown>, taskId: string, soon: boolean): Promise<string> {
		try {
			const notice = await tool.backgroundNotice?.(context, args, taskId);
			if (notice !== undefined) return notice;
		} catch (error) {
			// 工具写不出来时用通用的写法：任务已经转了，不能让这次调用因此出错。
			console.error(error);
		}
		// 写明最多运行多久（免得以为转后台就能一直跑）和到这时的输出（看得出启动成功没有）。
		const lines = [`${soon ? '仍在执行' : '执行时间较长'}，已转为后台任务 ${taskId}。完成后结果会作为新内容送达给你；可用 manage_background_tasks 查看或取消。`];
		const timeoutMs = tool.timeoutMs?.(args);
		if (timeoutMs !== undefined) lines.push(`最长运行 ${compactDuration(Math.round(timeoutMs / 1000))}，到时将终止。`);
		const recent = recentOutput(this.liveOutputs.read(call.runId, call.callId)?.output);
		if (recent !== null) lines.push(recent ? `截至目前的输出（最后 ${RECENT_LINES} 行以内）：\n${recent}` : '截至目前尚无输出。');
		return lines.join('\n');
	}
}

/** 审批判断的结果是不是要交给模型的错误结果（判断时发现参数不对）。 */
function isFailure(value: unknown): value is IToolCallResult {
	return typeof value === 'object' && value !== null && 'isError' in value;
}
