import type { ContextState, IModelOutputItem, IRun, TimelineEntry } from '../api/types.ts';

type Entry<K extends TimelineEntry['kind']> = Extract<TimelineEntry, { kind: K }>;
export type ModelOutputEntry = Entry<'model_output'>;
export type ToolResultEntry = Entry<'tool_result'>;

/**
 * 过程里的一步：思考、工具调用、其他输出，以及什么都显示不出来的一轮（empty，「空回复」）。
 * 思考、其他输出和空回复带着显示用的状态：没有实际产出的一轮没带回上下文。
 */
export type Step =
	| { readonly kind: 'thinking'; readonly key: string; readonly entry: ModelOutputEntry; readonly state: ContextState }
	| { readonly kind: 'call'; readonly key: string; readonly call: ModelOutputEntry | undefined; readonly result: ToolResultEntry | undefined }
	| { readonly kind: 'other'; readonly key: string; readonly entry: ModelOutputEntry; readonly state: ContextState }
	| { readonly kind: 'empty'; readonly key: string; readonly entry: ModelOutputEntry; readonly state: ContextState };

/** 压缩生效时写下的卡片：对记忆的修改、摘要、删除记录，以及压缩后放回的计划。 */
export type CompactionCard = Entry<'memory_change' | 'summary' | 'pruning' | 'plan'>;

/** 发出的消息：send_message 的调用和结果。 */
export type SentRow = { readonly kind: 'sent'; readonly key: string; readonly call: ModelOutputEntry; readonly result: ToolResultEntry | undefined };

/**
 * 时间线上显示的一行。连续的思考和工具调用合成一段过程（process）；发出的消息、直接输出单独一行，把过程隔开。
 * 压缩记录（optimization）带着紧跟在它后面的、这次压缩生效的卡片；前面没有记录的卡片单独一行。
 */
export type Row =
	| { readonly kind: 'entry'; readonly key: string; readonly entry: Exclude<TimelineEntry, ModelOutputEntry | ToolResultEntry | Entry<'optimization'>> }
	| { readonly kind: 'optimization'; readonly key: string; readonly entry: Entry<'optimization'>; readonly cards: readonly CompactionCard[] }
	| { readonly kind: 'process'; readonly key: string; readonly steps: readonly Step[] }
	| SentRow
	| { readonly kind: 'output'; readonly key: string; readonly entry: ModelOutputEntry }
	| { readonly kind: 'run'; readonly key: string; readonly run: IRun };

/**
 * 把时间线条目排成显示的行：工具结果并到它的调用上，连续的思考和工具调用合成一段；结束的回复运行在结束时间的位置插一条分隔线。
 * 只压缩的运行不画分隔线：经过和出错都在它的压缩记录里。hasNewer 是后面还有没取的：在已加载的最后一条之后结束的运行不画，免得看起来紧接着上面。
 */
export function buildRows(entries: readonly TimelineEntry[], runs: readonly IRun[], complete: boolean, hasNewer = false): Row[] {
	const results = new Map<string, ToolResultEntry>();
	const calls = new Set<string>();
	/** 有思考或其他输出能显示的请求；没有的写一步「空回复」。没有实际产出、没带回上下文的一轮，运行时记成 unreturned。 */
	const showable = new Set<number>();
	for (const entry of entries) {
		if (entry.kind === 'tool_result') results.set(callKey(entry.runId, entry.result.callId), entry);
		if (entry.kind !== 'model_output') continue;
		const { output } = entry;
		if (output.type === 'function_call') calls.add(callKey(entry.runId, String(output['call_id'])));
		if (output.type !== 'function_call' && output.type !== 'message') showable.add(entry.requestId);
	}
	const emptyShown = new Set<number>();
	const firstTime = entries[0]?.createdAt ?? 0;
	const ended = runs
		.filter(run => run.endedAt !== null && run.kind === 'response' && (complete || run.endedAt >= firstTime))
		.sort((left, right) => left.endedAt! - right.endedAt! || left.runId - right.runId);

	const rows: Row[] = [];
	let process: Step[] | undefined;
	/** 上一行是压缩记录时，这次压缩的卡片归到它下面：和记录在同一个事务里写的，紧跟在它后面。 */
	let cards: CompactionCard[] | undefined;
	const step = (item: Step) => {
		cards = undefined;
		if (!process) {
			process = [];
			rows.push({ kind: 'process', key: `process:${item.key}`, steps: process });
		}
		process.push(item);
	};
	const row = (item: Row) => {
		rows.push(item);
		process = undefined;
		cards = undefined;
	};
	let next = 0;
	const flushRuns = (until: number) => {
		while (next < ended.length && ended[next]!.endedAt! < until) {
			const run = ended[next++]!;
			row({ kind: 'run', key: `run:${run.runId}`, run });
		}
	};
	for (const entry of entries) {
		flushRuns(entry.createdAt);
		const key = `item:${entry.itemId}`;
		if (entry.kind === 'model_output') {
			const { output } = entry;
			if (output.type === 'function_call') {
				const result = results.get(callKey(entry.runId, String(output['call_id'])));
				if (output['name'] === 'send_message') row({ kind: 'sent', key, call: entry, result });
				else step({ kind: 'call', key, call: entry, result });
			} else if (output.type === 'reasoning') {
				step({ kind: 'thinking', key, entry, state: entry.contextState });
			} else if (output.type !== 'message') {
				step({ kind: 'other', key, entry, state: entry.contextState });
			} else if (messageText(output).trim()) {
				row({ kind: 'output', key, entry });
			} else if (entry.contextState === 'unreturned' && !showable.has(entry.requestId) && !emptyShown.has(entry.requestId)) {
				// 没有文字的直接输出（模型用它结束一次运行）不显示；这一轮别的什么都没有时写一步「空回复」。
				emptyShown.add(entry.requestId);
				step({ kind: 'empty', key, entry, state: entry.contextState });
			}
		} else if (entry.kind === 'tool_result') {
			// 调用在还没加载的更早部分时，结果单独显示。
			if (!calls.has(callKey(entry.runId, entry.result.callId))) step({ kind: 'call', key, call: undefined, result: entry });
		} else if (entry.kind === 'optimization') {
			const own: CompactionCard[] = [];
			row({ kind: 'optimization', key, entry, cards: own });
			cards = own;
		} else if (cards && (entry.kind === 'memory_change' || entry.kind === 'summary' || entry.kind === 'pruning' || entry.kind === 'plan')) {
			cards.push(entry);
		} else {
			row({ kind: 'entry', key, entry });
		}
	}
	flushRuns(hasNewer ? (entries.at(-1)?.createdAt ?? 0) + 1 : Infinity);
	return rows;
}

/**
 * 新排出的行里内容和上一次一样的，换回上一次的那个对象，行组件据此跳过重画。
 * 一样是指每个字段相同；过程的步骤、压缩记录的卡片逐个比，步骤再比它的每个字段。条目是补取时沿用下来的同一个对象。
 */
export function reuseRows(previous: readonly Row[], next: Row[]): Row[] {
	const byKey = new Map(previous.map(row => [row.key, row]));
	return next.map(row => {
		const old = byKey.get(row.key);
		return old && sameFields(old, row, 2) ? old : row;
	});
}

/** 两个对象的字段都相同；数组逐个比，depth 是还能往下比几层（步骤是对象，要再比一层）。 */
function sameFields(left: object, right: object, depth: number): boolean {
	const leftEntries = Object.entries(left);
	if (leftEntries.length !== Object.keys(right).length) return false;
	return leftEntries.every(([key, value]) => same(value, (right as Record<string, unknown>)[key], depth));
}

function same(left: unknown, right: unknown, depth: number): boolean {
	if (left === right) return true;
	if (depth === 0 || typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) return false;
	if (Array.isArray(left)) return Array.isArray(right) && left.length === right.length && left.every((value, index) => same(value, right[index], depth - 1));
	return !Array.isArray(right) && sameFields(left, right, depth - 1);
}

/** 直接输出的文字。 */
export function messageText(output: IModelOutputItem): string {
	const content = Array.isArray(output['content']) ? output['content'] as { text?: unknown }[] : [];
	return content.map(part => typeof part.text === 'string' ? part.text : '').join('');
}

/**
 * 思考的文字：有摘要用摘要，没有时用思考原文（有的模型只给原文）；都没有（只有加密内容）时是空的。
 * 不看每段的 type：有的服务把原文放在 content 里却标成 summary_text，流式时照样发出来，只认 reasoning_text 的话生成完反而看不到。
 */
export function reasoningText(output: IModelOutputItem): string {
	return partsText(output['summary']) || partsText(output['content']);
}

function partsText(parts: unknown): string {
	if (!Array.isArray(parts)) return '';
	return (parts as { text?: unknown }[]).map(part => typeof part.text === 'string' ? part.text : '').filter(Boolean).join('\n\n');
}

function callKey(runId: number, callId: string): string {
	return `${runId}:${callId}`;
}

/** 解析工具调用的参数；不是合法 JSON 时原样返回字符串。 */
export function parseArguments(raw: unknown): unknown {
	if (typeof raw !== 'string') return raw;
	try {
		return JSON.parse(raw);
	} catch {
		return raw;
	}
}
