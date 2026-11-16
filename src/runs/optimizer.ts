import { setImmediate as nextTurn } from 'node:timers/promises';
import { errorMessage } from '../common/errors.ts';
import { clipEnd } from '../common/text.ts';
import type { Database } from '../database/database.ts';
import type { IMember } from '../members/members.ts';
import type { Messages } from '../messages/messages.ts';
import { MEMORY_HARD_LIMIT, MEMORY_LIMIT, applyMemoryOperation, type Memories, type MemoryOperation } from '../members/memory.ts';
import type { Plans } from '../plans/plans.ts';
import { timeRangeText } from '../timeline/clock.ts';
import { addCounts, countContent, type IContentCounts } from '../timeline/counts.ts';
import { hasVisibleOutput, messageText, type IModelOutputItem, type Timeline, type TimelineItem } from '../timeline/timeline.ts';
import { searchableItemText } from '../tools/chat/searchHistory.ts';
import { replayOutput, summaryMessage, userMessage, type ContextBuilder, type ContextUnit } from './context.ts';
import { externalBody, searchText } from './describe.ts';
import type { ContextSnapshots } from './snapshots.ts';
import { estimateTokens } from './tokens.ts';

export interface IOptimizationRequest {
	readonly input: object[];
	readonly textFormat: Record<string, unknown>;
	/** 这次可以处理的编号，和每个编号管着的内容，按先后排。 */
	readonly groups: ReadonlyMap<number, readonly ContextUnit[]>;
	/** 上下文里全部的编号，包括不能处理的。 */
	readonly numbers: ReadonlySet<number>;
	/** 分段压缩：放不下全部内容，这次按先后只带了最早的一段，这是其中能处理的内容的估算。不分段时是 undefined。 */
	readonly chunkTokens: number | undefined;
	/** 能处理的摘要占上下文长度的比例超过了上限，这次必须处理其中一部分；没超过时是 undefined。 */
	readonly summaryShare: number | undefined;
}

type ContextOperation =
	| { readonly op: 'summarize'; readonly numbers: readonly number[]; readonly summary: string; readonly keywords: readonly string[] }
	| { readonly op: 'prune'; readonly numbers: readonly number[] };

/** 检查过的压缩方案：合规的操作，和不合规的地方。 */
export interface ICheckedProposal {
	readonly context: readonly ContextOperation[];
	readonly memory: readonly MemoryOperation[];
	readonly problems: readonly string[];
}

/** 上下文的各部分：开头和末尾的系统内容、工具定义、记忆，以及历史里的收到的内容、工具调用和结果、输出的文字和思考、摘要。 */
export type ContextCategory = 'system' | 'tools' | 'memory' | 'incoming' | 'toolCalls' | 'outputs' | 'summaries';

export interface IContextUsage {
	/** 下一次请求的输入，和 inputTokens 算出的一样。 */
	readonly usedTokens: number;
	/** 各部分的估算，按比例分摊到 usedTokens，加起来正好等于它。 */
	readonly categories: Readonly<Record<ContextCategory, number>>;
}

/** 一个编号和它管着的内容：没调用工具的回复没有编号，跟着前面最近的编号。protected 是不能处理。 */
interface IGroup {
	readonly number: number;
	readonly units: ContextUnit[];
	protected: boolean;
}

/** 压缩请求不超过上下文长度的这个比例，留下的给输出和兜底的第二次请求。 */
const REQUEST_RATIO = 0.8;
/** 一份方案里摘要的估算合计，要小于它们代替的和删掉的内容的这个比例才执行。 */
const MAX_SUMMARY_RATIO = 0.7;
/** 最近的内容不能处理：没看过的内容，和它前面按组往前累计到上下文长度这个比例的内容。 */
const RECENT_RATIO = 0.05;
/** 能处理的摘要超过上下文长度的这个比例时，这次必须合并、精简或删掉其中一部分。 */
const SUMMARY_SHARE_LIMIT = 0.25;
const SNIPPET_LENGTH = 40;
/** 每条摘要最多留几个关键词，每个关键词最长多少字符：再长就是整句话了。 */
const MAX_KEYWORDS = 10;
const MAX_KEYWORD_LENGTH = 64;
/** 校验关键词时，被旧摘要代替的原文每批取多少条：只在前面的内容里没找全时才取，找全了就停。 */
const ORIGINALS_BATCH = 500;

/** 上下文压缩：估算长度、构造压缩请求、检查并执行模型给出的方案。 */
export class Optimizer {
	private readonly db: Database;
	private readonly timeline: Timeline;
	private readonly context: ContextBuilder;
	private readonly snapshots: ContextSnapshots;
	private readonly memories: Memories;
	private readonly messages: Messages;
	private readonly plans: Plans;
	private readonly recentRatio: number;

	constructor(
		db: Database, timeline: Timeline, context: ContextBuilder, snapshots: ContextSnapshots, memories: Memories, messages: Messages, plans: Plans,
		recentRatio = RECENT_RATIO,
	) {
		this.db = db;
		this.timeline = timeline;
		this.messages = messages;
		this.context = context;
		this.snapshots = snapshots;
		this.memories = memories;
		this.plans = plans;
		this.recentRatio = recentRatio;
	}

	/** 最近一次压缩生效的时间，没压缩过是 0。 */
	private optimizedAt(memberId: string): number {
		return this.db.get<{ optimized_at: number }>('SELECT optimized_at FROM member_states WHERE member_id = ?', memberId)?.optimized_at ?? 0;
	}

	/**
	 * 估算下一次请求的输入长度：上一次请求模型返回的实际输入 token，加上之后新增内容的估算。
	 * 压缩生效后上一次的用量不再准确，改为整体估算（包括工具定义）。units 是已经拼好的上下文，同一时刻要用好几次时只拼一次。
	 */
	inputTokens(member: IMember, prefix: readonly object[], units: readonly ContextUnit[] = this.context.units(member.memberId)): number {
		return this.measure(member, prefix, units);
	}

	/** 上下文用量和各部分的分布。各部分是估算，按比例分摊到 inputTokens 算出的输入上。 */
	usage(member: IMember, prefix: readonly object[], units: readonly ContextUnit[] = this.context.units(member.memberId)): IContextUsage {
		const inputTokens = this.measure(member, prefix, units);
		const memorySection = this.context.memorySection(member.memberId);
		const memory = memorySection ? estimateTokens([userMessage(memorySection)]) : 0;
		const estimates: Record<ContextCategory, number> = {
			system: Math.max(0, estimateTokens(prefix) - memory),
			tools: estimateTokens(this.snapshots.current(member).tools),
			memory,
			incoming: 0, toolCalls: 0, outputs: 0, summaries: 0,
		};
		for (const unit of units) {
			if (unit.kind === 'incoming') estimates.incoming += estimateTokens(unit.input);
			else if (unit.kind === 'summary' || unit.kind === 'omission') estimates.summaries += estimateTokens(unit.input);
			else {
				for (const item of unit.input) {
					const type = (item as Record<string, unknown>)['type'];
					estimates[type === 'function_call' || type === 'function_call_output' ? 'toolCalls' : 'outputs'] += estimateTokens([item]);
				}
			}
		}
		return { usedTokens: inputTokens, categories: distribute(estimates, inputTokens) };
	}

	private measure(member: IMember, prefix: readonly object[], units: readonly ContextUnit[]): number {
		// 最近的请求按运行、再按请求倒序找：一个成员同时只有一次运行，顺序和按请求 ID 排一样，沿着索引碰到第一条就停；
		// 直接按请求 ID 排要先取出这个成员的全部请求再排序，请求越多越慢。下面找最后一次完成的回复请求也一样。
		const last = this.db.get<{ input_tokens: number; seen_through_item_id: number; ended_at: number }>(`
			SELECT request.input_tokens, request.seen_through_item_id, request.ended_at FROM model_requests request
			JOIN runs run ON run.run_id = request.run_id
			WHERE run.member_id = ? AND request.kind = 'response' AND request.status = 'completed' AND request.input_tokens IS NOT NULL
			ORDER BY run.run_id DESC, request.request_id DESC LIMIT 1
		`, member.memberId);
		if (last && last.ended_at > this.optimizedAt(member.memberId)) {
			return last.input_tokens + estimateTokens(units.filter(unit => unit.items.some(item => item.itemId > last.seen_through_item_id)).flatMap(unit => unit.input));
		}
		return this.fixedTokens(member, prefix) + estimateTokens(units.flatMap(unit => unit.input));
	}

	/**
	 * 全部按估算算的输入长度，不用模型报告的用量。比较压缩前后有没有变短时用它：实际用量和估算可能差得多，
	 * 拿压缩前的实际用量和压缩后的估算比，变短了也会被当成没变短。
	 */
	estimate(member: IMember, prefix: readonly object[], units: readonly ContextUnit[] = this.context.units(member.memberId)): number {
		return this.fixedTokens(member, prefix) + estimateTokens(units.flatMap(unit => unit.input));
	}

	/** 每次请求都有的固定内容的估算：工具定义，开头的规则、设定、记忆、运行环境和通讯录。 */
	fixedTokens(member: IMember, prefix: readonly object[]): number {
		return estimateTokens(this.snapshots.current(member).tools) + estimateTokens(prefix);
	}

	/** 有没有可以压缩的内容：最近的内容以外还有别的。 */
	canOptimize(memberId: string, contextWindow: number, units: readonly ContextUnit[] = this.context.units(memberId)): boolean {
		return this.groups(memberId, units, contextWindow).some(group => !group.protected);
	}

	/** 按编号分组，标出不能处理的最近的内容。界线每次按当时算：成员看到了哪里，最后一次完成的回复请求是哪次。 */
	private groups(memberId: string, units: readonly ContextUnit[], contextWindow: number): IGroup[] {
		const seenThrough = this.db.get<{ seen_through_item_id: number }>('SELECT seen_through_item_id FROM member_states WHERE member_id = ?', memberId)?.seen_through_item_id ?? 0;
		const lastRequestId = this.db.get<{ request_id: number }>(`
			SELECT request.request_id FROM model_requests request JOIN runs run ON run.run_id = request.run_id
			WHERE run.member_id = ? AND request.kind = 'response' AND request.status = 'completed' ORDER BY run.run_id DESC, request.request_id DESC LIMIT 1
		`, memberId)?.request_id ?? 0;
		return groupUnits(units, seenThrough, lastRequestId, contextWindow * this.recentRatio);
	}

	/**
	 * 压缩请求：正常的上下文不变，最后加一条任务说明。请求不超过上下文长度的八成：全部放得下就全带上；
	 * 放不下时按先后从最早的开始带，带到放不下为止（分段压缩），至少带一组能处理的。
	 * 没有可以处理的内容时返回 undefined。
	 */
	request(member: IMember, prefix: readonly object[], contextWindow: number, units: readonly ContextUnit[] = this.context.units(member.memberId)): IOptimizationRequest | undefined {
		const groups = this.groups(member.memberId, units, contextWindow);
		const open = groups.filter(group => !group.protected);
		if (open.length === 0) return undefined;
		const limit = contextWindow * REQUEST_RATIO;
		const taskTokens = estimateTokens([userMessage(this.taskText(member.memberId, groups.find(group => group.protected)?.number, false, summaryShare(open, contextWindow)))]);

		let included = groups;
		if (this.measure(member, prefix, units) + taskTokens > limit) {
			let budget = limit - this.fixedTokens(member, prefix) - taskTokens;
			included = [];
			for (const group of groups) {
				budget -= tokensOf(group);
				if (budget < 0 && included.length > 0) break;
				included.push(group);
			}
		}
		const partial = included.length < groups.length;
		const processable = included.filter(group => !group.protected);
		const share = summaryShare(processable, contextWindow);
		const task = this.taskText(member.memberId, included.find(group => group.protected)?.number, partial, share);
		return {
			input: [...prefix, ...partial ? included.flatMap(group => group.units.flatMap(unit => unit.input)) : units.flatMap(unit => unit.input), userMessage(task)],
			textFormat: OUTPUT_FORMAT,
			groups: new Map(processable.map(group => [group.number, group.units])),
			numbers: new Set(groups.map(group => group.number)),
			chunkTokens: partial ? processable.reduce((sum, group) => sum + tokensOf(group), 0) : undefined,
			summaryShare: share,
		};
	}

	/**
	 * 检查模型给出的方案：每个操作单独检查，记下不合规的地方。记忆的操作按顺序在当前内容上试一遍，
	 * 可以暂时超过上限，但不能超过兜底。摘要合计的长度、要不要处理旧摘要按整份方案检查。
	 */
	check(memberId: string, request: IOptimizationRequest, output: readonly IModelOutputItem[]): ICheckedProposal {
		let ops: unknown;
		try {
			ops = (JSON.parse(outputText(output)) as { ops?: unknown } | null)?.ops;
		} catch {
			ops = undefined;
		}
		if (!Array.isArray(ops)) return { context: [], memory: [], problems: ['输出不符合要求的 JSON 格式'] };
		const context: ContextOperation[] = [];
		const memoryOperations: MemoryOperation[] = [];
		const problems: string[] = [];
		const used = new Set<number>();
		let memory = this.memories.read(memberId);
		for (const op of ops as Record<string, unknown>[]) {
			if (op?.['op'] === 'summarize' || op?.['op'] === 'prune') {
				const numbers = Array.isArray(op['ids']) ? [...new Set(op['ids'].map(toNumber))] : [];
				if (numbers.length === 0 || numbers.some(number => !Number.isInteger(number))) {
					problems.push(`${op['op']} 的 ids 须为内容编号`);
					continue;
				}
				const label = `内容编号 ${numbers.join('、')}`;
				const wrong = numbers.map(number => !request.groups.has(number) ? (request.numbers.has(number) ? `内容编号 ${number} 不在可处理范围内` : `不存在内容编号 ${number}`)
					: used.has(number) ? `内容编号 ${number} 出现在两个操作中` : undefined).filter(problem => problem !== undefined);
				if (wrong.length > 0) {
					problems.push(...wrong);
					continue;
				}
				if (op['op'] === 'summarize') {
					const summary = typeof op['summary'] === 'string' ? op['summary'].trim() : '';
					if (!summary) {
						problems.push(`${label} 的摘要为空`);
						continue;
					}
					context.push({ op: 'summarize', numbers, summary, keywords: readKeywords(op['keywords']) });
				} else {
					context.push({ op: 'prune', numbers });
				}
				numbers.forEach(number => used.add(number));
			} else if (op?.['op'] === 'memory_add' || op?.['op'] === 'memory_replace') {
				const operation: MemoryOperation | undefined = op['op'] === 'memory_add'
					? typeof op['text'] === 'string' ? { op: 'add', text: op['text'] } : undefined
					: typeof op['old_text'] === 'string' && typeof op['new_text'] === 'string' ? { op: 'replace', oldText: op['old_text'], newText: op['new_text'] } : undefined;
				if (!operation) {
					problems.push(`${op['op']} 缺少字段`);
					continue;
				}
				const label = operation.op === 'add' ? `memory_add「${snippet(operation.text)}」` : `memory_replace「${snippet(operation.oldText)}」`;
				try {
					const next = applyMemoryOperation(memory, operation);
					if (next.length > MEMORY_HARD_LIMIT) {
						problems.push(`${label}：修改后记忆共 ${next.length} 字，超过 ${MEMORY_HARD_LIMIT} 字上限`);
						continue;
					}
					memory = next;
					memoryOperations.push(operation);
				} catch (error) {
					problems.push(`${label}：${errorMessage(error).split('。')[0]}`);
				}
			} else {
				problems.push(`无法识别的操作：${snippet(JSON.stringify(op))}`);
			}
		}
		if (!ops.some(op => op?.['op'] === 'summarize' || op?.['op'] === 'prune')) problems.push('缺少摘要或删除内容的操作');
		const unitsOf = (operation: ContextOperation) => operation.numbers.flatMap(number => request.groups.get(number)!);
		if (request.summaryShare !== undefined && !context.some(operation => unitsOf(operation).some(unit => unit.kind === 'summary'))) {
			problems.push(`此前整理的摘要占上下文长度的约 ${percent(request.summaryShare)}，超过四分之一，但本方案未处理其中任何一条`);
		}
		// 摘要的长度按整份方案算，不能靠跳过某一条满足：不够短时一条都不执行。放在最前面，压缩失败时的报错只取前几条。
		if (!shrinks(context.flatMap(operation => operation.op === 'summarize' ? [{ text: operation.summary, keywords: operation.keywords, units: unitsOf(operation) }] : []), context.flatMap(unitsOf))) {
			problems.unshift('本方案中的摘要合计未显著短于其代替和删除的内容');
			return { context: [], memory: memoryOperations, problems };
		}
		return { context, memory: memoryOperations, problems };
	}

	/**
	 * 第二次请求的输入：第一次的请求，加上模型这次的输出和不合规的地方。输出和平时带回模型的输出一样：思考和文字一起带回，
	 * 压缩请求带着工具定义，有的服务要求这样的请求产出的思考在后续请求里一起带回；没有文字时都不带。只在这次压缩里用，不进时间线。
	 */
	retryInput(request: IOptimizationRequest, output: readonly IModelOutputItem[], problems: readonly string[]): object[] {
		const replayed = output.filter(item => item.type === 'reasoning' || item.type === 'message');
		return [
			...request.input,
			...hasVisibleOutput(replayed) ? replayed.map(replayOutput) : [],
			userMessage(['上次的方案存在以下不符合要求之处，整份方案均未执行：', ...problems.map(problem => `- ${problem}`), '', '请修正后重新输出完整的方案。'].join('\n')),
		];
	}

	/**
	 * 执行检查过的方案里合规的操作，之后刷新记忆的快照，工具列表、运行环境和通讯录的快照下次请求重新生成。
	 * 最后看要不要放回计划：计划没做完、最近一份计划原文又被这次处理掉了时，在时间线末尾放回一条计划说明。
	 */
	apply(memberId: string, request: IOptimizationRequest, proposal: ICheckedProposal): void {
		const order = new Map([...request.groups.keys()].map((number, index) => [number, index]));
		this.db.transaction(() => {
			let memory = this.memories.read(memberId);
			const memoryApplied: MemoryOperation[] = [];
			for (const operation of proposal.memory) {
				// 检查以后用户可能改过记忆，再试一遍，不行的跳过。
				try {
					const next = applyMemoryOperation(memory, operation);
					if (next.length > MEMORY_HARD_LIMIT) continue;
					memory = next;
					memoryApplied.push(operation);
				} catch {
					// 跳过。
				}
			}
			// 记忆的修改先写进时间线，排在这次的摘要前面：和成员的上下文一样，记忆在开头，时间线的内容在后面。
			if (memoryApplied.length > 0) {
				this.memories.write(memberId, memory, true);
				this.timeline.appendMemoryChange(memberId, { operations: memoryApplied, length: memory.length });
			}
			this.memories.refresh(memberId);
			this.snapshots.refresh(memberId);
			// 之后是摘要，最后是这次的删除记录：一次压缩的删除合成一条，记下删掉了哪些内容。
			const pruned: IContentCounts[] = [];
			for (const operation of proposal.context) {
				const units = [...operation.numbers].sort((left, right) => order.get(left)! - order.get(right)!).flatMap(number => request.groups.get(number)!);
				const items = units.flatMap((unit): readonly TimelineItem[] => unit.items);
				const itemIds = items.map(item => item.itemId);
				const oldSummaryIds = items.flatMap(item => item.kind === 'summary' ? [item.itemId] : []);
				if (operation.op === 'prune') {
					this.timeline.setContextState(memberId, itemIds, 'pruned', null);
					this.timeline.pruneSummarized(memberId, oldSummaryIds);
					pruned.push(countContent(items));
				} else {
					const summaryItemId = this.timeline.appendSummary(memberId, {
						text: operation.summary, keywords: operation.keywords, anchorItemId: anchorOf(units[0]!), ...timeRange(units), counts: countContent(items),
					});
					this.timeline.setContextState(memberId, itemIds, 'summarized', summaryItemId);
					this.timeline.repointSummarized(memberId, oldSummaryIds, summaryItemId);
				}
			}
			if (pruned.length > 0) this.timeline.appendPruning(memberId, { counts: addCounts(pruned) });
			if (proposal.context.length > 0) {
				this.db.run('UPDATE member_states SET optimized_at = ? WHERE member_id = ?', Date.now(), memberId);
				this.plans.restore(memberId);
			}
		});
	}

	/**
	 * 核对方案里每条摘要的关键词，只留在被代替的内容里查得到的（运行时设计第 5 部分「压缩」）。在执行方案之前、事务之外做：
	 * 旧摘要代替的原文可能很多，分批取，批与批之间让出主线程，运行时照常响应别的请求。
	 */
	async verifyKeywords(memberId: string, request: IOptimizationRequest, proposal: ICheckedProposal, signal: AbortSignal): Promise<ICheckedProposal> {
		const context: ContextOperation[] = [];
		for (const operation of proposal.context) {
			if (operation.op === 'summarize' && operation.keywords.length > 0) {
				const items = operation.numbers.flatMap(number => request.groups.get(number)!).flatMap((unit): readonly TimelineItem[] => unit.items);
				context.push({ ...operation, keywords: await this.foundKeywords(memberId, items, operation.keywords, signal) });
			} else {
				context.push(operation);
			}
		}
		return { ...proposal, context };
	}

	/**
	 * 摘要的关键词里，在被代替的内容中查得到的那些，顺序不变：用查历史匹配的正文比对，不区分大小写。
	 * 被代替的旧摘要用它们代替的原文比对，不用旧摘要的文字。按开销从小到大找，关键词都找到了就停：
	 * 旧摘要自己的关键词核对过，在它代替的原文里查得到，直接算数；再看这次处理的内容和它们收发的消息；最后才分批取旧摘要的原文。
	 */
	private async foundKeywords(memberId: string, items: readonly TimelineItem[], keywords: readonly string[], signal: AbortSignal): Promise<string[]> {
		const oldSummaries = items.flatMap(item => item.kind === 'summary' ? [item] : []);
		const verified = new Set(oldSummaries.flatMap(item => item.summary.keywords.map(keyword => keyword.toLowerCase())));
		let missing = keywords.map(keyword => keyword.toLowerCase()).filter(keyword => !verified.has(keyword));
		const check = (text: string) => {
			const lower = text.toLowerCase();
			missing = missing.filter(keyword => !lower.includes(keyword));
			return missing.length === 0;
		};
		const found = () => keywords.filter(keyword => !missing.includes(keyword.toLowerCase()));
		const search = (batch: readonly TimelineItem[]) => {
			for (const item of batch) {
				const text = searchableItemText(item);
				if (text !== undefined && check(text)) return true;
			}
			// 收到的消息查对话消息；自己发的消息按发出它的调用（send_message 或 run_tool_script）找。
			const received = this.messages.getMany(batch.flatMap(item => item.kind === 'message' ? [item.messageId] : []));
			const calls = batch.flatMap(item => item.kind === 'model_output' && item.output.type === 'function_call' ? [item.itemId] : []);
			for (const message of [...received.values(), ...this.messages.sentBy(memberId, calls)]) {
				if (check(searchText(message.external ? externalBody(message.external.meta, message.text) : message.text, message.attachments))) return true;
			}
			return false;
		};
		if (missing.length === 0 || search(items)) return found();
		const oldSummaryIds = oldSummaries.map(item => item.itemId);
		for (let after = 0; ;) {
			await nextTurn();
			signal.throwIfAborted();
			const batch = this.timeline.summarizedBy(memberId, oldSummaryIds, after, ORIGINALS_BATCH);
			if (batch.length === 0 || search(batch)) break;
			after = batch.at(-1)!.itemId;
		}
		return found();
	}

	/**
	 * 任务说明。boundary 是第一个不能处理的编号；按位置说，编号不完全按先后。不说它们是不是接下来要处理的：
	 * 运行时不理解内容。leftOut 是后面还有内容这次没带上。summaryShare 是超过上限时能处理的摘要占的比例。
	 */
	private taskText(memberId: string, boundary: number | undefined, leftOut: boolean, summaryShare: number | undefined): string {
		const scope = [
			...boundary !== undefined ? [`- 内容编号 ${boundary} 及排在其后的内容是最近的内容，本次不得处理。`] : [],
			...leftOut ? ['- 上下文过长，本次只提供了其中一部分，其后还有内容。'] : [],
			...summaryShare !== undefined ? [`- 此前整理的摘要已占上下文长度的约 ${percent(summaryShare)}，超过四分之一：本次必须合并、精简或删除其中一部分。`] : [],
		];
		return [TASK_HEAD, OPERATIONS, ...scope, '', PRINCIPLES, '', memoryTask(this.memories.read(memberId), this.memories.snapshot(memberId)), '', OUTPUT].join('\n');
	}
}

/**
 * 按编号分组，标出不能处理的最近的内容。没有编号的回复跟着前面最近的编号，最前面没有编号的跟着第一个编号。
 * 最近的内容是没看过的内容，加上它前面按组往前累计到 recentTokens 的内容，跨过线的那一组整组算进去，
 * 所以最近看过的一组总在里面。没看过的是：最后一次完成的回复请求（lastRequestId）调用了工具时，这次的调用和结果
 * （之后还没有请求看到结果），以及 seenThrough 以后收到的内容。它们排在最后：碰到第一组没看过的，后面的都没看过。
 */
function groupUnits(units: readonly ContextUnit[], seenThrough: number, lastRequestId: number, recentTokens: number): IGroup[] {
	const unseen = (unit: ContextUnit) => (unit.kind === 'request' && unit.requestId === lastRequestId && unit.number !== null)
		|| ((unit.kind === 'incoming' || unit.kind === 'omission') && unit.items[0].itemId > seenThrough);
	const groups: IGroup[] = [];
	let leading: ContextUnit[] = [];
	let closed = false;
	for (const unit of units) {
		closed ||= unseen(unit);
		if (unit.number !== null) {
			groups.push({ number: unit.number, units: [...leading, unit], protected: closed });
			leading = [];
		} else if (groups.length > 0) {
			const last = groups.at(-1)!;
			last.units.push(unit);
			last.protected ||= closed;
		} else {
			leading.push(unit);
		}
	}
	const first = groups.findIndex(group => group.protected);
	let total = 0;
	for (let index = (first === -1 ? groups.length : first) - 1; index >= 0; index--) {
		groups[index]!.protected = true;
		total += tokensOf(groups[index]!);
		if (total >= recentTokens) break;
	}
	return groups;
}

function tokensOf(group: IGroup): number {
	return estimateTokens(group.units.flatMap(unit => unit.input));
}

/** 这些组里的摘要占上下文长度的比例，超过上限时返回它，没超过时是 undefined。 */
function summaryShare(groups: readonly IGroup[], contextWindow: number): number | undefined {
	const tokens = estimateTokens(groups.flatMap(group => group.units.filter(unit => unit.kind === 'summary').flatMap(unit => unit.input)));
	const share = tokens / contextWindow;
	return share > SUMMARY_SHARE_LIMIT ? share : undefined;
}

/** 摘要排在它代替的最早那条内容的位置：代替的是摘要或说明时，用它们自己的位置。 */
function anchorOf(unit: ContextUnit): number {
	if (unit.kind === 'summary') return unit.items[0].summary.anchorItemId;
	if (unit.kind === 'omission') return unit.items[0].omission.anchorItemId;
	return unit.items[0]!.itemId;
}

/** 一组内容的时间范围，和上下文里写的范围（按现在的时区写下，之后不改）；其中的摘要和说明按它们自己记下的时刻算。 */
function timeRange(units: readonly ContextUnit[]): { startTime: number; endTime: number; rangeText: string } {
	const times = units.flatMap(unit => unit.kind === 'summary' ? [unit.items[0].summary.startTime, unit.items[0].summary.endTime]
		: unit.kind === 'omission' ? [unit.items[0].omission.startTime, unit.items[0].omission.endTime]
			: unit.items.map(item => item.createdAt));
	const startTime = Math.min(...times);
	const endTime = Math.max(...times);
	return { startTime, endTime, rangeText: timeRangeText(startTime, endTime) };
}

/**
 * 一份方案里的摘要合计要明显短于它们代替的和删掉的全部内容，否则压缩没有意义。不按每条摘要算：
 * 整理几条旧摘要、把一件事前后的内容合成一条，单条不一定更短，删除省下的能抵掉。没有摘要时总是满足。
 */
function shrinks(summaries: readonly { text: string; keywords: readonly string[]; units: readonly ContextUnit[] }[], replaced: readonly ContextUnit[]): boolean {
	if (summaries.length === 0) return true;
	const written = estimateTokens(summaries.map(summary => summaryMessage({ text: summary.text, keywords: summary.keywords, ...timeRange(summary.units) }, 0)));
	return written < estimateTokens(replaced.flatMap(unit => unit.input)) * MAX_SUMMARY_RATIO;
}

function percent(share: number): string {
	return `${Math.round(share * 100)}%`;
}

/** 压缩请求里关于记忆的说明。记忆的当前内容和开头的快照一样时只写字数，免得重复。 */
function memoryTask(current: string, snapshot: string): string {
	const state = !current
		? '记忆当前为空。'
		: current === snapshot
			? `记忆的当前内容与开头「# 你的记忆」相同，共 ${current.length} 字。`
			: `记忆的当前内容（共 ${current.length} 字，以此处为准）：\n${current}`;
	return `记忆：
- 开头「# 你的记忆」是你自己记录的长期记忆，不会被压缩。本次处理的内容中，后续仍需要、而摘要未必能长期保留的事实、偏好、约定和分工，可以写入记忆。
- memory_add：在记忆末尾添加 text。memory_replace：将记忆中的 old_text 替换为 new_text；old_text 必须与记忆当前内容中的原文一致且只出现一次；new_text 为空表示删除。
- 记忆上限为 ${MEMORY_LIMIT} 字。本次可以暂时超出，但修改后不得超过 ${MEMORY_HARD_LIMIT} 字；超出上限时，可一并合并、删减已有的记忆。
- ${state}`;
}

/** 按各部分的比例把 total 分下去，取整后加起来正好等于 total（余数给小数部分最大的）。 */
export function distribute<K extends string>(parts: Readonly<Record<K, number>>, total: number): Record<K, number> {
	const keys = Object.keys(parts) as K[];
	const sum = keys.reduce((value, key) => value + parts[key], 0);
	const exact = keys.map(key => sum > 0 ? parts[key] * total / sum : 0);
	const result = Object.fromEntries(keys.map((key, index) => [key, Math.floor(exact[index]!)])) as Record<K, number>;
	let remainder = sum > 0 ? total - keys.reduce((value, key) => value + result[key], 0) : 0;
	for (const index of keys.map((_, index) => index).sort((left, right) => (exact[right]! % 1) - (exact[left]! % 1))) {
		if (remainder <= 0) break;
		result[keys[index]!]++;
		remainder--;
	}
	return result;
}

/**
 * 摘要的关键词：去掉空的、过长的和重复的（不区分大小写），最多留前 10 个。缺了或格式不对时没有关键词，不算不合规：
 * 关键词只是查找的辅助。
 */
function readKeywords(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	const keywords: string[] = [];
	for (const item of value) {
		const keyword = typeof item === 'string' ? item.trim() : '';
		if (!keyword || keyword.length > MAX_KEYWORD_LENGTH || seen.has(keyword.toLowerCase())) continue;
		seen.add(keyword.toLowerCase());
		keywords.push(keyword);
		if (keywords.length === MAX_KEYWORDS) break;
	}
	return keywords;
}

/** 编号可以写成数字，也可以写成「内容编号 1234」「#1234」这样的文字，取里面的数字。 */
function toNumber(id: unknown): number {
	if (typeof id === 'number') return id;
	const digits = typeof id === 'string' ? /^\D*(\d+)\D*$/.exec(id.trim())?.[1] : undefined;
	return digits === undefined ? NaN : Number(digits);
}

/** 给用户看的思考：每段用摘要，没有摘要时用原文；加密的内容不要。 */
export function reasoningText(output: readonly IModelOutputItem[]): string {
	const texts = (item: IModelOutputItem, key: string) => (Array.isArray(item[key]) ? item[key] as { text?: unknown }[] : [])
		.map(part => typeof part.text === 'string' ? part.text.trim() : '').filter(Boolean);
	return output.filter(item => item.type === 'reasoning').map(item => {
		const summary = texts(item, 'summary');
		return (summary.length > 0 ? summary : texts(item, 'content')).join('\n\n');
	}).filter(Boolean).join('\n\n');
}

/** 输出的文字：压缩方案的原文。 */
export function outputText(output: readonly IModelOutputItem[]): string {
	return output.filter(item => item.type === 'message').map(item => messageText(item['content'])).join('').trim();
}

function snippet(text: string): string {
	const flat = text.replace(/\s+/g, ' ').trim();
	return clipEnd(flat, SNIPPET_LENGTH);
}

const IDS = { type: 'array', items: { type: 'integer' } };

const OUTPUT_FORMAT: Record<string, unknown> = {
	type: 'json_schema',
	name: 'context_optimization',
	strict: true,
	schema: {
		type: 'object', additionalProperties: false, required: ['ops'],
		properties: {
			ops: {
				type: 'array',
				minItems: 1,
				items: {
					anyOf: [
						{
							type: 'object', additionalProperties: false, required: ['op', 'ids', 'summary', 'keywords'],
							properties: { op: { type: 'string', enum: ['summarize'] }, ids: IDS, summary: { type: 'string' }, keywords: { type: 'array', items: { type: 'string' } } },
						},
						{
							type: 'object', additionalProperties: false, required: ['op', 'ids'],
							properties: { op: { type: 'string', enum: ['prune'] }, ids: IDS },
						},
						{
							type: 'object', additionalProperties: false, required: ['op', 'text'],
							properties: { op: { type: 'string', enum: ['memory_add'] }, text: { type: 'string' } },
						},
						{
							type: 'object', additionalProperties: false, required: ['op', 'old_text', 'new_text'],
							properties: { op: { type: 'string', enum: ['memory_replace'] }, old_text: { type: 'string' }, new_text: { type: 'string' } },
						},
					],
				},
			},
		},
	},
};

/**
 * 服务不支持 json_schema 时改用的格式：只保证是 JSON，格式靠任务说明里的 OUTPUT。
 * 有的服务（如 DeepSeek）要求这时提示词里出现「json」，OUTPUT 里有。
 */
export const JSON_OBJECT_FORMAT: Record<string, unknown> = { type: 'json_object' };

/** 方案的格式，总是写进任务说明：用 json_object 时只能靠它。 */
const OUTPUT = `输出：只输出一个 JSON 对象，不含其他文字，格式为 {"ops": [操作, ...]}，至少包含一个操作。每个操作为以下之一：
- {"op": "summarize", "ids": [编号, ...], "summary": "摘要正文", "keywords": ["关键词", ...]}
- {"op": "prune", "ids": [编号, ...]}
- {"op": "memory_add", "text": "添加的内容"}
- {"op": "memory_replace", "old_text": "原文", "new_text": "新的内容"}`;

const TASK_HEAD = `【上下文压缩任务】本次不是正常对话，只输出压缩方案。
上下文即将用尽，必须显著缩减，优先处理已完成的事项。

目标：
- 不是为整个历史撰写总结，而是对已不需要原文的内容做局部压缩。压缩后的上下文即是你后续继续工作的基础。
- 摘要是供你自己继续完成任务使用的记忆，不是写给旁观者的概述。后续可能用于答复、决策、调用工具、继续修改、验证结果或追溯责任的信息，均须保留足够的细节。
- 保留先后顺序、人物关系、关键决策及依据、未完成的事项、正在推进的工作，以及后续可能直接使用的工具结果。
`;

const OPERATIONS = `操作：
- 用内容开头的内容编号指明要处理的内容。
- 你自己输出的思考、文字和工具调用没有内容编号，处理某个编号时随之一并处理：
  - 工具结果开头的编号，涵盖同一次发出的全部工具调用及其结果，以及紧邻这些调用之前的你的思考和文字；
  - 未调用工具的思考和文字，归属于其前面最近的编号，例如一问一答时，问题的编号也涵盖你的回答。
- summarize：用一条摘要代替一条或多条内容。ids 为内容编号中的数字，summary 为摘要正文，keywords 为 1 到 10 个关键词。
- prune：直接删除低价值内容，不保留摘要。
- 同一内容编号只能出现在一个操作中。
- 一份方案中的摘要合计必须显著短于其代替和删除的内容；对很短的内容单独做摘要没有意义。
- 关键词供日后查找被代替内容的原文：须原样取自被代替的内容（消息、工具调用及结果、你的输出），不取自思考；选择日后查找原文时会用到的具体词语，如文件名、函数名、命令、错误信息片段、ID、专有名词，不用泛化的词语。`;

const PRINCIPLES = `原则：
- 摘要只写其所代替内容中的信息：摘要会放在被代替内容的原位置，代替多条时放在其中最早一条的位置。
- 摘要中用「我」指代自己，用名字和 ID 指代其他成员。
- 内容编号仅用于在本方案中指明要处理的内容，压缩后即失效，不得写入摘要；需要指代其他内容时，写明时间、人物、文件路径或事项名称。
- 保持来源关系：他人提出的需求、约束和反馈，仍写为他人提出；自己的答复、承诺和已执行的操作，仍写为自己所为；工具结果仍写为工具返回。
- 真人提出的原始需求、约束和验收标准，尽量保留原话。
- 按事项拆分摘要，不要为减少操作数量而将不同事项合并为一条。
- 按后续是否还需直接使用原文来处理：正在进行的工作、未完成的事项和后续仍需直接使用的内容保留原文；已完成、已有结论的内容积极压缩，摘要中写明具体信息而非笼统概括（关键事实和数值、文件路径、命令及其关键结果、错误信息、必要的原文片段）；噪音、重复和明确过时的内容直接删除。
- 你用 update_plan 写下的计划，无需为保留计划而保留其原文：压缩后，未完成的计划会重新放入上下文。
- 图片和文件的摘要应描述可见内容或文件用途，不得声称看到了不存在的信息。含图片的内容被摘要时，建议在摘要中记下图片的文件名或路径，便于回看。
- 此前整理的摘要也按同样标准处理：同一事项的旧摘要与后续内容，在事项完成后可合并为一条；已完成事项的摘要可进一步精简，失去价值的可删除。重新摘要时，须保留旧摘要中仍有用的具体信息和原话。`;
