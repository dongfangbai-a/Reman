/**
 * 用假模型跑预设的情景，记下每次发给上游的请求，生成一个网页（开发用，不属于运行时）。
 * 用法：node scripts/contextSamples.ts [情景名…] [--out <目录>]
 * 不写情景名时跑全部；默认输出到仓库下的 data/context-samples/：samples.json 和 index.html。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { runtimeDirectories } from '../src/dataDirectory.ts';
import { requestBody, type IFunctionTool, type IModelClient, type IModelRequest, type IModelResponse } from '../src/models/client.ts';
import { estimateItemTokens, estimateTokens } from '../src/runs/tokens.ts';
import { Runtime } from '../src/runtime.ts';
import { memberOfRequest, rememberMember, testModels } from '../src/testing.ts';
import { MCP_SERVER, SAMPLES, type ISample, type ISampleContext, type Reply } from './contextSampleList.ts';

/** 输入的一项属于哪一段：开头（身份和规则；成员设定、记忆、运行环境和通讯录）、时间线、压缩请求最后的任务说明。 */
type Section = 'prefix' | 'timeline' | 'task';

interface IItemRecord {
	readonly section: Section;
	readonly label: string;
	/** 压缩写下的摘要：代替了哪段时间、摘要多少字、代替了上下文里的几项（约多少 token）。label 是摘要的开头。 */
	readonly summary?: ISummaryInfo;
	readonly tokens: number;
	/** 这一项原样，图片换成占位。 */
	readonly value: unknown;
}

interface ISummaryInfo {
	/** 摘要里写的时间范围，原样取出。 */
	readonly range: string;
	readonly length: number;
	/** 摘要第一次出现时，上一次请求时上下文里被它代替的那几条内容在输入里占几项、约多少 token；之前没有请求时为空。 */
	readonly replaced: { readonly count: number; readonly tokens: number } | null;
}

interface IComparison {
	/** 同一成员的上一次请求，在这个情景里的序号。 */
	readonly previous: number;
	/** 变了的参数。 */
	readonly params: readonly string[];
	readonly tools: { readonly added: readonly string[]; readonly removed: readonly string[]; readonly changed: readonly string[] };
	/** 工具列表的前多少个和上一次一样。 */
	readonly sameTools: number;
	/** 输入的前多少项和上一次一样。工具列表变了时这些也命中不了缓存，只说明输入本身哪里变了。 */
	readonly same: number;
	/** 开头和上一次相同、能命中缓存的部分：工具列表排在输入前面，先算相同的工具，工具列表都一样时再加上输入的前 same 项；换了模型时是 0。 */
	readonly cachedTokens: number;
	/** 上一次的开头和时间线没有原样留下时，哪里变了；空的表示上一次的输入原样留下、后面追加了新内容。 */
	readonly broken: readonly string[];
	/**
	 * 开头或时间线里第一处不同是怎么变的：这一次在前面多了几项（后面的原样往后挪）、上一次的几项没有了、
	 * 或者这一项本身变了。只在开头或时间线里变了时有。
	 */
	readonly change: { readonly kind: 'inserted' | 'removed' | 'changed'; readonly count: number } | null;
	/** 上一次的样子：变了的那一项，或者没有了的那几项。 */
	readonly before: readonly IItemRecord[];
}

interface IRequestRecord {
	readonly index: number;
	readonly memberId: string;
	readonly member: string;
	/** 这个成员的第几次请求。 */
	readonly memberIndex: number;
	readonly kind: 'response' | 'optimization';
	/** 这次请求之前发生了什么。 */
	readonly notes: readonly string[];
	/** 除了 input 和 tools 以外的请求参数。 */
	readonly params: Record<string, unknown>;
	/** 工具列表在 toolSets 里的位置：各次请求的工具列表大多一样，只存一份。 */
	readonly toolSet: number;
	readonly toolsTokens: number;
	readonly items: readonly IItemRecord[];
	readonly totalTokens: number;
	/** 模型这次返回了什么。 */
	output: string[];
	readonly comparison: IComparison | null;
}

interface ISampleRecord {
	readonly name: string;
	readonly title: string;
	readonly description: string;
	readonly requests: readonly IRequestRecord[];
	readonly error: string | null;
}

/** 比较用的原始内容，不写进文件。 */
interface ICaptured {
	readonly record: IRequestRecord;
	readonly inputJson: readonly string[];
	readonly toolsJson: string;
	readonly tools: readonly IFunctionTool[];
}

const SECTION_NAMES: Record<Section, string> = { prefix: '开头', timeline: '时间线', task: '压缩任务' };
/** 开头那条用户消息：成员设定、记忆、运行环境和通讯录，没有的部分不写。 */
const OPENING = /^# (成员设定|你的记忆|运行环境)\n/;

const { values, positionals } = parseArgs({ allowPositionals: true, options: { out: { type: 'string' } } });
const unknown = positionals.filter(name => !SAMPLES[name]);
if (unknown.length > 0) {
	console.error(`没有情景 ${unknown.join('、')}。情景：\n${Object.entries(SAMPLES).map(([key, sample]) => `  ${key}：${sample.title}`).join('\n')}`);
	process.exit(1);
}
const outDirectory = resolve(values.out ?? fileURLToPath(new URL('../data/context-samples/', import.meta.url)));
const toolSets: string[] = [];
const samples: ISampleRecord[] = [];
for (const name of positionals.length > 0 ? positionals : Object.keys(SAMPLES)) {
	const started = Date.now();
	const sample = await runSample(name, SAMPLES[name]!);
	samples.push(sample);
	const seconds = ((Date.now() - started) / 1000).toFixed(1);
	console.log(`${sample.error ? '✗' : '✓'} ${name}（${sample.title}）：${sample.requests.length} 次请求，${seconds} 秒${sample.error ? `\n  出错：${sample.error}` : ''}`);
}

/** 样本不写本机真实路径：把用户目录和临时目录换成占位（JSON 里的反斜杠是转义过的，几种写法都换）。 */
const REDACTIONS: [string, string][] = (() => {
	const home = homedir();
	const temp = tmpdir();
	const posixHome = home.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`);
	return [
		[temp.replace(/\\/g, '\\\\'), '<临时目录>'],
		[temp, '<临时目录>'],
		[temp.replace(/\\/g, '/'), '<临时目录>'],
		[home.replace(/\\/g, '\\\\'), '<用户目录>'],
		[home, '<用户目录>'],
		[home.replace(/\\/g, '/'), '<用户目录>'],
		[posixHome, '<用户目录>'],
	];
})();
const redact = (text: string): string => REDACTIONS.reduce((result, [from, to]) => (from ? result.split(from).join(to) : result), text);

mkdirSync(outDirectory, { recursive: true });
const data = { generatedAt: new Date().toISOString(), toolSets: toolSets.map(json => JSON.parse(json) as unknown), samples };
writeFileSync(join(outDirectory, 'samples.json'), redact(JSON.stringify(data, null, '\t')));
const viewer = readFileSync(new URL('./contextViewer.html', import.meta.url), 'utf8');
writeFileSync(join(outDirectory, 'index.html'), viewer.replace('/*SAMPLES*/null', () => redact(JSON.stringify(data)).replace(/</g, '\\u003c')));
console.log(`\n网页：${join(outDirectory, 'index.html')}`);
process.exit(samples.some(sample => sample.error) ? 1 : 0);

async function runSample(name: string, sample: ISample): Promise<ISampleRecord> {
	const directory = mkdtempSync(join(tmpdir(), 'reman-context-sample-'));
	const mcpPath = join(directory, 'mcp.json');
	if (sample.mcp) writeFileSync(mcpPath, JSON.stringify({ mcpServers: { demo: MCP_SERVER } }));
	const requests: IRequestRecord[] = [];
	const captured = new Map<string, ICaptured>();
	/** 每个成员上一次请求时上下文里的各条内容：第一个时间线条目，在输入里占几项、约多少 token。 */
	const contexts = new Map<string, readonly { itemId: number; count: number; tokens: number }[]>();
	/** 每份摘要（按摘要的条目 ID）第一次出现时算出的代替了什么。 */
	const summaries = new Map<number, ISummaryInfo['replaced']>();
	let notes: string[] = [];
	const replies = new Map<string, Reply[]>();
	const proposals = new Map<string, Reply[]>();
	/** 写进上下文的时间：从当天本地 9:00 开始，只由 wait 往前拨，每次生成的样本一样。 */
	let clock = new Date(2026, 10, 6, 9, 0).getTime();

	const client: IModelClient = {
		async respond(request: IModelRequest): Promise<IModelResponse> {
			const memberId = memberOfRequest(request);
			const record = capture(memberId, request);
			const reply = (request.textFormat ? proposals : replies).get(memberId)?.shift();
			await Promise.resolve();
			try {
				const result = typeof reply === 'function' ? reply(request) : reply ?? [];
				const response: IModelResponse = 'output' in result ? result : { output: result, usage: undefined };
				record.output = describeOutput(response);
				return response;
			} catch (error) {
				record.output = [`出错：${error instanceof Error ? error.message : String(error)}`];
				throw error;
			}
		},
	};

	const runtime = new Runtime(':memory:', {
		dataDirectory: directory, ...runtimeDirectories(directory), portableGitDirectory: null, mcpPath,
		models: testModels(sample.models ?? [{ model: 'fake', vision: true, contextWindow: 200_000 }]),
		modelClient: client, backgroundAfterMs: sample.backgroundAfterMs, now: () => clock,
	});
	const memberName = (memberId: string) => runtime.members.get(memberId)?.name ?? memberId;

	runtime.events.subscribe(({ event }) => {
		if (event.type === 'message.created') {
			const message = runtime.messages.get(event.messageId)!;
			const sender = memberName(message.senderMemberId);
			const conversation = message.conversation;
			const where = conversation.kind === 'group'
				? `在群聊「${runtime.groups.get(conversation.groupId)?.name}」说${message.mentionAll ? '（点名所有人）' : message.mentionedMemberIds.length > 0 ? `（点名${message.mentionedMemberIds.map(memberName).join('、')}）` : ''}`
				: `私聊${conversation.memberIds.filter(memberId => memberId !== message.senderMemberId).map(memberName).join('')}`;
			const files = message.attachments.length > 0 ? `（附件 ${message.attachments.map(attachment => attachment.name).join('、')}）` : '';
			notes.push(`${sender}${where}：${short(message.text)}${files}`);
		}
		if (event.type === 'approval.changed') {
			const approval = runtime.approvals.list({ pendingOnly: true }).find(item => item.approvalId === event.approvalId);
			if (!approval) return;
			const decision = sample.approve?.(approval) ?? true;
			notes.push(`审批 ${memberName(approval.memberId)} 的 ${approval.toolName} ${short(JSON.stringify(approval.arguments))}：${decision === true ? '批准' : `拒绝，${decision}`}`);
			setTimeout(() => decision === true ? runtime.approvals.approve(approval.approvalId) : runtime.approvals.deny(approval.approvalId, decision), 0);
		}
		if (event.type === 'run.changed') {
			const run = runtime.runs.list(event.memberId, 1)[0];
			if (run?.status === 'failed') notes.push(`${memberName(event.memberId)} 的运行失败：${run.error}`);
		}
	});

	const human = runtime.members.createHuman('张三');
	const context: ISampleContext = {
		runtime, human,
		ai: (memberName, definition = {}, prompt) => {
			const member = runtime.memberFolders.create(memberName, { definition, prompt });
			rememberMember(runtime, member.memberId);
			return member;
		},
		reply: (member, ...items) => replies.set(member.memberId, [...replies.get(member.memberId) ?? [], ...items]),
		proposal: (member, ...items) => proposals.set(member.memberId, [...proposals.get(member.memberId) ?? [], ...items]),
		say(target, text, options = {}) {
			const attachmentIds = (options.files ?? []).map(path => runtime.attachments.importFile(path).attachmentId);
			runtime.messages.send(human.memberId, target, text, options.mentions ?? [], attachmentIds);
		},
		tell(member, text, files = []) {
			const attachmentIds = files.map(path => runtime.attachments.importFile(path).attachmentId);
			runtime.timeline.appendUserInput(member.memberId, { text, attachmentIds });
			notes.push(`张三直接对${member.name}说：${short(text)}${files.length > 0 ? `（附件 ${files.length} 个）` : ''}`);
		},
		file(fileName, content) {
			const path = join(directory, 'files', fileName);
			mkdirSync(join(directory, 'files'), { recursive: true });
			writeFileSync(path, content);
			return path;
		},
		note: text => void notes.push(text),
		wait(minutes) {
			clock += minutes * 60_000;
			notes.push(`过了 ${minutes} 分钟`);
		},
		waitUntil(year, month, day, hour, minute) {
			const target = new Date(year, month - 1, day, hour, minute).getTime();
			if (target < clock) throw new Error('时间只能往后拨');
			clock = target;
			const pad = (value: number) => String(value).padStart(2, '0');
			notes.push(`时间拨到本地 ${year}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}`);
		},
		async settle() {
			const deadline = Date.now() + 60_000;
			for (let quiet = 0; quiet < 3;) {
				if (Date.now() > deadline) throw new Error('等待超时');
				await runtime.runs.idle();
				await runtime.external.idle();
				await new Promise(resolvePromise => setTimeout(resolvePromise, 30));
				const busy = runtime.members.list().some(member => member.type === 'ai' && !member.deleted && (runtime.runs.isRunning(member.memberId)
					|| runtime.runs.hasPendingWake(member.memberId) || runtime.tasks.list(member.memberId).some(task => task.status === 'running')));
				quiet = busy ? 0 : quiet + 1;
			}
		},
		async until(condition, what) {
			const deadline = Date.now() + 30_000;
			while (!condition()) {
				if (Date.now() > deadline) throw new Error(`一直没有${what}`);
				await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
			}
		},
	};

	let error: string | null = null;
	try {
		if (sample.mcp) await context.until(() => runtime.mcp.snapshot().servers.every(server => server.status !== 'connecting'), 'MCP 服务器连上');
		runtime.runs.start();
		runtime.reminders.start();
		await sample.run(context);
		await context.settle();
	} catch (failure) {
		error = failure instanceof Error ? failure.stack ?? failure.message : String(failure);
	}
	await runtime.runs.shutdown();
	await runtime.close();
	// 终端里的进程刚结束时，Windows 可能还占着目录，等一会儿再删。
	try {
		rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	} catch {
		console.warn(`临时目录没删掉：${directory}`);
	}
	return { name, title: sample.title, description: sample.description, requests, error };

	function capture(memberId: string, request: IModelRequest): IRequestRecord {
		const { input, tools, ...params } = requestBody(request) as { input: readonly object[]; tools: readonly IFunctionTool[] } & Record<string, unknown>;
		const toolsJson = JSON.stringify(tools);
		let toolSet = toolSets.indexOf(toolsJson);
		if (toolSet === -1) toolSet = toolSets.push(toolsJson) - 1;
		const callNames = new Map<string, string>();
		const sectionList = sections(input, !!request.textFormat);
		const previous = captured.get(memberId);
		const inputJson = input.map(item => JSON.stringify(item));
		// 摘要第一次出现时算它代替了什么：上一次请求时上下文里，被这份摘要代替的那几条内容。之后的请求沿用。
		const units = runtime.runs['context'].units(memberId);
		const timeline = new Map(runtime.timeline.all(memberId).map(item => [item.itemId, item]));
		const replacedOf = new Map<string, ISummaryInfo['replaced']>();
		for (const unit of units) {
			if (unit.kind !== 'summary') continue;
			const summaryId = unit.items[0].itemId;
			if (!summaries.has(summaryId)) {
				const gone = contexts.get(memberId)?.filter(old => timeline.get(old.itemId)?.summaryItemId === summaryId);
				summaries.set(summaryId, gone ? { count: gone.reduce((sum, old) => sum + old.count, 0), tokens: gone.reduce((sum, old) => sum + old.tokens, 0) } : null);
			}
			replacedOf.set(JSON.stringify(unit.input[0]), summaries.get(summaryId)!);
		}
		contexts.set(memberId, units.map(unit => ({ itemId: unit.items[0]!.itemId, count: unit.input.length, tokens: unit.input.reduce((sum: number, item) => sum + estimateItemTokens(item), 0) })));
		const items = input.map((item, index): IItemRecord => {
			const record = item as Record<string, unknown>;
			if (record['type'] === 'function_call') callNames.set(String(record['call_id']), String(record['name']));
			const summary = summaryOf(item);
			const base = { section: sectionList[index]!, tokens: estimateItemTokens(item), value: withoutImages(item) };
			if (!summary) return { ...base, label: label(item, callNames) };
			const replaced = replacedOf.get(inputJson[index]!) ?? null;
			return { ...base, label: short(summary.text), summary: { range: summary.range, length: [...summary.text].length, replaced } };
		});
		const toolsTokens = estimateTokens(tools);
		const record: IRequestRecord = {
			index: requests.length, memberId, member: memberName(memberId),
			memberIndex: requests.filter(item => item.memberId === memberId).length + 1,
			kind: request.textFormat ? 'optimization' : 'response',
			notes, params, toolSet, toolsTokens, items,
			totalTokens: toolsTokens + items.reduce((sum, item) => sum + item.tokens, 0),
			output: [],
			comparison: previous ? compare(previous, { inputJson, toolsJson, tools, params, items, toolsTokens }) : null,
		};
		notes = [];
		requests.push(record);
		captured.set(memberId, { record, inputJson, toolsJson, tools });
		return record;
	}
}

function compare(
	previous: ICaptured,
	current: { inputJson: readonly string[]; toolsJson: string; tools: readonly IFunctionTool[]; params: Record<string, unknown>; items: readonly IItemRecord[]; toolsTokens: number },
): IComparison {
	const before = previous.record;
	const params = [...new Set([...Object.keys(before.params), ...Object.keys(current.params)])]
		.filter(key => JSON.stringify(before.params[key]) !== JSON.stringify(current.params[key]));
	const oldTools = new Map(previous.tools.map(tool => [tool.name, JSON.stringify(tool)]));
	const newTools = new Map(current.tools.map(tool => [tool.name, JSON.stringify(tool)]));
	const tools = {
		added: [...newTools.keys()].filter(name => !oldTools.has(name)),
		removed: [...oldTools.keys()].filter(name => !newTools.has(name)),
		changed: [...newTools.keys()].filter(name => oldTools.has(name) && oldTools.get(name) !== newTools.get(name)),
	};
	const toolJson = (list: readonly IFunctionTool[], index: number) => JSON.stringify(list[index]);
	let sameTools = 0;
	while (sameTools < previous.tools.length && sameTools < current.tools.length && toolJson(previous.tools, sameTools) === toolJson(current.tools, sameTools)) sameTools++;
	let same = 0;
	while (same < previous.inputJson.length && same < current.inputJson.length && previous.inputJson[same] === current.inputJson[same]) same++;
	// 上一次的开头和时间线（压缩任务之前的部分）都原样留下，才算正常。
	const kept = before.items.findIndex(item => item.section === 'task');
	const keptEnd = kept === -1 ? before.items.length : kept;
	const broken: string[] = [];
	if (params.includes('model')) broken.push('换了模型');
	if (previous.toolsJson !== current.toolsJson) broken.push(`工具列表从第 ${sameTools + 1} 个（${(current.tools[sameTools] ?? previous.tools[sameTools])!.name}）起变了`);
	let change: IComparison['change'] = null;
	let removed: readonly IItemRecord[] = [];
	if (same < keptEnd) {
		const describe = (items: readonly IItemRecord[]) => items.map(item => `${SECTION_NAMES[item.section]}：${item.label}`).join('；');
		const shifted = current.inputJson.indexOf(previous.inputJson[same]!, same + 1);
		const resumed = previous.inputJson.indexOf(current.inputJson[same] ?? '', same + 1);
		if (shifted !== -1 && (resumed === -1 || shifted <= resumed)) {
			change = { kind: 'inserted', count: shifted - same };
			broken.push(`输入第 ${same + 1} 项前面多了 ${change.count} 项，后面的原样往后挪（${describe(current.items.slice(same, shifted))}）`);
		} else if (resumed !== -1) {
			change = { kind: 'removed', count: resumed - same };
			removed = before.items.slice(same, resumed);
			broken.push(`上一次输入的第 ${same + 1}${change.count > 1 ? `–${resumed}` : ''} 项没有了（${describe(removed)}）`);
		} else {
			change = { kind: 'changed', count: 1 };
			removed = [before.items[same]!];
			broken.push(`输入第 ${same + 1} 项变了（${describe(removed)}）`);
		}
	}
	const cachedTokens = params.includes('model') ? 0
		: previous.toolsJson !== current.toolsJson ? estimateTokens(current.tools.slice(0, sameTools))
			: current.toolsTokens + current.items.slice(0, same).reduce((sum, item) => sum + item.tokens, 0);
	return { previous: before.index, params, tools, sameTools, same, cachedTokens, broken, change, before: removed };
}

/** 身份和规则、成员设定到通讯录那条用户消息是开头；压缩请求的最后一项是任务说明；其余是时间线。 */
function sections(input: readonly object[], optimization: boolean): Section[] {
	let state: Section = 'prefix';
	return input.map((item, index) => {
		const record = item as Record<string, unknown>;
		const opening = record['role'] === 'user' && OPENING.test(firstText(record));
		if (state === 'prefix' && record['role'] !== 'developer' && !opening) state = 'timeline';
		return optimization && index === input.length - 1 ? 'task' : state;
	});
}

/** 压缩写下的摘要：代替了哪段时间和摘要正文；不是摘要时是 undefined。 */
function summaryOf(item: object): { range: string; text: string } | undefined {
	const match = /^\[内容编号 \d+\]\s*以下是你此前整理的较早内容的摘要，时间范围为 (.+?)：\n([\s\S]*)$/.exec(firstText(item as Record<string, unknown>));
	return match ? { range: match[1]!, text: match[2]! } : undefined;
}

/** 一项的简短说明。 */
function label(item: object, callNames: ReadonlyMap<string, string>): string {
	const record = item as Record<string, any>;
	switch (record['type']) {
		case 'function_call': return `调用 ${record['name']}：${short(String(record['arguments']))}`;
		case 'function_call_output': {
			const output = record['output'];
			const text = typeof output === 'string' ? output : (output as Record<string, unknown>[]).filter(part => part['type'] === 'input_text').map(part => part['text']).join('\n');
			const images = Array.isArray(output) ? output.filter(part => part['type'] === 'input_image').length : 0;
			return `结果 ${callNames.get(String(record['call_id'])) ?? ''}：${short(text)}${images > 0 ? `（图片 ${images} 张）` : ''}`;
		}
		case 'reasoning': {
			const text = texts(record['content']) || texts(record['summary']);
			return `思考${record['encrypted_content'] ? '（加密）' : ''}${text ? `：${short(text)}` : ''}`;
		}
	}
	if (record['role'] === 'assistant') return `输出：${short(texts(record['content']))}`;
	const text = firstText(record);
	if (record['role'] === 'developer') {
		if (text.startsWith('你的身份')) return '身份和运行规则';
	}
	if (record['role'] === 'user' && OPENING.test(text)) {
		const parts = { '# 成员设定': '成员设定', '# 你的记忆': '记忆', '# 运行环境': '运行环境', '# 通讯录': '通讯录' };
		return Object.entries(parts).filter(([heading]) => new RegExp(`^${heading}$`, 'm').test(text)).map(([, name]) => name).join('、');
	}
	const content = Array.isArray(record['content']) ? record['content'] as Record<string, unknown>[] : [];
	const images = content.filter(part => part['type'] === 'input_image').length;
	const all = content.filter(part => part['type'] === 'input_text').map(part => String(part['text'])).join('\n');
	return `${short(all)}${images > 0 ? `（图片 ${images} 张）` : ''}`;
}

function describeOutput(response: IModelResponse): string[] {
	const lines = response.output.map(item => label(item, new Map()));
	if (lines.length === 0) lines.push('（空的）');
	if (response.usage) lines.push(`报告的用量：输入 ${response.usage.inputTokens}，缓存 ${response.usage.cachedTokens}`);
	return lines;
}

function firstText(record: Record<string, unknown>): string {
	const content = record['content'];
	if (typeof content === 'string') return content;
	const first = Array.isArray(content) ? content[0] as Record<string, unknown> | undefined : undefined;
	return typeof first?.['text'] === 'string' ? first['text'] : '';
}

function texts(parts: unknown): string {
	if (!Array.isArray(parts)) return '';
	return parts.map((part: { text?: unknown }) => typeof part?.text === 'string' ? part.text : '').filter(Boolean).join('\n');
}

/** 图片的 data: 地址换成占位，写明类型和大小。 */
function withoutImages(item: object): unknown {
	return JSON.parse(JSON.stringify(item, (key, value: unknown) => {
		if (key !== 'image_url' || typeof value !== 'string' || !value.startsWith('data:')) return value;
		const comma = value.indexOf(',');
		const type = value.slice(5, value.indexOf(';'));
		return `[图片 ${type}，${((value.length - comma - 1) * 3 / 4 / 1024).toFixed(1)} KB]`;
	})) as unknown;
}

function short(text: string, max = 80): string {
	const flat = text.replace(/\s+/g, ' ').trim();
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
