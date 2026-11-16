/**
 * 上下文样本的情景（开发用，不属于运行时）。由 contextSamples.ts 逐个运行。
 * 每个情景新建一个运行时，用假模型：成员每次请求模型，按 reply / proposal 排好的回复依次返回，排完了返回空的，运行结束。
 * 先等上一步的唤醒处理完（settle），再排下一步的回复，回复才不会被别的唤醒用掉。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import { systemTimeZone } from '../src/common/time.ts';
import type { IGroup } from '../src/groups/groups.ts';
import type { IMemberDefinition } from '../src/members/definition.ts';
import type { IMember } from '../src/members/members.ts';
import type { ConversationTarget } from '../src/messages/messages.ts';
import type { IModelRequest, IModelResponse } from '../src/models/client.ts';
import type { Runtime } from '../src/runtime.ts';
import type { IModelOutputItem } from '../src/timeline/timeline.ts';
import type { IApproval } from '../src/tools/approvals.ts';

/** 模型对一次请求的回复：输出项，带用量的完整回复，或者按请求现算。 */
export type Reply = readonly IModelOutputItem[] | IModelResponse | ((request: IModelRequest) => readonly IModelOutputItem[] | IModelResponse);

export interface ISampleContext {
	readonly runtime: Runtime;
	/** 真人成员张三。 */
	readonly human: IMember;
	ai(name: string, definition?: IMemberDefinition, prompt?: string): IMember;
	/** 这个成员接下来的各次正常请求，模型依次这样回复。 */
	reply(member: IMember, ...replies: Reply[]): void;
	/** 这个成员接下来的各次压缩请求，模型依次这样回复。 */
	proposal(member: IMember, ...replies: Reply[]): void;
	/** 张三发消息，可以带文件。 */
	say(target: ConversationTarget, text: string, options?: { readonly mentions?: readonly string[] | 'all'; readonly files?: readonly string[] }): void;
	/** 张三直接对成员说话，可以带文件。 */
	tell(member: IMember, text: string, files?: readonly string[]): void;
	/** 在情景的临时目录里写一个文件，返回路径。 */
	file(name: string, content: string | Buffer): string;
	/** 记下发生了什么，显示在下一次请求前面。消息、审批、运行失败会自动记下。 */
	note(text: string): void;
	/** 写进上下文的时间往前拨几分钟，不真的等。情景从当天本地 9:00 开始。 */
	wait(minutes: number): void;
	/** 写进上下文的时间拨到本地的这一刻（月份从 1 起），只能往后拨。 */
	waitUntil(year: number, month: number, day: number, hour: number, minute: number): void;
	/** 等到没有运行、没有后台任务、没有待处理的唤醒。 */
	settle(): Promise<void>;
	/** 等到条件成立。 */
	until(condition: () => boolean, what: string): Promise<void>;
}

export interface ISample {
	readonly title: string;
	/** 这个情景要看什么。 */
	readonly description: string;
	/** 模型列表，第一个是默认模型。不写时是一个能看图、上下文 200k 的模型 fake。 */
	readonly models?: readonly object[];
	/** 一开始就连上测试用的 MCP 服务器 demo。 */
	readonly mcp?: boolean;
	/** 工具执行多久转为后台任务。 */
	readonly backgroundAfterMs?: number;
	/** 审批：返回 true 批准，字符串是拒绝的理由。不写时都批准。 */
	readonly approve?: (approval: IApproval) => true | string;
	run(context: ISampleContext): Promise<void>;
}

/** 测试用的 MCP 服务器。 */
export const MCP_SERVER = {
	command: process.execPath,
	args: ['--disable-warning=ExperimentalWarning', fileURLToPath(new URL('../src/mcp/testServer.ts', import.meta.url))],
};

let outputs = 0;
const nextId = (prefix: string) => `${prefix}_${String(++outputs).padStart(4, '0')}`;

/** 调用工具。 */
export function call(name: string, args: object = {}): IModelOutputItem {
	return { type: 'function_call', id: nextId('fc'), status: 'completed', call_id: nextId('call'), name, arguments: JSON.stringify(args) };
}

/** 用 send_message 发消息；mentions 只用于群聊。 */
export function send(to: IMember | IGroup, text: string, mentions?: readonly IMember[] | 'all'): IModelOutputItem {
	const target = 'groupId' in to ? to.groupId : to.memberId;
	return call('send_message', { target, text, ...mentions ? { mentions: mentions === 'all' ? ['all'] : mentions.map(member => member.memberId) } : {} });
}

/** 直接输出的文字。 */
export function output(text: string): IModelOutputItem {
	return { type: 'message', id: nextId('msg'), status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] };
}

/** 思考：摘要是明文，正文是加密的。 */
export function think(summary: string): IModelOutputItem {
	const id = nextId('rs');
	return { type: 'reasoning', id, summary: [{ type: 'summary_text', text: summary }], encrypted_content: `gAAAAB${Buffer.from(`加密的思考 ${id}`).toString('base64')}` };
}

/** 带用量的回复，用来让运行时以为输入已经很长。 */
export function withUsage(output: readonly IModelOutputItem[], inputTokens: number): IModelResponse {
	return { output, usage: { inputTokens, cachedTokens: 0, outputTokens: 50 } };
}

/** 压缩方案。 */
export function proposal(ops: readonly object[]): IModelOutputItem[] {
	return [output(JSON.stringify({ ops }))];
}

/** 请求里出现的内容编号，按先后排；不算开头的规则里举的例子。 */
export function numbers(request: IModelRequest): number[] {
	const timeline = request.input.filter(item => (item as Record<string, unknown>)['role'] !== 'developer');
	return [...JSON.stringify(timeline).matchAll(/\[内容编号 (\d+)\]/g)].map(match => Number(match[1]));
}

export const direct = (member: IMember): ConversationTarget => ({ kind: 'direct', memberId: member.memberId });
export const group = (target: IGroup): ConversationTarget => ({ kind: 'group', groupId: target.groupId });

/** 一张纯色的 PNG。 */
export function png(width: number, height: number, [red, green, blue]: readonly [number, number, number]): Buffer {
	const chunk = (type: string, data: Buffer) => {
		const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
		const length = Buffer.alloc(4);
		length.writeUInt32BE(data.length);
		const checksum = Buffer.alloc(4);
		checksum.writeUInt32BE(crc32(body));
		return Buffer.concat([length, body, checksum]);
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = 2;
	const row = Buffer.concat([Buffer.from([0]), ...Array.from({ length: width }, () => Buffer.from([red, green, blue]))]);
	const pixels = Buffer.concat(Array.from({ length: height }, () => row));
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

const AI: IMemberDefinition = { directMessage: 'all' };

export const SAMPLES: Readonly<Record<string, ISample>> = {
	direct: {
		title: '私聊',
		description: '真人私聊 AI、AI 私聊 AI；请求进行中又收到的消息排在这次请求的输出后面；只有思考和空文字的一轮不进上下文。',
		async run(c) {
			const host = c.ai('沈安', AI);
			const peer = c.ai('陈屿', AI);
			c.reply(host,
				() => {
					c.say(direct(host), '会议室在 302');
					return [think('先通知陈屿'), send(peer, '下午三点开会，张三通知的')];
				},
				[think('会议室也要告诉陈屿'), send(peer, '会议室在 302'), send(c.human, '已经通知陈屿了，会议室也说了')],
				[think('陈屿只是确认收到，不用回复'), output('')],
			);
			c.reply(peer, [send(host, '收到')]);
			c.say(direct(host), '帮我通知陈屿下午三点开会');
			await c.settle();
			c.reply(host, [output('')]);
			c.say(direct(host), '好的，谢谢');
			await c.settle();
		},
	},

	group: {
		title: '群聊',
		description: '被拉进群；不点名的消息不唤醒，下次一并看到；点名；关注和取消关注；被移出；群解散。',
		async run(c) {
			const host = c.ai('沈安', AI);
			const peer = c.ai('陈屿', AI);
			const team = c.runtime.groups.create(c.human.memberId, '项目组', [host.memberId, peer.memberId]);
			c.note('张三建了群聊「项目组」，拉进沈安和陈屿');
			await c.settle();
			c.say(group(team), '大家好，这个群用来讨论周五上线');
			c.reply(host, [send(team, '需求我整理好了，陈屿看看排期', [peer])]);
			c.reply(peer, [send(team, '排期没问题，周五能完成')]);
			c.say(group(team), '沈安整理一下需求', { mentions: [host.memberId] });
			await c.settle();
			c.runtime.groups.setWatching(team.groupId, host.memberId, true, 'user');
			c.note('张三替沈安关注了「项目组」');
			await c.settle();
			c.reply(host, [send(team, '好，我盯着上线')]);
			c.say(group(team), '上线时间定在周五晚上八点');
			await c.settle();
			c.runtime.groups.setWatching(team.groupId, host.memberId, false, 'user');
			c.note('张三取消了沈安对「项目组」的关注');
			c.runtime.groups.updateMembers(c.human.memberId, team.groupId, [], [peer.memberId]);
			c.note('张三把陈屿移出了「项目组」');
			await c.settle();
			c.runtime.groups.dissolve(c.human.memberId, team.groupId);
			c.note('张三解散了「项目组」');
			await c.settle();
			c.reply(host, [send(c.human, '知道了')]);
			c.say(direct(host), '群解散了，后面私聊');
			await c.settle();
		},
	},

	input: {
		title: '用户直接说话和附件',
		description: '用户直接对成员说话，带图片和文件；私聊带图片；换成不能看图的模型后图片怎么出现。',
		models: [{ model: 'fake', vision: true, contextWindow: 200_000 }, { model: 'blind', vision: false, contextWindow: 200_000 }],
		async run(c) {
			const host = c.ai('沈安', AI);
			const image = c.file('red.png', png(64, 48, [220, 40, 40]));
			const notes = c.file('notes.txt', '第一行\n第二行\n');
			c.reply(host, [output('图里是一个红色方块；notes.txt 有两行。')]);
			c.tell(host, '看看这张图和这个文件', [image, notes]);
			await c.settle();
			c.reply(host, [send(c.human, '收到，和刚才是同一张图')]);
			c.say(direct(host), '私聊里也发你一张', { files: [image] });
			await c.settle();
			c.runtime.memberFolders.setModel(host.memberId, { provider: 'test', name: 'blind' }, null);
			c.note('沈安换成不能看图的模型 blind');
			c.reply(host, [output('现在看不到图片了')]);
			c.tell(host, '再看一下刚才的图');
			await c.settle();
		},
	},

	tools: {
		title: '工具',
		description: '一次调用多个工具；渐进式工具先查看再调用；改记忆、查历史、shell 成功和失败、写文件和改文件、看图片、审批被拒绝、定时和定时到了。',
		approve: approval => JSON.stringify(approval.arguments).includes('git push') ? '先别推送，等我确认' : true,
		async run(c) {
			const host = c.ai('沈安', AI);
			const chart = c.file('chart.png', png(80, 60, [40, 120, 220]));
			c.reply(host,
				[
					think('先记下偏好，再准备部署'),
					call('manage_memory', { action: 'add', text: '张三喜欢简短的回复' }),
					call('more_tools', { action: 'describe', tool_name: 'search_history' }),
					call('shell', { command: 'node --version' }),
				],
				[
					call('search_history', { keywords: ['部署'] }),
					call('shell', { command: 'node -e "console.error(\'构建失败：缺少配置\'); process.exit(3)"' }),
					call('write_file', { path: 'deploy.md', content: '# 部署步骤\n1. 构建\n2. 上传\n' }),
				],
				[
					call('edit_file', { path: 'deploy.md', edits: [{ old_text: '2. 上传\n', new_text: '2. 上传\n3. 通知张三\n' }] }),
					call('more_tools', { action: 'call', tool_name: 'view_image', arguments: { paths: [chart] } }),
					call('shell', { command: 'git push' }),
				],
				[call('more_tools', { action: 'call', tool_name: 'manage_reminders', arguments: { action: 'add', delay_seconds: 1, note: '提醒张三看部署结果' } })],
				[output('准备好了：部署步骤写在 deploy.md，推送等你确认。')],
				[send(c.human, '部署结果出来了，记得看')],
			);
			c.tell(host, '帮我准备一下部署', [chart]);
			await c.settle();
			await c.until(() => c.runtime.timeline.all(host.memberId).some(item => item.kind === 'reminder'), '定时到了');
			c.note('定时到了');
			await c.settle();
		},
	},

	mcp: {
		title: 'MCP 工具',
		description: 'MCP 工具在「更多工具」里：查看说明、直接调用、通过 more_tools 调用；结果带图片、出错。',
		mcp: true,
		async run(c) {
			const host = c.ai('沈安', { ...AI, tools: [...c.runtime.tools.defaultEnabledNames(), 'mcp:demo'] });
			c.reply(host,
				[call('more_tools', { action: 'describe', tool_name: 'demo__weather' })],
				[call('demo__weather', { city: '上海' }), call('more_tools', { action: 'call', tool_name: 'demo__picture', arguments: {} }), call('demo__fail')],
				[send(c.human, '上海晴')],
			);
			c.say(direct(host), '查一下上海的天气');
			await c.settle();
		},
	},

	background: {
		title: '后台任务、终端和外部事件',
		description: '命令执行时间长转为后台任务，任务结束的结果；用户接管终端时 AI 不能输入，交还后收到通知；外部来源推来的事件。',
		backgroundAfterMs: 500,
		async run(c) {
			const host = c.ai('沈安', { ...AI, tools: [...c.runtime.tools.defaultEnabledNames(), 'terminal'] });
			c.reply(host,
				[call('shell', { command: 'node -e "setTimeout(() => console.log(\'构建完成\'), 2000)"' })],
				[output('构建转到后台了，完成后再看')],
				[send(c.human, '构建完成了')],
			);
			c.tell(host, '跑一下构建');
			await c.settle();

			c.reply(host, [call('terminal', { input: 'echo 准备好了\n' })], [output('终端开好了')]);
			c.tell(host, '开个终端');
			await c.settle();
			const terminal = c.runtime.terminals.list().find(item => item.createdBy === host.memberId);
			if (!terminal) throw new Error('沈安没有建终端');
			c.runtime.terminals.takeover(terminal.terminalId);
			c.note('张三接管了终端');
			c.reply(host, [call('terminal', { terminal_id: terminal.terminalId, input: 'ls\n' })], [output('张三在用终端，等交还')]);
			c.tell(host, '在终端里看看有哪些文件');
			await c.settle();
			c.reply(host,
				[call('terminal', { terminal_id: terminal.terminalId, input: 'ls\n' })],
				[call('terminal', { terminal_id: terminal.terminalId, close: true })],
				[output('看完了，终端关了')],
			);
			c.runtime.terminals.release(terminal.terminalId);
			c.note('张三交还了终端');
			await c.settle();

			mkdirSync(c.runtime.external.routes.directory, { recursive: true });
			writeFileSync(join(c.runtime.external.routes.directory, 'to-host.js'), `export const sources = ['github'];\nexport default () => ({ to: '${host.memberId}' });\n`);
			c.reply(host, [output('PR 12 有新评论，等张三安排')]);
			c.runtime.external.event('github', { content: '新评论：部署脚本里的端口写错了', meta: { repo: 'human', pull_request: '12', author: 'lisi' } });
			c.note('GitHub 推来一条事件，路由投给沈安');
			await c.settle();
		},
	},

	stopped: {
		title: '运行中途停止',
		description: '命令执行到一半时暂停成员，调用的结果是怎样的；恢复后接着运行。',
		async run(c) {
			const host = c.ai('沈安', AI);
			c.reply(host, [call('shell', { command: 'node -e "setTimeout(() => {}, 20000)"' })], [output('刚才的命令被停下了')]);
			c.tell(host, '跑一个很久的命令');
			await c.until(() => c.runtime.runs.activity(host.memberId)?.phase === 'tools' && c.runtime.approvals.list({ pendingOnly: true }).length === 0, '开始执行命令');
			await new Promise(resolve => setTimeout(resolve, 500));
			c.runtime.runs.pause(host.memberId);
			c.note('张三暂停了沈安');
			await c.runtime.runs.idle();
			c.runtime.runs.resume(host.memberId);
			c.note('张三恢复了沈安');
			await c.settle();
		},
	},

	optimize: {
		title: '压缩',
		description: '输入到了七成，运行结束时压缩：压缩请求沿用正常的上下文，最后加任务说明；最近的内容（没看过的，加往前约上下文长度 5%）不能处理；压缩后摘要在原来的位置，记忆快照刷新。',
		models: [{ model: 'fake', vision: true, contextWindow: 100_000 }],
		async run(c) {
			const host = c.ai('沈安', AI);
			const template = c.file('纪要模板.md', Array.from({ length: 250 }, (_, index) => `## 议题 ${index + 1}\n- 讨论要点：\n- 结论：\n- 待办：负责人、截止时间\n`).join('\n'));
			c.reply(host, [send(c.human, '好的，我去订周五下午两点到四点的会议室，十个人，带投影仪和白板，订好后告诉你')]);
			c.say(direct(host), '订周五下午两点到四点的会议室，十个人，要有投影仪和白板，订好后发我确认');
			await c.settle();
			// 读一份长的模板：它和后面的内容约占上下文长度的 5%，是最近的内容；更早的订会议室可以处理。
			c.reply(host, [call('shell', { command: `cat "${template.replaceAll('\\', '/')}"` })], [send(c.human, '模板看过了，按议题、结论、待办记')]);
			c.say(direct(host), `会议纪要按 ${template} 这个模板写，先看一下`);
			await c.settle();
			c.reply(host, withUsage([send(c.human, '订好了，302 会议室，投影仪和白板都有')], 75_000));
			c.proposal(host, request => {
				const [first, second] = numbers(request);
				return proposal([
					{ op: 'summarize', ids: [first, second], summary: '张三让我订周五下午两点到四点的会议室（十个人，要投影仪和白板），我答应了' },
					{ op: 'memory_add', text: '张三常订周五下午的会议室' },
				]);
			});
			c.say(direct(host), '订好了吗');
			await c.settle();
			c.reply(host, [send(c.human, '下周一的也订好了')]);
			c.say(direct(host), '再订下周一的');
			await c.settle();
		},
	},

	search: {
		title: '查历史',
		description: '压缩后摘要带关键词，查不到的关键词被丢掉；按摘要的时间范围和关键词查原文，找到被摘要代替的消息和自己发出的消息；只查含图片的内容；限定对话和发送者；每条只返回开头；仍能看到原文的内容和填错的关键词查不到。',
		models: [{ model: 'fake', vision: true, contextWindow: 100_000 }],
		async run(c) {
			const host = c.ai('沈安', AI);
			const team = c.runtime.groups.create(c.human.memberId, '运维组', [host.memberId]);
			c.note('张三建了群聊「运维组」，拉进沈安');
			await c.settle();
			const diagram = c.file('架构图.png', png(64, 48, [60, 90, 200]));
			const template = c.file('上线记录模板.md', Array.from({ length: 400 }, (_, index) => `## 步骤 ${index + 1}\n- 操作：\n- 结果：\n- 负责人：\n`).join('\n'));

			// 私聊带图片；沈安用 send_message 回复，这条消息之后也查得到。
			c.reply(host, [send(c.human, '收到：部署脚本是 scripts/deploy.sh，端口改成 8080，架构图看过了')]);
			c.say(direct(host), '部署脚本在 scripts/deploy.sh，端口改成 8080，架构图发你', { files: [diagram] });
			await c.settle();
			// 群里不点名的消息不唤醒，下次一并看到；跑一个报错的命令。
			c.say(group(team), '数据库迁移脚本 migrate-0412.sql 已经合并');
			c.reply(host,
				[call('shell', { command: 'node -e "console.error(\'连接数据库失败：E1042 connection refused\'); process.exit(1)"' })],
				[send(c.human, '检查过了，连不上数据库，报 E1042')],
			);
			c.say(direct(host), '先检查一下数据库连接');
			await c.settle();
			// 读一份长的模板：它和后面的内容是最近的内容，压缩时不能处理。
			c.reply(host, [call('shell', { command: `cat "${template.replaceAll('\\', '/')}"` })], [send(c.human, '模板看过了')]);
			c.say(direct(host), `上线记录按 ${template} 这个模板写，先看一下`);
			await c.settle();

			// 输入到了七成，运行结束时压缩。关键词里「回滚方案」在被代替的内容里没有，被丢掉。
			c.reply(host, withUsage([send(c.human, '好，周五上线前我再确认一遍')], 75_000));
			c.proposal(host, request => {
				const [, privateMessage, privateReply, groupMessage, check, checkResult, checkReply] = numbers(request);
				return proposal([
					{
						op: 'summarize', ids: [privateMessage, privateReply],
						summary: '张三私聊说部署脚本在 scripts/deploy.sh，端口改为 8080，并发来架构图（架构图.png）；我回复已收到。',
						keywords: ['deploy.sh', '8080', '架构图.png'],
					},
					{
						op: 'summarize', ids: [groupMessage, check, checkResult, checkReply],
						summary: '「运维组」里张三说迁移脚本 migrate-0412.sql 已合并；张三让我检查数据库连接，命令报 E1042（connection refused），我已告知张三。',
						keywords: ['migrate-0412.sql', 'E1042', '回滚方案'],
					},
				]);
			});
			c.say(direct(host), '周五上线，记得提前确认');
			await c.settle();
			c.note('摘要的时间范围和查历史结果里的时间，按内容写进时间线时的真实时间算，和情景里拨的时间对不上');

			// 按摘要写的时间范围和关键词查：找到张三的消息和沈安自己发出的消息。时间范围按真实时间写，从请求里的摘要取。
			const range = (request: IModelRequest) => {
				const match = /时间范围为 (\S+ \S+) 到 (\S+ \S+)（([^，）]+)/.exec(JSON.stringify(request.input));
				if (!match) throw new Error('请求里没有摘要的时间范围');
				return { start_time: match[1], end_time: match[2], timezone: match[3] };
			};
			c.reply(host,
				[call('more_tools', { action: 'describe', tool_name: 'search_history' })],
				request => [
					call('search_history', { keywords: ['8080'], ...range(request) }),
					call('search_history', { images_only: true }),
					call('search_history', { conversation: team.groupId, sender: c.human.memberId }),
				],
				[
					call('search_history', { keywords: ['E1042'], max_chars_per_entry: 20 }),
					// 这条还能看到原文，查不到；关键词填错了也查不到。
					call('search_history', { keywords: ['周五上线'] }),
					call('search_history', { keywords: ['8081'] }),
				],
				[send(c.human, `端口是 8080，部署脚本是 scripts/deploy.sh；架构图在 ${diagram}`)],
			);
			c.say(direct(host), '之前说的部署端口是多少？架构图也再找一下');
			await c.settle();
		},
	},

	plan: {
		title: '计划',
		description: '成员用 update_plan 列出计划、随进度更新；压缩处理掉了最近一份计划原文、计划还没做完时，在时间线末尾放回计划说明，原样写着计划；放回的计划说明不唤醒成员，下次请求在末尾看到。',
		models: [{ model: 'fake', vision: true, contextWindow: 100_000 }],
		async run(c) {
			const host = c.ai('沈安', AI);
			const template = c.file('纪要模板.md', Array.from({ length: 250 }, (_, index) => `## 议题 ${index + 1}\n- 讨论要点：\n- 结论：\n- 待办：负责人、截止时间\n`).join('\n'));
			const plan = (...statuses: readonly string[]) => call('update_plan', {
				items: ['订周五下午的会议室', '通知参会的人', '按模板写会议纪要'].map((text, index) => ({ text, status: statuses[index] })),
			});
			c.reply(host, [plan('in_progress', 'pending', 'pending'), send(c.human, '好的，先订会议室，订好后通知大家，再按模板写纪要')]);
			c.say(direct(host), '订周五下午的会议室，通知参会的人，再按模板写会议纪要');
			await c.settle();
			c.reply(host, [plan('completed', 'completed', 'in_progress'), send(c.human, '会议室订好了（302），也通知了大家，接下来写纪要')]);
			c.say(direct(host), '会议室订好了吗');
			await c.settle();
			// 读一份长的模板：它和后面的内容是最近的内容。输入到了七成，运行结束时压缩，摘要代替前两轮（两条消息和两次调用，包括两次更新计划）。
			c.reply(host, [call('shell', { command: `cat "${template.replaceAll('\\', '/')}"` })], [send(c.human, '模板看过了，按议题、结论、待办写')], withUsage([], 75_000));
			c.proposal(host, request => proposal([{
				op: 'summarize', ids: numbers(request).slice(0, 4),
				summary: '张三让我订周五下午的会议室、通知参会的人、按模板写会议纪要；会议室已订好（302），已通知大家。',
				keywords: ['302'],
			}]));
			c.say(direct(host), `会议纪要按 ${template} 这个模板写，先看一下`);
			await c.settle();
			c.note('压缩时最近一份计划原文被摘要代替、计划还没做完：在时间线末尾放回了计划说明，没有唤醒沈安');
			c.reply(host, [plan('completed', 'completed', 'completed'), send(c.human, '纪要写好了')]);
			c.say(direct(host), '纪要写得怎么样了');
			await c.settle();
		},
	},

	omission: {
		title: '没看过的内容太多',
		description: '成员暂停时群里攒了很多消息，超过上下文的四成五：从最早的不唤醒的开始拿掉，原位置放一条说明。',
		models: [{ model: 'fake', vision: true, contextWindow: 100_000 }],
		async run(c) {
			const host = c.ai('沈安', AI);
			const team = c.runtime.groups.create(c.human.memberId, '讨论组', [host.memberId]);
			c.note('张三建了群聊「讨论组」，拉进沈安');
			await c.settle();
			c.runtime.runs.pause(host.memberId);
			c.note('张三暂停了沈安');
			c.say(direct(host), '回来后先看这条');
			for (let index = 1; index <= 40; index++) c.say(group(team), `第 ${index} 条：${'讨论'.repeat(1000)}`);
			c.reply(host, [send(c.human, '看到了')]);
			c.runtime.runs.resume(host.memberId);
			c.note('张三恢复了沈安');
			await c.settle();
		},
	},

	rewrite: {
		title: '可能改写已有内容的操作',
		description: '用户改记忆、改成员设定、换模型、加技能、加 MCP 服务器和启用它、私聊过的成员被删除：每一步之后的请求，哪些内容变了。',
		models: [{ model: 'a', vision: true, contextWindow: 200_000 }, { model: 'b', vision: true, contextWindow: 200_000 }],
		async run(c) {
			const host = c.ai('沈安', AI);
			const peer = c.ai('陈屿', AI);
			c.reply(host, [think('请陈屿准备数据'), send(peer, '张三要周报的数据，周五前给我')], [think('陈屿答应了'), send(c.human, '陈屿周五前给数据')]);
			c.reply(peer, [send(host, '收到，周五前给')]);
			c.say(direct(host), '让陈屿准备周报的数据');
			await c.settle();
			const step = async (what: string, change: () => unknown) => {
				await change();
				c.note(what);
				c.reply(host, [send(c.human, '好的')]);
				c.say(direct(host), '继续');
				await c.settle();
			};
			await step('张三改了沈安的记忆', () => c.runtime.memories.write(host.memberId, '张三负责前端，陈屿负责数据。', true));
			await step('张三改了沈安的成员设定', () => c.runtime.memberFolders.update(host.memberId, { prompt: '你是项目助理，回复尽量简短。' }));
			await step('沈安换成模型 b', () => c.runtime.memberFolders.setModel(host.memberId, { provider: 'test', name: 'b' }, null));
			let definition: IMemberDefinition = { ...AI, model: { provider: 'test', name: 'b' } };
			const enable = (change: IMemberDefinition) => c.runtime.memberFolders.update(host.memberId, { definition: definition = { ...definition, ...change } });
			await step('加了技能 weekly-report，沈安没启用', () => c.runtime.skills.create('weekly-report', '写周报的格式和步骤', '# 周报\n\n按本周完成、下周计划、风险三部分写。'));
			await step('沈安启用了技能 weekly-report', () => enable({ skills: ['weekly-report'] }));
			await step('加了 MCP 服务器 demo，沈安没启用', async () => {
				c.runtime.mcp.update('demo', MCP_SERVER);
				await c.until(() => c.runtime.mcp.snapshot().servers.every(server => server.status !== 'connecting'), 'MCP 服务器连上');
			});
			await step('沈安启用了 MCP 服务器 demo', () => enable({ tools: [...c.runtime.tools.defaultEnabledNames(), 'mcp:demo'] }));
			await step('陈屿被删除了', () => c.runtime.memberFolders.remove(peer.memberId));
		},
	},

	time: {
		title: '时间：间隔',
		description: '时间写在收到内容的编号后面：离上下文里最晚的时间不到 10 分钟不带；10 分钟以上带到分钟的；连着调用工具时过了很久也不带；跨过午夜带完整的。',
		async run(c) {
			const host = c.ai('沈安', AI);
			c.reply(host, [send(c.human, '早')]);
			c.say(direct(host), '早，今天先整理需求');
			await c.settle();
			c.wait(5);
			c.reply(host, [send(c.human, '好')]);
			c.say(direct(host), '需求文档在共享盘');
			await c.settle();
			c.wait(15);
			c.reply(host,
				() => {
					c.wait(12);
					return [think('先记下来'), call('manage_memory', { action: 'add', text: '需求文档在共享盘' })];
				},
				[send(c.human, '记下了')],
			);
			c.say(direct(host), '记一下需求文档的位置');
			await c.settle();
			c.wait(16 * 60);
			c.reply(host, [send(c.human, '这么晚还在忙？')]);
			c.say(direct(host), '还在吗');
			await c.settle();
		},
	},

	'time-kinds': {
		title: '时间：各种收到的内容',
		description: '私聊、用户直接说话（带图片）、群聊变动、群聊消息、后台任务结果、定时、终端交还的通知、外部事件按同一条规则带时间，写在内容编号后面；变动说明、模型的输出和工具结果不带。',
		backgroundAfterMs: 500,
		async run(c) {
			const host = c.ai('沈安', { ...AI, tools: [...c.runtime.tools.defaultEnabledNames(), 'terminal'] });
			const image = c.file('排期表.png', png(64, 48, [40, 160, 90]));

			// 9:00 私聊：新成员收到的第一条，带完整的时间。
			c.reply(host, [send(c.human, '早')]);
			c.say(direct(host), '早，今天的安排发你了');
			await c.settle();
			// 9:03 用户直接说话，带图片：离最晚的时间不到 10 分钟，不带。
			c.wait(3);
			c.reply(host, [output('收到排期表')]);
			c.tell(host, '这是排期表', [image]);
			await c.settle();

			// 9:15 被拉进群：群聊变动带到分钟的时间；紧接着群里的消息不带。两条都不唤醒，下次请求一并看到。
			c.wait(12);
			const team = c.runtime.groups.create(c.human.memberId, '项目组', [host.memberId]);
			c.note('张三建了群聊「项目组」，拉进沈安');
			c.say(group(team), '大家看一下排期');
			await c.settle();
			// 9:30 群里点名：带到分钟的时间。
			c.wait(15);
			c.reply(host, [send(team, '排期没问题')]);
			c.say(group(team), '沈安确认一下排期', { mentions: [host.memberId] });
			await c.settle();

			// 9:45 用户直接说话带图片：带到分钟的时间，图片跟在文字后面。
			c.wait(15);
			c.reply(host, [output('还是那张排期表')]);
			c.tell(host, '再看一眼这张图', [image]);
			await c.settle();

			// 9:50 跑构建：命令转到后台，工具结果不带时间；过了 20 分钟构建完成，任务结果带到分钟的时间。
			c.wait(5);
			c.reply(host,
				[call('shell', { command: 'node -e "setTimeout(() => console.log(\'构建完成\'), 1500)"' })],
				[output('构建转到后台了，完成后再看')],
				[send(c.human, '构建完成了')],
			);
			c.tell(host, '跑一下构建');
			await c.until(() => !c.runtime.runs.isRunning(host.memberId) && c.runtime.tasks.list(host.memberId).some(task => task.status === 'running'), '命令转到后台');
			c.wait(20);
			await c.settle();

			// 10:12 建定时：不到 10 分钟，不带；过了 15 分钟定时到了，带到分钟的时间。
			c.wait(2);
			c.reply(host,
				[call('more_tools', { action: 'call', tool_name: 'manage_reminders', arguments: { action: 'add', delay_seconds: 3, note: '提醒张三开会' } })],
				[output('定好了')],
				[send(c.human, '该开会了')],
			);
			c.tell(host, '3 秒后提醒我开会');
			await c.settle();
			c.wait(15);
			await c.until(() => c.runtime.timeline.all(host.memberId).some(item => item.kind === 'reminder'), '定时到了');
			c.note('定时按真实时间计时：建定时的结果和提醒里写的时刻是生成样本时的真实时间，和情景里拨的时间对不上');
			await c.settle();

			// 10:29 开终端；张三接管，过了 12 分钟交还。沈安没在等终端，交还的通知不唤醒，收到时带到分钟的时间。
			c.wait(2);
			c.reply(host, [call('terminal', { input: 'echo 准备好了\n' })], [output('终端开好了')]);
			c.tell(host, '开个终端');
			await c.settle();
			const terminal = c.runtime.terminals.list().find(item => item.createdBy === host.memberId);
			if (!terminal) throw new Error('沈安没有建终端');
			c.runtime.terminals.takeover(terminal.terminalId);
			c.note('张三接管了终端');
			c.wait(12);
			c.runtime.terminals.release(terminal.terminalId);
			c.note('张三交还了终端：沈安没在等终端，通知不唤醒，下次请求一并看到');
			await c.settle();

			// 10:55 外部事件：带到分钟的时间。和前面交还终端的通知在同一次请求里看到，各带各收到时的时间。
			c.wait(14);
			mkdirSync(c.runtime.external.routes.directory, { recursive: true });
			writeFileSync(join(c.runtime.external.routes.directory, 'to-host.js'), `export const sources = ['github'];\nexport default () => ({ to: '${host.memberId}' });\n`);
			c.reply(host, [call('terminal', { terminal_id: terminal.terminalId, close: true })], [output('终端关了；PR 12 有新评论，等张三安排')]);
			c.runtime.external.event('github', { content: '新评论：部署脚本里的端口写错了', meta: { repo: 'human', pull_request: '12', author: 'lisi' } });
			c.note('GitHub 推来一条事件，路由投给沈安');
			await c.settle();

			// 11:10 改了设置：收到的消息带到分钟的时间，请求前追加的变动说明不带。
			c.wait(15);
			c.runtime.memberFolders.update(host.memberId, { definition: AI });
			c.note('张三给沈安关掉了终端工具');
			c.reply(host, [send(c.human, '好')]);
			c.say(direct(host), '终端用完了，先关掉');
			await c.settle();

			// 第二天 10:10：日期变了，带完整的时间。
			c.wait(23 * 60);
			c.reply(host, [send(c.human, '早')]);
			c.say(direct(host), '早，接着昨天的排期');
			await c.settle();
		},
	},

	'time-full': {
		title: '时间：什么时候带完整的',
		description: '新成员的第一条；压缩把带完整时间的内容摘要掉以后，下一条离得再近也带完整的；换了时区、换回来；跨天；夏令时开始那天 UTC 偏移变了（本机时区有夏令时时才看得到，如 America/Chicago）。',
		models: [{ model: 'fake', vision: true, contextWindow: 100_000 }],
		async run(c) {
			const host = c.ai('沈安', AI);
			const template = c.file('纪要模板.md', Array.from({ length: 250 }, (_, index) => `## 议题 ${index + 1}\n- 讨论要点：\n- 结论：\n- 待办：负责人、截止时间\n`).join('\n'));
			// 9:00 新成员的第一条：完整的时间。
			c.reply(host, [send(c.human, '好的，我去订周五下午两点到四点的会议室，十个人，带投影仪和白板，订好后告诉你')]);
			c.say(direct(host), '订周五下午两点到四点的会议室，十个人，要有投影仪和白板，订好后发我确认');
			await c.settle();
			// 9:12 带到分钟的时间。读一份长的模板：它和后面的内容是最近的内容，压缩时只能处理更早的订会议室。
			c.wait(12);
			c.reply(host, [call('shell', { command: `cat "${template.replaceAll('\\', '/')}"` })], [send(c.human, '模板看过了，按议题、结论、待办记')]);
			c.say(direct(host), `会议纪要按 ${template} 这个模板写，先看一下`);
			await c.settle();
			// 9:14 输入到了七成，运行结束时压缩：带完整时间的第一条被摘要掉。
			c.wait(2);
			c.reply(host, withUsage([send(c.human, '订好了，302 会议室，投影仪和白板都有')], 75_000));
			c.proposal(host, request => {
				const [first, second] = numbers(request);
				return proposal([{ op: 'summarize', ids: [first, second], summary: '张三让我订周五下午两点到四点的会议室（十个人，要投影仪和白板），我答应了' }]);
			});
			c.say(direct(host), '订好了吗');
			await c.settle();
			c.note('摘要开头的时间范围按内容写进时间线时的真实时间算，和情景里拨的时间对不上；换了时区后按新时区重写');
			// 9:16 离最晚的时间（9:12）才 4 分钟，但上下文里没有完整的时间了，带完整的。
			c.wait(2);
			c.reply(host, [send(c.human, '下周一的也订好了')]);
			c.say(direct(host), '再订下周一的');
			await c.settle();

			// 换了时区：时刻只隔 3 分钟，也带完整的，按新时区写；换回来也一样。
			const original = systemTimeZone();
			try {
				process.env.TZ = 'Asia/Shanghai';
				c.note('运行时所在机器的时区换成了 Asia/Shanghai');
				c.wait(3);
				c.reply(host, [send(c.human, '好')]);
				c.say(direct(host), '我到上海了，后面按上海时间');
				await c.settle();
			} finally {
				process.env.TZ = original;
			}
			c.note(`时区换回了 ${original}`);
			c.wait(3);
			c.reply(host, [send(c.human, '好')]);
			c.say(direct(host), '又回来了');
			await c.settle();

			// 跨天，到夏令时开始那天的 1:30：日期变了，带完整的。
			c.waitUntil(2027, 3, 14, 1, 30);
			c.reply(host, [send(c.human, '收到')]);
			c.say(direct(host), '下周的会改到周一');
			await c.settle();
			// 一小时后的 3:30：同一天，夏令时开始，UTC 偏移变了，带完整的。
			c.waitUntil(2027, 3, 14, 3, 30);
			c.reply(host, [send(c.human, '收到')]);
			c.say(direct(host), '记得调一下闹钟');
			await c.settle();
		},
	},

	'time-awareness': {
		title: '时间感知开关',
		description: '关掉后收到的内容不带时间，下次请求前追加变动说明；运行规则里时间那一句跟着快照，换了模型才去掉、加回来；关着时跨了天，打开后第一条带完整的时间。',
		models: [{ model: 'a', vision: true, contextWindow: 200_000 }, { model: 'b', vision: true, contextWindow: 200_000 }],
		async run(c) {
			const host = c.ai('沈安', AI);
			let definition: IMemberDefinition = AI;
			const change = (what: string, next: IMemberDefinition) => {
				c.runtime.memberFolders.update(host.memberId, { definition: definition = { ...definition, ...next } });
				c.note(what);
			};
			const step = async (text: string) => {
				c.reply(host, [send(c.human, '好')]);
				c.say(direct(host), text);
				await c.settle();
			};
			// 9:00 开着：第一条带完整的时间，规则里有时间那一句。
			await step('早，今天先整理需求');
			// 9:15 关掉后收到的不带时间；请求前追加说明，规则不变，开头还能命中缓存。
			change('张三关掉了沈安的时间感知', { timeAwareness: false });
			c.wait(15);
			await step('需求文档在共享盘');
			// 9:30 换了模型，快照重新生成：规则里没有时间那一句了。
			change('沈安换成模型 b', { model: { provider: 'test', name: 'b' } });
			c.wait(15);
			await step('先列一下要点');
			// 第二天 9:30 打开：日期变了，收到的带完整的时间；请求前追加说明，规则要等快照重新生成才加回来。
			c.wait(24 * 60);
			change('张三打开了沈安的时间感知', { timeAwareness: undefined });
			await step('早，接着昨天的需求');
			// 9:45 换回模型 a，快照重新生成：规则里又有时间那一句了；离上一条 15 分钟，带到分钟的。
			change('沈安换回模型 a', { model: undefined });
			c.wait(15);
			await step('要点列好了吗');
		},
	},
};
