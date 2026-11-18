import { setTimeout as sleep } from 'node:timers/promises';
import type { EventHub } from '../common/events.ts';
import { errorMessage, invalid } from '../common/errors.ts';
import { clipEnd } from '../common/text.ts';
import type { Database } from '../database/database.ts';
import type { IMember, Members } from '../members/members.ts';
import { cacheKeyFor } from '../models/cacheKey.ts';
import { ModelError, type IModelClient, type IModelResponse, type IModelRequest, type ModelOutputStart } from '../models/client.ts';
import type { IResolvedModel, ModelConfig } from '../models/config.ts';
import type { IModelOutputItem, IOptimization, IOptimizationRequestRecord, Timeline, TimelineItem } from '../timeline/timeline.ts';
import type { Resources } from '../resources/resources.ts';
import type { ToolExecutor } from '../tools/executor.ts';
import { ApprovalWaits } from './approvalWaits.ts';
import type { ContextBuilder, IBuiltContext } from './context.ts';
import { JSON_OBJECT_FORMAT, outputText, reasoningText, type IContextUsage, type IOptimizationRequest, type Optimizer } from './optimizer.ts';
import type { ContextSnapshots } from './snapshots.ts';

export type RunKind = 'response' | 'optimization';
export type RunStatus = 'running' | 'completed' | 'failed' | 'stopped';

export interface IRun {
	readonly runId: number;
	readonly memberId: string;
	readonly kind: RunKind;
	readonly status: RunStatus;
	readonly error: string | null;
	readonly startedAt: number;
	readonly endedAt: number | null;
	/** 只在等审批的毫秒数，用时是结束减开始再减掉它。见设计文档「运行用时」。 */
	readonly waitedMs: number;
	readonly requestCount: number;
	readonly inputTokens: number;
	/** 输入里命中缓存的部分；没有一次请求报告过时是 null。 */
	readonly cachedTokens: number | null;
	readonly outputTokens: number;
}

export interface IContextUsageInfo extends IContextUsage {
	readonly contextWindow: number;
	/** 历史（收到的内容、工具调用、输出、摘要）合计，也就是能压缩的部分。 */
	readonly historyTokens: number;
	/** 现在不能手动压缩的原因；能压缩时是 null。 */
	readonly optimizeProblem: string | null;
}

/** 模型用量合计。token 都是上游返回的真实数字；cachedTokens 是其中命中缓存的那部分输入，没有请求报过缓存时是 0。 */
export interface IUsageTotals {
	readonly requests: number;
	readonly inputTokens: number;
	readonly cachedTokens: number;
	readonly outputTokens: number;
}

/** 用量怎么分组：按模型，或者按成员。 */
export type UsageGroupBy = 'model' | 'member';

/** 分组之后的一项：按模型时带 provider 和 model，按成员时带 memberId；key 是这一项的标识。 */
export interface IUsageGroup extends IUsageTotals {
	readonly key: string;
	readonly provider?: string;
	readonly model?: string;
	readonly memberId?: string;
}

/** 一段时间的用量：合计、按模型拆开，以及没成功的请求数。 */
export interface IUsage extends IUsageTotals {
	/** 没成功（失败、被停下）的请求数；它们的 token 不计入合计，也多半没有数字。 */
	readonly failedRequests: number;
	readonly since: number | null;
	readonly until: number | null;
	readonly groups: readonly IUsageGroup[];
}

/** 正在执行的工具调用。参数里的长文字截短了，只够前端写一句概括。 */
export interface IActivityCall {
	readonly callId: string;
	readonly name: string;
	readonly args: unknown;
}

/**
 * 正在运行的成员在做什么：model 是在等模型回复（思考或写字），tools 是在执行工具，optimizing 是在整理上下文。
 * output 是请求模型时模型正在输出的那一项：思考、文字，或者工具调用和工具名；还没开始输出、模型服务不说、
 * 不在请求模型时是 null。optimizationRequest 是整理上下文时的第几次请求：第一次的方案不合规、重新请求时是 2，
 * 不在整理上下文时是 null。since 是这一步开始的时间，开始输出另一项不算换了一步。
 */
export interface IMemberActivity {
	readonly runStartedAt: number;
	readonly phase: 'model' | 'tools' | 'optimizing';
	readonly calls: readonly IActivityCall[];
	readonly output: ModelOutputStart | null;
	readonly optimizationRequest: 1 | 2 | null;
	readonly since: number;
}

interface IActiveRun {
	readonly controller: AbortController;
	readonly approvalWaits: ApprovalWaits;
	done: Promise<void>;
	/** 中止的原因，记进运行。 */
	stopReason?: string;
}

/** 一次模型请求最多尝试的次数。 */
const MAX_ATTEMPTS = 3;
/** 模型什么都没返回时代它记下的一条空文字。 */
const EMPTY_REPLY: IModelOutputItem = { type: 'message', role: 'assistant', content: [] };
/** 一轮里的工具调用同时执行，最多这么多个。 */
const MAX_CONCURRENT_CALLS = 8;
/** models.json 没写 contextWindow 时按这个算。 */
const DEFAULT_CONTEXT_WINDOW = 128_000;
/** 输入到了上下文长度的这个比例就压缩：每次请求前，和回复运行正常结束时。 */
const OPTIMIZE_RATIO = 0.7;
/** 压缩请求放得下全部内容时，最多连续压几轮。 */
const MAX_OPTIMIZE_ROUNDS = 3;
/**
 * 分段压缩不限轮数，看进展：一轮让它带的这一段里能处理的内容缩小不到这个比例算没有进展。分段压缩多半出现在
 * 换了上下文更短的模型之后，命中不了缓存，缩小得太少不值得；按要求压时一份方案的摘要合计不超过它们代替的和删掉的内容的七成，
 * 正常一轮能省四到八成。
 */
const MIN_CHUNK_PROGRESS = 0.2;
/** 分段压缩连续这么多轮没有进展就停：给模型一次容错。 */
const MAX_STALLED_ROUNDS = 2;
/**
 * 没看过的内容攒到上下文长度的这个比例时，不管是不是会唤醒的内容都开始运行：
 * 没看过的内容不能压缩，再攒下去就放不下了；这个比例以内，看过的旧内容压缩以后，新内容连同规则、工具定义还放得下。
 */
const BACKLOG_RATIO = 0.3;
/**
 * 请求前没看过的内容超过上下文长度的这个比例，从最早的开始拿出上下文。比唤醒的三成高，
 * 接住唤醒到请求之间新来的内容；拿完以后加上规则、工具定义和压缩后的旧内容，仍低于压缩的七成。
 */
const OMIT_RATIO = 0.45;
/** 历史满这么多才能手动压缩，太少时压缩没有意义；上下文长度的 MANUAL_MIN_RATIO 更小时按它算。 */
const MANUAL_MIN_HISTORY = 48_000;
const MANUAL_MIN_RATIO = 0.6;
/** 压缩失败后（不论什么时机），这么久内运行结束时不压缩，请求前只在放不下时压缩；成功一次就不再等。手动压缩不受影响。 */
const OPTIMIZE_COOLDOWN_MS = 7 * 60 * 1000;
/** 推送正在做什么时，参数里的文字最多留这么长。 */
const ACTIVITY_TEXT_LIMIT = 200;

/**
 * 运行：成员被唤醒后，反复「请求模型 → 执行工具」，直到某一轮模型没有调用工具。
 * 每个成员同时只有一次运行（单独的压缩也算一次运行）；运行中收到的新消息在下一次请求模型时一并带上。
 */
export class Runs {
	private readonly db: Database;
	private readonly events: EventHub;
	private readonly members: Members;
	private readonly timeline: Timeline;
	private readonly context: ContextBuilder;
	private readonly optimizer: Optimizer;
	private readonly executor: ToolExecutor;
	private readonly snapshots: ContextSnapshots;
	private readonly models: ModelConfig;
	private readonly client: IModelClient;
	private readonly resources: Resources;
	/** 算 prompt_cache_key 用的盐：同一个数据目录恒定，不同数据目录不同。 */
	private readonly cacheSalt: string;
	private readonly active = new Map<string, IActiveRun>();
	/** 运行结束时的压缩失败的时间。 */
	private readonly optimizeFailedAt = new Map<string, number>();
	/** 拒绝了 json_schema 的模型（供应商 ID 和模型名）：压缩直接用 json_object。只记在内存里，重启后再试。 */
	private readonly jsonSchemaRejected = new Set<string>();
	private readonly activities = new Map<string, IMemberActivity>();
	/** 每个成员没看过的内容估算的 token，以及算到了哪一条。看到的位置变了就重算。 */
	private readonly backlogs = new Map<string, { seenThrough: number; throughItemId: number; tokens: number }>();
	private started = false;
	private unsubscribe: (() => void) | undefined;

	constructor(
		db: Database, events: EventHub, members: Members, timeline: Timeline, context: ContextBuilder, optimizer: Optimizer,
		executor: ToolExecutor, snapshots: ContextSnapshots, models: ModelConfig, client: IModelClient, resources: Resources, cacheSalt: string,
	) {
		this.db = db;
		this.events = events;
		this.members = members;
		this.timeline = timeline;
		this.context = context;
		this.optimizer = optimizer;
		this.executor = executor;
		this.snapshots = snapshots;
		this.models = models;
		this.client = client;
		this.resources = resources;
		this.cacheSalt = cacheSalt;
	}

	/** 开始调度：先处理启动前留下的唤醒，之后每当时间线有新内容就检查是否要开始运行。 */
	start(): void {
		if (this.started) return;
		const now = Date.now();
		this.db.transaction(() => {
			this.db.run(`UPDATE model_requests SET status = 'stopped', error = '运行时退出时中断', ended_at = ? WHERE status = 'running'`, now);
			this.db.run(`UPDATE runs SET status = 'stopped', error = '运行时退出时中断', ended_at = ? WHERE status = 'running'`, now);
		});
		this.executor.recover();
		this.started = true;
		this.unsubscribe = this.events.subscribe(item => {
			if (item.event.type === 'timeline.appended') this.reminder(item.event.memberId);
		});
		for (const member of this.members.list()) this.reminder(member.memberId);
	}

	/** 中止所有运行并等它们结束。 */
	async shutdown(): Promise<void> {
		this.started = false;
		this.unsubscribe?.();
		for (const run of this.active.values()) this.abort(run, '运行时退出');
		await this.idle();
	}

	/** 等到没有正在进行的运行（包括结束后接着开始的运行）。 */
	async idle(): Promise<void> {
		while (this.active.size > 0) await Promise.all([...this.active.values()].map(run => run.done));
	}

	isRunning(memberId: string): boolean {
		return this.active.has(memberId);
	}

	/** 正在运行的成员在做什么；没在运行时是 undefined。 */
	activity(memberId: string): IMemberActivity | undefined {
		return this.activities.get(memberId);
	}

	/** 暂停：中止正在进行的运行，之后照常收消息但不开始运行。 */
	pause(memberId: string): IMember {
		const member = this.members.setPaused(memberId, true);
		const run = this.active.get(memberId);
		if (run) this.abort(run, '已暂停');
		return member;
	}

	/** 中止成员正在进行的运行（成员被删除时），等它结束。 */
	async stop(memberId: string): Promise<void> {
		const run = this.active.get(memberId);
		if (!run) return;
		this.abort(run, '成员被删除');
		await run.done.catch(() => undefined);
	}

	/** 中止时带上原因：工具把中止写进结果时（如脚本、MCP 工具），写的是这句话。 */
	private abort(run: IActiveRun, reason: string): void {
		run.stopReason ??= reason;
		run.controller.abort(new Error('运行已停止'));
	}

	/** 有没有要处理的内容：没看过的、会唤醒它的内容，或者没看过的内容攒到了上下文长度的三成。 */
	hasPendingWake(memberId: string): boolean {
		if (this.timeline.hasPendingWake(memberId)) return true;
		const member = this.members.get(memberId);
		return !!member && member.type === 'ai' && this.unseenTokens(memberId) >= this.contextWindow(member) * BACKLOG_RATIO;
	}

	/** 成员恢复后：有要处理的内容就开始运行。 */
	wake(memberId: string): void {
		this.reminder(memberId);
	}

	/** 恢复暂停：有要处理的内容，或者暂停时停在了工具结果上，就开始运行。 */
	resume(memberId: string): IMember {
		const member = this.members.setPaused(memberId, false);
		this.reminder(memberId, true);
		return member;
	}

	/** 出错停止后重新处理：有要处理的内容，或者停在了工具结果上，就开始运行。出错的运行不会自动重来。 */
	retry(memberId: string): void {
		this.members.requireAi(memberId);
		if (!this.started) throw invalid('运行时尚未开始调度');
		this.reminder(memberId, true);
	}

	/**
	 * 最近一次回复运行没正常结束、要用户处理时的状态和原因，点重试接着运行：failed 是出错停止；interrupted 是停在了工具结果上
	 * （如运行时退出时中断）。没有（或之后又成功运行过）时为 undefined。
	 */
	stopReason(memberId: string): { readonly status: 'failed' | 'interrupted'; readonly error: string } | undefined {
		const last = this.db.get<{ status: RunStatus; error: string | null }>(
			`SELECT status, error FROM runs WHERE member_id = ? AND kind = 'response' AND status <> 'running' ORDER BY run_id DESC LIMIT 1`, memberId,
		);
		if (last?.status === 'failed') return { status: 'failed', error: last.error ?? '运行出错' };
		return last?.status === 'stopped' && this.stoppedOnToolResults(memberId) ? { status: 'interrupted', error: last.error ?? '运行已停止' } : undefined;
	}

	/**
	 * 模型用量：合计 model_requests 里上游返回的 token，可以只看某个成员、某段时间（毫秒时间戳，含 started_at 在 [since, until) 里的请求）。
	 * 失败的请求单独计数，token 不计入合计。
	 */
	usage(query: { memberId?: string; since?: number; until?: number; groupBy?: UsageGroupBy } = {}): IUsage {
		const groupBy = query.groupBy ?? 'model';
		const conditions: string[] = [];
		const params: (string | number)[] = [];
		if (query.memberId !== undefined) {
			conditions.push('run.member_id = ?');
			params.push(query.memberId);
		}
		if (query.since !== undefined) {
			conditions.push('request.started_at >= ?');
			params.push(query.since);
		}
		if (query.until !== undefined) {
			conditions.push('request.started_at < ?');
			params.push(query.until);
		}
		const range = conditions.length > 0 ? ` AND ${conditions.join(' AND ')}` : '';
		const groupColumns = groupBy === 'member'
			? 'run.member_id AS member_id'
			: 'request.provider AS provider, request.model AS model';
		const rows = this.db.all<{
			member_id: string | null; provider: string | null; model: string | null;
			requests: number; input_tokens: number; cached_tokens: number; output_tokens: number;
		}>(`
			SELECT ${groupColumns}, COUNT(*) AS requests,
				COALESCE(SUM(request.input_tokens), 0) AS input_tokens,
				COALESCE(SUM(request.cached_tokens), 0) AS cached_tokens,
				COALESCE(SUM(request.output_tokens), 0) AS output_tokens
			FROM model_requests request JOIN runs run ON run.run_id = request.run_id
			WHERE request.status = 'completed'${range}
			GROUP BY ${groupBy === 'member' ? 'run.member_id' : 'request.provider, request.model'}
			ORDER BY input_tokens DESC, ${groupBy === 'member' ? 'run.member_id' : 'request.provider, request.model'}
		`, ...params);
		const groups: IUsageGroup[] = rows.map(row => ({
			...this.usageTotals(row),
			...groupBy === 'member'
				? { key: row.member_id ?? '', memberId: row.member_id ?? undefined }
				: { key: `${row.provider ?? ''}/${row.model ?? ''}`, provider: row.provider ?? undefined, model: row.model ?? undefined },
		}));
		const totals = groups.reduce(
			(sum, item) => ({
				requests: sum.requests + item.requests, inputTokens: sum.inputTokens + item.inputTokens,
				cachedTokens: sum.cachedTokens + item.cachedTokens, outputTokens: sum.outputTokens + item.outputTokens,
			}),
			{ requests: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0 },
		);
		// 只数失败和被停下的：还在跑的请求不是失败，它们成功后进合计。
		const failed = this.db.get<{ failed: number }>(`
			SELECT COUNT(*) AS failed FROM model_requests request JOIN runs run ON run.run_id = request.run_id
			WHERE request.status IN ('failed', 'stopped')${range}`, ...params);
		return {
			...totals, failedRequests: failed?.failed ?? 0,
			since: query.since ?? null, until: query.until ?? null, groups,
		};
	}

	private usageTotals(row: { requests: number; input_tokens: number; cached_tokens: number; output_tokens: number }): IUsageTotals {
		return { requests: row.requests, inputTokens: row.input_tokens, cachedTokens: row.cached_tokens, outputTokens: row.output_tokens };
	}



	/** 手动压缩一轮。运行中、历史太少、全是最近的内容时拒绝。 */
	optimize(memberId: string): void {
		const problem = this.contextUsage(memberId).optimizeProblem;
		if (problem) throw invalid(problem);
		if (!this.started) throw invalid('运行时尚未开始调度');
		this.launch(memberId, 'optimization', (runId, signal) => this.optimizeManually(memberId, runId, signal));
	}

	/** 上下文用量，以及现在能不能手动压缩。 */
	contextUsage(memberId: string): IContextUsageInfo {
		const member = this.members.requireAi(memberId);
		const contextWindow = this.contextWindow(member);
		// 用量和能不能压缩看的是同一份上下文，拼一次。
		const units = this.context.units(memberId);
		const usage = this.optimizer.usage(member, this.context.prefix(member), units);
		const { incoming, toolCalls, outputs, summaries } = usage.categories;
		const historyTokens = incoming + toolCalls + outputs + summaries;
		const minHistory = Math.min(MANUAL_MIN_HISTORY, Math.floor(contextWindow * MANUAL_MIN_RATIO));
		const optimizeProblem = this.active.has(memberId) ? '正在运行，请在运行结束后再压缩'
			: historyTokens < minHistory ? `历史内容 ${kilo(historyTokens)}，达到 ${kilo(minHistory)} 后才能压缩`
				: !this.optimizer.canOptimize(memberId, contextWindow, units) ? '均为最近的内容，无法压缩' : null;
		return { contextWindow, ...usage, historyTokens, optimizeProblem };
	}

	list(memberId: string, limit = 50): IRun[] {
		return this.db.all<{
			run_id: number; member_id: string; kind: RunKind; status: RunStatus; error: string | null; started_at: number; ended_at: number | null; waited_ms: number;
			request_count: number; input_tokens: number; cached_tokens: number | null; output_tokens: number;
		}>(`
			SELECT run.*, COUNT(request.request_id) AS request_count,
				COALESCE(SUM(request.input_tokens), 0) AS input_tokens, SUM(request.cached_tokens) AS cached_tokens,
				COALESCE(SUM(request.output_tokens), 0) AS output_tokens
			FROM runs run LEFT JOIN model_requests request ON request.run_id = run.run_id
			WHERE run.member_id = ? GROUP BY run.run_id ORDER BY run.run_id DESC LIMIT ?
		`, memberId, Math.min(Math.max(limit, 1), 200)).map(row => ({
			runId: row.run_id, memberId: row.member_id, kind: row.kind, status: row.status, error: row.error,
			startedAt: row.started_at, endedAt: row.ended_at, waitedMs: row.waited_ms,
			requestCount: row.request_count, inputTokens: row.input_tokens, cachedTokens: row.cached_tokens, outputTokens: row.output_tokens,
		}));
	}

	/** continueStopped：用户恢复、重试时，停在了工具结果上也开始运行，不需要新内容。 */
	private reminder(memberId: string, continueStopped = false): void {
		if (!this.started || this.active.has(memberId)) return;
		const member = this.members.get(memberId);
		if (!member || member.type !== 'ai' || member.deleted || member.paused) return;
		if (!this.hasPendingWake(memberId) && !(continueStopped && this.stoppedOnToolResults(memberId))) return;
		this.launch(memberId, 'response', (runId, signal) => this.respond(memberId, runId, signal));
	}

	/**
	 * 开始一次运行。结束后：正常结束的回复运行，如果又来了会唤醒的内容就接着运行，否则输入到了七成就马上压缩，
	 * 下次被唤醒时不用先等；失败的回复运行不自动重来；压缩运行结束后检查有没有要处理的唤醒。
	 */
	private launch(memberId: string, kind: RunKind, body: (runId: number, signal: AbortSignal) => Promise<void>): void {
		const run: IActiveRun = { controller: new AbortController(), approvalWaits: new ApprovalWaits(), done: Promise.resolve() };
		this.active.set(memberId, run);
		run.done = this.execute(memberId, kind, run, body).then(status => {
			this.active.delete(memberId);
			if (!this.started) return;
			if (kind === 'optimization') {
				this.reminder(memberId);
			} else if (status === 'stopped') {
				// 暂停后收尾期间就恢复了：恢复时它还在运行，没接着运行，这里再看一次。仍在暂停、被删除时 reminder 不运行。
				this.reminder(memberId, true);
			} else if (status === 'completed') {
				if (this.hasPendingWake(memberId)) {
					this.reminder(memberId);
				} else if (this.shouldOptimizeAfterRun(memberId)) {
					this.launch(memberId, 'optimization', (runId, signal) => this.optimizeAfterRun(memberId, runId, signal));
				}
			}
		});
	}

	private async execute(memberId: string, kind: RunKind, run: IActiveRun, body: (runId: number, signal: AbortSignal) => Promise<void>): Promise<RunStatus> {
		await Promise.resolve();
		const runId = this.db.transaction(() => {
			const id = this.db.run(`INSERT INTO runs (member_id, kind, status, started_at) VALUES (?, ?, 'running', ?)`, memberId, kind, Date.now()).lastId;
			this.events.emit({ type: 'run.changed', memberId, runId: id });
			return id;
		});
		const startedAt = Date.now();
		this.setActivity(memberId, {
			runStartedAt: startedAt, phase: kind === 'optimization' ? 'optimizing' : 'model', calls: [], output: null, optimizationRequest: null, since: startedAt,
		});
		let status: RunStatus = 'completed';
		let error: string | null = null;
		try {
			await body(runId, run.controller.signal);
		} catch (caught) {
			if (run.controller.signal.aborted) {
				status = 'stopped';
				error = run.stopReason ?? '已暂停';
			} else {
				status = 'failed';
				if (!(caught instanceof ModelError)) console.error(caught);
				error = errorText(caught);
			}
		}
		this.setActivity(memberId, undefined);
		this.db.transaction(() => {
			this.db.run('UPDATE runs SET status = ?, error = ?, waited_ms = ?, ended_at = ? WHERE run_id = ?', status, error, run.approvalWaits.waitedMs(), Date.now(), runId);
			this.events.emit({ type: 'run.changed', memberId, runId });
		});
		return status;
	}

	/** 回复运行的主体。 */
	private async respond(memberId: string, runId: number, signal: AbortSignal): Promise<void> {
		const { approvalWaits } = this.active.get(memberId)!;
		// 用户审批时选了「本次运行中允许此工具」的工具，这次运行里不再审批。
		const runAllowed = new Set<string>();
		while (true) {
			// 每次请求重新读成员：改了模型从下一次请求开始用新的，运行中途也一样。
			const member = this.members.requireAi(memberId);
			const model = this.models.resolve(member.model);
			// 判断要不要压缩时拼好的上下文，后面没有变动就直接用。
			let built = await this.ensureRoom(runId, member, model, signal);
			// 开头的内容不变，除了快照重新生成的时候：换了模型、压缩之后、运行时重启，用户改了设定或记忆。
			// 其他时候能用的工具、运行环境和通讯录有变动，和上一次请求时比，在时间线里追加一条说明，上下文要重新拼。
			await this.snapshots.prepare(member);
			const notice = this.snapshots.changes(member);
			if (notice) {
				this.db.transaction(() => this.timeline.appendChangeNotice(memberId, notice));
				built = undefined;
			}
			built ??= this.context.build(memberId);
			const { seenThroughItemId } = built;
			const input = this.context.input(this.context.prefix(member), built);
			this.changeActivity(memberId, { phase: 'model', calls: [] });
			// 这次请求看到的收到的内容在上下文里排在它前面（运行时设计第 5 部分「上下文里的先后」）。拼完以后才到的留到下一次请求。
			const requestId = this.db.transaction(() => {
				const id = this.insertRequest(runId, 'response', model, seenThroughItemId);
				this.timeline.markRequested(memberId, id, seenThroughItemId);
				return id;
			});
			const response = await this.request(requestId, signal, {
				...this.requestBase(member, model),
				input: this.resources.materialize(input, model.entry.vision),
				tools: this.snapshots.current(member).tools,
			}, (kind, delta, attempt) => this.events.delta({ type: 'run.delta', memberId, runId, requestId, attempt, kind, delta }), output => this.changeOutput(memberId, output));
			const itemIds = this.db.transaction(() => {
				this.completeRequest(requestId, response);
				// 没有实际产出的一轮也记下，给使用者看，记成没带回，组装上下文时不读。什么都没返回时记一条空文字，网页端才显示得出「空回复」。
				const ids = this.timeline.appendModelOutputs(memberId, requestId, response.output.length > 0 ? response.output : [EMPTY_REPLY]);
				this.timeline.markSeen(memberId, seenThroughItemId);
				return ids;
			});
			// 每个调用在时间线里的条目：工具据此记下是哪次调用做的（如发出的消息）。
			const callItems = new Map(response.output.flatMap((output, index) => output.type === 'function_call' ? [[output, itemIds[index]!] as const] : []));
			const calls = [...callItems.keys()];
			if (calls.length === 0) break;
			this.changeActivity(memberId, {
				phase: 'tools',
				calls: calls.map(call => ({ callId: String(call['call_id']), name: String(call['name']), args: activityArgs(call['arguments']) })),
			});
			// 运行停止时每个调用也都记下结果（没执行、执行到一半），之后再结束运行。
			await runConcurrently(calls, MAX_CONCURRENT_CALLS, async call => {
				const name = String(call['name']);
				const callId = String(call['call_id']);
				const rawArguments = typeof call['arguments'] === 'string' ? call['arguments'] : '';
				const tracked = approvalWaits.start();
				const result = await this.executor.call({ memberId, runId, callId, itemId: callItems.get(call)!, name, rawArguments, signal, waitingApproval: tracked.wait, runAllowed })
					.finally(tracked.end);
				this.db.transaction(() => this.timeline.appendToolResult(memberId, requestId, { callId, name, ...result }));
				this.removeActivityCall(memberId, callId);
			});
			signal.throwIfAborted();
		}
	}

	/**
	 * 请求前：没看过的内容太多时先拿掉一部分，输入到了七成就先压缩；压缩失败后的冷却时间里只在放不下时压缩。
	 * 压缩失败或压完仍偏长时，只要还放得下就照常请求；放不下这次运行就失败。
	 * 返回最后判断时拼好的上下文，请求直接用；压缩出错后照常请求时没有，请求时再拼。
	 */
	private async ensureRoom(runId: number, member: IMember, model: IResolvedModel, signal: AbortSignal): Promise<IBuiltContext | undefined> {
		const max = windowOf(model);
		this.omitOverflow(member, max);
		if (this.optimizeCoolingDown(member.memberId)) {
			const built = this.context.build(member.memberId);
			if (this.optimizer.inputTokens(member, this.context.prefix(member), built.units) <= max) return built;
		}
		let room: { inputTokens: number; built: IBuiltContext };
		try {
			room = await this.optimizeRounds(runId, member, model, signal, 'before_request');
		} catch (error) {
			if (signal.aborted || this.optimizer.inputTokens(member, this.context.prefix(member)) > max) throw error;
			// 压缩这一轮没成功，但上下文还装得下：这次不压缩，接着请求。只记一行，不打堆栈，
			// 否则日志里看着像崩了（压缩失败本来就是把问题交给模型再试一次之后才出现的）。
			console.error(`这次不压缩：${errorMessage(error)}`);
			return undefined;
		}
		if (room.inputTokens > max) throw new ModelError('context', `上下文过长（估算约 ${room.inputTokens} token），压缩后仍超过模型上限 ${max}`, false);
		return room.built;
	}

	/**
	 * 没看过的内容超过上下文长度的四成五时，从最早的开始拿出上下文，直到不超过四成五：先拿不唤醒的，
	 * 会唤醒的本身就超过时也从最早的拿。最新的一条会唤醒的内容总是留着，只要它加上固定内容放得下。
	 * 拿掉的原文还在，在第一条被拿掉的位置放一条说明。
	 */
	private omitOverflow(member: IMember, contextWindow: number): void {
		const memberId = member.memberId;
		const limit = contextWindow * OMIT_RATIO;
		if (this.unseenTokens(memberId) <= limit) return;
		const unseen: { item: TimelineItem; tokens: number }[] = [];
		for (let afterItemId = this.seenThrough(memberId); ;) {
			const items = this.timeline.list(memberId, { afterItemId, limit: 500 });
			if (items.length === 0) break;
			for (const item of items) {
				const tokens = this.context.incomingTokens(memberId, item);
				// 变动说明和计划说明不拿：它们很短，拿掉了成员就不知道有变动、还有哪些事没做。
				if (tokens > 0 && item.kind !== 'change_notice' && item.kind !== 'plan') unseen.push({ item, tokens });
			}
			afterItemId = items.at(-1)!.itemId;
		}
		// 最新的一条会唤醒的内容总是留着：拿掉它，成员就看不到要处理的事。
		const newest = unseen.findLast(entry => entry.item.wakes);
		const kept = newest && newest.tokens + this.optimizer.fixedTokens(member, this.context.prefix(member)) <= contextWindow ? newest : undefined;
		let total = unseen.reduce((sum, entry) => sum + entry.tokens, 0);
		const omitted = new Set<TimelineItem>();
		for (const wakes of [false, true]) {
			for (const entry of unseen) {
				if (total <= limit) break;
				if (entry.item.wakes !== wakes || entry === kept) continue;
				omitted.add(entry.item);
				total -= entry.tokens;
			}
		}
		if (omitted.size === 0) return;
		this.db.transaction(() => this.timeline.omit(memberId, unseen.map(entry => entry.item).filter(item => omitted.has(item))));
		this.backlogs.delete(memberId);
	}

	/**
	 * 输入到了七成就压缩，直到低于七成。压缩请求放得下全部内容时最多连续 3 轮，某一轮没有变短就停；
	 * 分段压缩时每段一轮，连续两轮这一段缩小不到两成就停。没有可以处理的内容时也停下。返回停下时估算的输入，和估算时拼好的上下文。
	 * 每一轮的判断、估算和压缩请求用同一份拼好的上下文。
	 */
	private async optimizeRounds(
		runId: number, member: IMember, model: IResolvedModel, signal: AbortSignal, trigger: IOptimization['trigger'],
	): Promise<{ inputTokens: number; built: IBuiltContext }> {
		const max = windowOf(model);
		let previous = Infinity;
		let rounds = 0;
		let stalled = 0;
		let chunkTokens: number | undefined;
		for (;;) {
			const prefix = this.context.prefix(member);
			const built = this.context.build(member.memberId);
			const inputTokens = this.optimizer.inputTokens(member, prefix, built.units);
			const stop = { inputTokens, built };
			if (inputTokens < max * OPTIMIZE_RATIO) return stop;
			// 有没有变短、缩小了多少，前后都按全部内容估算：压缩前的 inputTokens 用的是模型报告的实际用量，和压缩后的估算比不准。
			const estimate = this.optimizer.estimate(member, prefix, built.units);
			if (chunkTokens !== undefined) {
				// 上一轮是分段压缩：中间有一轮有进展就重新算。
				stalled = previous - estimate < chunkTokens * MIN_CHUNK_PROGRESS ? stalled + 1 : 0;
				if (stalled >= MAX_STALLED_ROUNDS) return stop;
			} else if (estimate >= previous) {
				return stop;
			}
			previous = estimate;
			const request = this.optimizer.request(member, prefix, max, built.units);
			if (!request || (request.chunkTokens === undefined && ++rounds > MAX_OPTIMIZE_ROUNDS)) return stop;
			chunkTokens = request.chunkTokens;
			await this.optimizeOnce(runId, member, model, request, signal, trigger, estimate);
		}
	}

	/** 运行正常结束时输入到了七成：马上压缩。 */
	private async optimizeAfterRun(memberId: string, runId: number, signal: AbortSignal): Promise<void> {
		const member = this.members.requireAi(memberId);
		await this.optimizeRounds(runId, member, this.models.resolve(member.model), signal, 'after_run');
	}

	/** 手动压缩：不管有没有到七成，压一轮。 */
	private async optimizeManually(memberId: string, runId: number, signal: AbortSignal): Promise<void> {
		const member = this.members.requireAi(memberId);
		const model = this.models.resolve(member.model);
		const prefix = this.context.prefix(member);
		const units = this.context.units(memberId);
		const request = this.optimizer.request(member, prefix, windowOf(model), units);
		if (!request) return;
		await this.optimizeOnce(runId, member, model, request, signal, 'manual', this.optimizer.estimate(member, prefix, units));
	}

	/**
	 * 请模型压缩一次。方案有不合规的地方时整份不执行，带着这次的输出和不合规的地方再请求一次；
	 * 第二次合规的执行、不合规的跳过，一个都用不上时报错。结束时写压缩记录：完成的和结果在同一个事务里、排在结果前面，
	 * 出错、停止的也写。before 是整理前按全部内容的估算。
	 * 服务拒绝 json_schema 时，这次请求改用 json_object 马上重新请求，记住这个模型不支持，被拒的那次算一次自动重试。
	 * 出错后一段时间内请求前、运行结束时不再压缩（见 optimizeCoolingDown），成功一次就不再等。
	 */
	private async optimizeOnce(
		runId: number, member: IMember, model: IResolvedModel, built: IOptimizationRequest, signal: AbortSignal, trigger: IOptimization['trigger'], before: number,
	): Promise<void> {
		const memberId = member.memberId;
		const startedAt = Date.now();
		const requests: IOptimizationRequestRecord[] = [];
		const record = (status: IOptimization['status'], error: string | null, after: number | null): IOptimization => ({
			trigger, status, error, startedAt, endedAt: Date.now(), estimate: { before, after }, requests,
		});
		let input = built.input;
		// 这次请求已经推送出来的思考：请求中途出错、停止时记下这部分；自动重试会从头再来。
		let streamed = '';
		try {
			const modelKey = `${model.provider.id}\n${model.entry.model}`;
			for (const attempt of [1, 2] as const) {
				this.changeActivity(memberId, { phase: 'optimizing', calls: [], optimizationRequest: attempt });
				const index = requests.length;
				const retries: string[] = [];
				let requestId = 0;
				let response: IModelResponse | undefined;
				while (!response) {
					const objectOnly = this.jsonSchemaRejected.has(modelKey);
					const id = requestId = this.insertRequest(runId, 'optimization', model, this.timeline.latestItemId(memberId));
					requests[index] = { requestId, reasoning: '', output: null, problems: [], retries, inputTokens: null, cachedTokens: null, outputTokens: null };
					streamed = '';
					try {
						response = await this.request(requestId, signal, {
							...this.requestBase(member, model),
							input: this.resources.materialize(input, model.entry.vision),
							// 和正常请求保持一样的工具列表，前面的内容一致，才有机会命中缓存。
							tools: this.snapshots.current(member).tools,
							toolChoice: 'none',
							textFormat: objectOnly ? JSON_OBJECT_FORMAT : built.textFormat,
						}, (kind, delta, tryNumber) => {
							// 输出的是方案的 JSON，生成中看没有意义，只推思考。
							if (kind !== 'reasoning') return;
							streamed += delta;
							this.events.delta({ type: 'run.delta', memberId, runId, requestId: id, attempt: tryNumber, kind, delta });
						}, () => undefined, error => {
							retries.push(error);
							streamed = '';
						});
					} catch (error) {
						if (objectOnly || !schemaRejected(error)) throw error;
						this.jsonSchemaRejected.add(modelKey);
						retries.push(error.message);
					}
				}
				const proposal = this.optimizer.check(memberId, built, response.output);
				requests[index] = {
					requestId, reasoning: reasoningText(response.output), output: outputText(response.output), problems: proposal.problems, retries,
					inputTokens: response.usage?.inputTokens ?? null, cachedTokens: response.usage?.cachedTokens ?? null, outputTokens: response.usage?.outputTokens ?? null,
				};
				if (proposal.problems.length > 0 && attempt === 1) {
					this.completeRequest(requestId, response);
					input = this.optimizer.retryInput(built, response.output, proposal.problems);
					continue;
				}
				if (proposal.context.length === 0) {
					this.completeRequest(requestId, response);
					throw new ModelError('optimization', `压缩未给出可用的操作：${proposal.problems.slice(0, 3).join('；')}`, false);
				}
				// 摘要的关键词先核对好再执行：可能要分批读很多旧的原文，不放在事务里。
				const verified = await this.optimizer.verifyKeywords(memberId, built, proposal, signal);
				this.db.transaction(() => {
					this.completeRequest(requestId, response);
					const itemId = this.timeline.appendOptimization(memberId, record('completed', null, null));
					this.optimizer.apply(memberId, built, verified);
					this.timeline.updateOptimization(memberId, itemId, record('completed', null, this.optimizer.estimate(member, this.context.prefix(member))));
				});
				this.optimizeFailedAt.delete(memberId);
				return;
			}
		} catch (error) {
			const stopped = signal.aborted;
			const reason = stopped ? this.active.get(memberId)?.stopReason ?? '已暂停' : errorText(error);
			const last = requests.at(-1);
			if (last && last.output === null) requests[requests.length - 1] = { ...last, reasoning: streamed };
			this.db.transaction(() => this.timeline.appendOptimization(memberId, record(stopped ? 'stopped' : 'failed', reason, null)));
			if (!stopped) this.optimizeFailedAt.set(memberId, Date.now());
			throw error;
		}
	}

	/** 运行结束时要不要马上压缩：输入到了七成，有可以处理的内容，不在失败后的冷却时间里。 */
	private shouldOptimizeAfterRun(memberId: string): boolean {
		const member = this.members.get(memberId);
		if (!member || member.type !== 'ai' || member.paused || this.optimizeCoolingDown(memberId)) return false;
		let model: IResolvedModel;
		try {
			model = this.models.resolve(member.model);
		} catch {
			return false;
		}
		const max = windowOf(model);
		const units = this.context.units(memberId);
		return this.optimizer.inputTokens(member, this.context.prefix(member), units) >= max * OPTIMIZE_RATIO
			&& this.optimizer.canOptimize(memberId, max, units);
	}

	/**
	 * 压缩失败后的冷却时间里：不论是哪个时机失败的，运行结束时不再压缩，请求前只在放不下时压缩。
	 * 失败多半是模型服务的问题，马上再试多半还是失败；手动压缩不受影响。
	 */
	private optimizeCoolingDown(memberId: string): boolean {
		const failedAt = this.optimizeFailedAt.get(memberId);
		return failedAt !== undefined && Date.now() - failedAt < OPTIMIZE_COOLDOWN_MS;
	}

	/**
	 * 上一次回复运行停在了工具结果上：最后一次完成的回复请求调用了工具，结果还在上下文里，模型还没看过。
	 * 最后一次请求按运行、再按请求倒序找，原因见 Optimizer 的 measure。
	 */
	private stoppedOnToolResults(memberId: string): boolean {
		const last = this.db.get<{ request_id: number }>(`
			SELECT request.request_id FROM model_requests request JOIN runs run ON run.run_id = request.run_id
			WHERE run.member_id = ? AND request.kind = 'response' AND request.status = 'completed' ORDER BY run.run_id DESC, request.request_id DESC LIMIT 1
		`, memberId);
		if (!last) return false;
		return this.timeline.forRequest(memberId, last.request_id).some(item => item.contextState === 'visible'
			&& (item.kind === 'tool_result' || (item.kind === 'model_output' && item.output.type === 'function_call')));
	}

	private setActivity(memberId: string, activity: IMemberActivity | undefined): void {
		if (activity) this.activities.set(memberId, activity);
		else this.activities.delete(memberId);
		this.events.delta({ type: 'member.activity', memberId, activity: activity ?? null });
	}

	/** 换到新的一步。 */
	private changeActivity(memberId: string, change: Pick<IMemberActivity, 'phase' | 'calls'> & { readonly optimizationRequest?: 1 | 2 }): void {
		const current = this.activities.get(memberId);
		if (current) this.setActivity(memberId, { ...current, ...change, optimizationRequest: change.optimizationRequest ?? null, output: null, since: Date.now() });
	}

	/** 请求模型时模型开始输出另一项；重试时回到 null。还是同一步，这一步开始的时间不变。 */
	private changeOutput(memberId: string, output: ModelOutputStart | null): void {
		const current = this.activities.get(memberId);
		if (current?.phase !== 'model' || JSON.stringify(current.output) === JSON.stringify(output)) return;
		this.setActivity(memberId, { ...current, output });
	}

	/** 一个工具调用执行完了：从正在执行的里去掉，这一步开始的时间不变。 */
	private removeActivityCall(memberId: string, callId: string): void {
		const current = this.activities.get(memberId);
		if (current) this.setActivity(memberId, { ...current, calls: current.calls.filter(call => call.callId !== callId) });
	}

	/** 模型的上下文长度。模型没配好时按默认长度算，真正请求时再报错。 */
	private contextWindow(member: IMember): number {
		try {
			return windowOf(this.models.resolve(member.model));
		} catch {
			return DEFAULT_CONTEXT_WINDOW;
		}
	}

	/** 没看过的内容估算多少 token：接着上次算到的那一条往后加，每次只算新来的。 */
	private unseenTokens(memberId: string): number {
		const seenThrough = this.seenThrough(memberId);
		let backlog = this.backlogs.get(memberId);
		if (!backlog || backlog.seenThrough !== seenThrough) this.backlogs.set(memberId, backlog = { seenThrough, throughItemId: seenThrough, tokens: 0 });
		for (;;) {
			const items = this.timeline.list(memberId, { afterItemId: backlog.throughItemId, limit: 500 });
			if (items.length === 0) return backlog.tokens;
			for (const item of items) backlog.tokens += this.context.incomingTokens(memberId, item);
			backlog.throughItemId = items.at(-1)!.itemId;
		}
	}

	private seenThrough(memberId: string): number {
		return this.db.get<{ seen_through_item_id: number }>('SELECT seen_through_item_id FROM member_states WHERE member_id = ?', memberId)?.seen_through_item_id ?? 0;
	}

	private requestBase(member: IMember, model: IResolvedModel) {
		return {
			connection: { baseUrl: model.provider.baseUrl, endpointMode: model.provider.endpointMode, apiKey: model.provider.apiKey },
			model: model.entry.model,
			reasoningEffort: member.reasoningEffort,
			maxOutputTokens: model.entry.maxOutputTokens,
			promptCacheKey: cacheKeyFor(this.cacheSalt, member.memberId),
		};
	}

	private insertRequest(runId: number, kind: RunKind, model: IResolvedModel, seenThroughItemId: number): number {
		return this.db.run(
			`INSERT INTO model_requests (run_id, kind, provider, model, seen_through_item_id, status, started_at) VALUES (?, ?, ?, ?, ?, 'running', ?)`,
			runId, kind, model.provider.id, model.entry.model, seenThroughItemId, Date.now(),
		).lastId;
	}

	private completeRequest(requestId: number, response: IModelResponse): void {
		this.db.run(
			`UPDATE model_requests SET status = 'completed', input_tokens = ?, cached_tokens = ?, output_tokens = ?, ended_at = ? WHERE request_id = ?`,
			response.usage?.inputTokens ?? null, response.usage?.cachedTokens ?? null, response.usage?.outputTokens ?? null, Date.now(), requestId,
		);
	}

	/**
	 * 请求一次模型，按重试规则重试，每次重试前用 onRetry 交出这次的错误。失败时把这次请求标成失败或停止，再把错误抛出去。
	 * onDelta 带着第几次尝试：重试时模型从头输出。
	 */
	private async request(
		requestId: number, signal: AbortSignal, request: IModelRequest,
		onDelta: (kind: 'text' | 'reasoning', delta: string, attempt: number) => void, onOutput: (output: ModelOutputStart | null) => void,
		onRetry: (error: string) => void = () => undefined,
	): Promise<IModelResponse> {
		for (let attempt = 1; ; attempt++) {
			// 重试时从头输出，上一次输出到哪一项不算数。
			if (attempt > 1) onOutput(null);
			try {
				return await this.client.respond(request, signal, (kind, delta) => onDelta(kind, delta, attempt), onOutput);
			} catch (error) {
				const retry = !signal.aborted && error instanceof ModelError && error.retryable && attempt < MAX_ATTEMPTS;
				if (retry) {
					onRetry(error.message);
					try {
						await sleep(attempt === 1 ? 1000 : 2000, undefined, { signal });
						continue;
					} catch {
						// 等待重试时被中止，按中止处理。
					}
				}
				this.db.run(
					'UPDATE model_requests SET status = ?, error = ?, ended_at = ? WHERE request_id = ?',
					signal.aborted ? 'stopped' : 'failed', errorMessage(error), Date.now(), requestId,
				);
				throw error;
			}
		}
	}
}

/** 服务不支持 json_schema：参数错误（不能重试），报错提到格式参数。 */
function schemaRejected(error: unknown): error is ModelError {
	return error instanceof ModelError && !error.retryable && /text\.format|response_format|json_schema/i.test(error.message);
}

/** 运行、压缩出错时记下的原因：模型的错误原样写，别的是运行时内部错误。 */
function errorText(error: unknown): string {
	return error instanceof ModelError ? error.message : `运行时内部错误：${errorMessage(error)}`;
}

/**
 * 同时执行，最多 limit 个，按给出的顺序启动：立刻完成的调用（比如发消息）完成顺序就是给出的顺序。
 * 全部结束后，如果有出错的，抛出第一个错误。
 */
async function runConcurrently<T>(items: readonly T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	const errors: unknown[] = [];
	const lane = async () => {
		while (next < items.length) {
			try {
				await worker(items[next++]!);
			} catch (error) {
				errors.push(error);
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
	if (errors.length > 0) throw errors[0];
}

/** 推送用的工具参数：解析出来，长文字截短，太长的数组只留前几项，嵌套太深的省略。解析不了时省略。 */
function activityArgs(raw: unknown): unknown {
	if (typeof raw !== 'string') return undefined;
	try {
		return shorten(JSON.parse(raw), 0);
	} catch {
		return undefined;
	}
}

function shorten(value: unknown, depth: number): unknown {
	if (typeof value === 'string') return clipEnd(value, ACTIVITY_TEXT_LIMIT);
	if (value === null || typeof value !== 'object') return value;
	if (depth >= 3) return undefined;
	if (Array.isArray(value)) return value.slice(0, 10).map(item => shorten(item, depth + 1));
	return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shorten(item, depth + 1)]));
}

/** 模型的上下文长度，models.json 没写时按默认长度算。 */
function windowOf(model: IResolvedModel): number {
	return model.entry.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
}

/** token 数写成 23.4k 这样；整千时不带小数。 */
function kilo(tokens: number): string {
	return tokens < 1000 ? String(tokens) : `${Number((tokens / 1000).toFixed(1))}k`;
}
