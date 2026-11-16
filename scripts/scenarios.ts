/**
 * 用真实模型跑测试场景（开发用，不属于运行时）。
 * 用法：node scripts/scenarios.ts <场景名> --data-dir <数据目录>
 * 模型配置读数据目录的 models.json；每次运行在 <数据目录>/scenarios/<场景名>-<时间>/ 下新建数据，跑完写 transcript.md。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Secrets } from '../src/common/secrets.ts';
import { runtimeDirectories } from '../src/dataDirectory.ts';
import type { IMemberDefinition } from '../src/members/definition.ts';
import type { IMember } from '../src/members/members.ts';
import type { ConversationTarget } from '../src/messages/messages.ts';
import { ModelConfig } from '../src/models/config.ts';
import { Runtime } from '../src/runtime.ts';
import type { IApproval } from '../src/tools/approvals.ts';
import { SCENARIOS } from './scenarioList.ts';

export interface IScenarioContext {
	readonly runtime: Runtime;
	readonly directory: string;
	readonly human: IMember;
	ai(name: string, definition?: IMemberDefinition, prompt?: string): IMember;
	/** 以真人身份发消息，可以带本地文件作为附件。 */
	say(target: ConversationTarget, text: string, options?: { readonly mentions?: readonly string[] | 'all'; readonly files?: readonly string[] }): void;
	/** 等到没有运行、没有后台任务、没有待处理的唤醒。 */
	settle(timeoutMs?: number): Promise<void>;
	log(line: string): void;
}

export interface IScenario {
	readonly description: string;
	/** 审批怎么处理：返回 true 批准，字符串表示拒绝的理由。默认都批准。 */
	readonly approve?: (approval: IApproval) => true | string;
	/** 改模型配置，例如把上下文长度调小来测压缩。 */
	readonly models?: (config: Record<string, any>) => void;
	run(context: IScenarioContext): Promise<void>;
}

const { values, positionals } = parseArgs({ allowPositionals: true, options: { 'data-dir': { type: 'string' } } });
const name = positionals[0];
const scenario = name ? SCENARIOS[name] : undefined;
if (!scenario || !values['data-dir']) {
	console.error(`用法: node scripts/scenarios.ts <场景名> --data-dir <数据目录>\n场景：\n${Object.entries(SCENARIOS).map(([key, item]) => `  ${key}：${item.description}`).join('\n')}`);
	process.exit(1);
}
const dataDirectory = resolve(values['data-dir']);
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
const directory = join(dataDirectory, 'scenarios', `${name}-${stamp}`);
mkdirSync(directory, { recursive: true });
const secrets = Secrets.fromFile(join(dataDirectory, 'secret-key'));
const fileModels = ModelConfig.fromFile(join(dataDirectory, 'models.json'), secrets);
const models = scenario.models
	? new ModelConfig(() => {
		const config = JSON.parse(readFileSync(join(dataDirectory, 'models.json'), 'utf8')) as Record<string, any>;
		scenario.models!(config);
		return config;
	}, undefined, secrets)
	: fileModels;
const runtime = new Runtime(join(directory, 'runtime.sqlite'), {
	models, ...runtimeDirectories(directory),
});

const started = Date.now();
const logLines: string[] = [];
const log = (line: string) => {
	const stamped = `[${((Date.now() - started) / 1000).toFixed(1).padStart(6)}s] ${line}`;
	logLines.push(stamped);
	console.log(stamped);
};

// 审批：按场景的规则自动处理，并记下来。
runtime.events.subscribe(item => {
	if (item.event.type !== 'approval.changed') return;
	const approval = runtime.approvals.list({ pendingOnly: true }).find(entry => entry.approvalId === (item.event as { approvalId: number }).approvalId);
	if (!approval) return;
	const decision = scenario.approve?.(approval) ?? true;
	const who = runtime.members.get(approval.memberId)?.name;
	log(`审批 #${approval.approvalId} ${who} ${approval.toolName} ${short(JSON.stringify(approval.arguments), 200)}${approval.reasons.length + approval.protectedReasons.length > 0 ? `（${[...approval.protectedReasons, ...approval.reasons].join('；')}）` : ''} → ${decision === true ? '批准' : `拒绝：${decision}`}`);
	setTimeout(() => decision === true ? runtime.approvals.approve(approval.approvalId) : runtime.approvals.deny(approval.approvalId, decision), 0);
});
runtime.events.subscribe(item => {
	if (item.event.type === 'message.created') {
		const message = runtime.messages.get(item.event.messageId)!;
		const sender = runtime.members.get(message.senderMemberId)!.name;
		const where = message.conversation.kind === 'group' ? `群 ${runtime.groups.get(message.conversation.groupId)?.name}` : `私聊 ${message.conversation.memberIds.map(id => runtime.members.get(id)!.name).filter(other => other !== sender).join('')}`;
		log(`消息 ${sender} → ${where}：${short(message.text, 160)}${message.attachments.length ? `（附件 ${message.attachments.map(attachment => attachment.name).join('、')}）` : ''}`);
	}
	if (item.event.type === 'run.changed') {
		const run = runtime.runs.list(item.event.memberId, 1)[0];
		if (run && run.status !== 'running') log(`运行结束 ${runtime.members.get(item.event.memberId)?.name} #${run.runId} ${run.kind} ${run.status}${run.error ? `：${run.error}` : ''}（请求 ${run.requestCount} 次，输入 ${run.inputTokens}，输出 ${run.outputTokens}）`);
	}
});

const human = runtime.members.createHuman('张三');
const context: IScenarioContext = {
	runtime, directory, human, log,
	ai(memberName, definition = {}, prompt) {
		return runtime.memberFolders.create(memberName, { definition, prompt });
	},
	say(target, text, options = {}) {
		const attachmentIds = (options.files ?? []).map(path => runtime.attachments.importFile(path).attachmentId);
		runtime.messages.send(human.memberId, target, text, options.mentions ?? [], attachmentIds);
	},
	async settle(timeoutMs = 10 * 60 * 1000) {
		const deadline = Date.now() + timeoutMs;
		let quiet = 0;
		while (quiet < 3) {
			if (Date.now() > deadline) throw new Error('等待超时');
			await runtime.runs.idle();
			await new Promise(resolvePromise => setTimeout(resolvePromise, 1000));
			const ais = runtime.members.list().filter(member => member.type === 'ai' && !member.deleted);
			const busy = ais.some(member => runtime.runs.isRunning(member.memberId) || runtime.runs.hasPendingWake(member.memberId)
				|| runtime.tasks.list(member.memberId).some(task => task.status === 'running'));
			quiet = busy ? 0 : quiet + 1;
		}
	},
};

runtime.runs.start();
let failure: unknown;
try {
	await scenario.run(context);
	await context.settle();
} catch (error) {
	failure = error;
	log(`场景出错：${error instanceof Error ? error.stack : String(error)}`);
}
await runtime.runs.shutdown();
writeFileSync(join(directory, 'transcript.md'), transcript());
await runtime.close();
console.log(`\n记录：${join(directory, 'transcript.md')}`);
process.exit(failure ? 1 : 0);

/** 每个 AI 成员的时间线，加上运行日志。 */
function transcript(): string {
	const lines = [`# 场景 ${name}：${scenario!.description}`, '', `用时 ${((Date.now() - started) / 1000).toFixed(0)} 秒`, ''];
	for (const member of runtime.members.list().filter(item => item.type === 'ai')) {
		lines.push(`## ${member.name}（${member.memberId}）`, '');
		for (const run of runtime.runs.list(member.memberId, 200).reverse()) {
			lines.push(`- 运行 #${run.runId} ${run.kind} ${run.status}${run.error ? `：${run.error}` : ''}，请求 ${run.requestCount} 次，输入 ${run.inputTokens}，输出 ${run.outputTokens}`);
		}
		lines.push('');
		for (const item of runtime.timeline.all(member.memberId)) {
			const state = item.contextState === 'visible' ? '' : `［${item.contextState}］`;
			lines.push(`${state}${describeItem(member.memberId, item)}`);
		}
		lines.push('');
	}
	lines.push('## 运行日志', '', '```', ...logLines, '```', '');
	return lines.join('\n');
}

function describeItem(memberId: string, item: ReturnType<Runtime['timeline']['all']>[number]): string {
	switch (item.kind) {
		case 'message': {
			const message = runtime.messages.get(item.messageId)!;
			return `**收到** ${runtime.members.get(message.senderMemberId)?.name}${item.wakes ? '' : '（不唤醒）'}：${message.text}${message.attachments.length ? `\n  附件：${message.attachments.map(attachment => attachment.name).join('、')}` : ''}`;
		}
		case 'group_event': return `**群聊变动** ${item.event.type} ${item.event.groupName}`;
		case 'model_output': {
			const output = item.output as Record<string, any>;
			if (output['type'] === 'message') return `**写了**：${(output['content'] as { text?: string }[]).map(part => part.text ?? '').join('')}`;
			if (output['type'] === 'function_call') return `**调用** ${output['name']} ${short(String(output['arguments']), 600)}`;
			if (output['type'] === 'reasoning') {
				const summary = ((output['summary'] ?? []) as { text?: string }[]).map(part => part.text ?? '').join(' ');
				return summary ? `*思考：${short(summary, 400)}*` : '*（思考）*';
			}
			return `**输出** ${output['type']}`;
		}
		case 'tool_result': return `**结果** ${item.result.name}${item.result.isError ? '（出错）' : ''}${item.result.images?.length ? `（图片 ${item.result.images.length} 张）` : ''}：${short(item.result.output, 800)}`;
		case 'task_result': return `**后台任务结束** ${item.task.toolName} ${item.task.status}：${short(item.task.output, 400)}`;
		case 'terminal_event': return `**终端** ${item.event.terminalId} ${item.event.event}`;
		case 'external_event': return `**外部事件** ${item.external.source}${item.wakes ? '' : '（不唤醒）'}：${short(item.external.text, 800)}`;
		case 'user_input': return `**用户直接说**：${item.input.text}`;
		case 'reminder': return `**定时到了** ${item.reminder.reminderId} ${item.reminder.time}：${short(item.reminder.note, 400)}`;
		case 'summary': return `**摘要**：${short(item.summary.text, 1200)}`;
		case 'omission': return `**没放进上下文** ${item.omission.count} 条`;
		case 'memory_change': return `**压缩时更新记忆**（${item.change.length} 字）：${short(JSON.stringify(item.change.operations), 800)}`;
		case 'pruning': return `**压缩时删掉了内容**：${JSON.stringify(item.pruning.counts)}`;
		case 'optimization': {
			const { status, error, estimate, requests } = item.optimization;
			const problems = requests.flatMap(request => request.problems);
			return `**压缩记录** ${status}${error ? `：${error}` : ''}，${requests.length} 次请求，估算 ${estimate.before} → ${estimate.after ?? '-'}${problems.length ? `，不合规：${short(problems.join('；'), 600)}` : ''}`;
		}
		case 'change_notice': return `**变动说明**：${short(item.notice.text, 800)}`;
		case 'plan': return `**计划说明**：${short(JSON.stringify(item.plan.items), 800)}`;
	}
	void memberId;
}

function short(text: string, max: number): string {
	const flat = text.replace(/\s*\n\s*/g, ' ⏎ ');
	return flat.length > max ? `${flat.slice(0, max)}…（共 ${flat.length} 字）` : flat;
}
