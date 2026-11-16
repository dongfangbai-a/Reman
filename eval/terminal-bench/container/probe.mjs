// 跑在任务容器里的小工具：用运行时的 HTTP 接口做适配器要做的那些事，省得每次都在外面拼长命令。
// 用法：node probe.mjs <action> [参数…]，输出一行 JSON。
//   state                    运行时起来了吗（/v1/state）
//   init <provider> <model> <toolsJson> <workdir>   建一个 AI 成员，输出它的编号
//   send <aiId> <textFile>   以「用户刚才直接对它说的话」把文件里的文字送进时间线（kind=user_input）
//   poll <aiId>（调试用）     成员状态、还在跑的后台任务数、事件流版本号
//   wait <aiId> <quietMs> <timeoutMs>   等成员真的停下来（运行结束、没有待处理的内容、没有后台任务，且静默够久）
//   who                      列出还没删除的 AI 成员（换容器后接着用同一个）
//   workdir <aiId> <path>    改成员的工作目录
//   usage                    模型用量合计
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dataDir = process.env.REMAN_DATA_DIR ?? '/opt/reman/data';
const base = `http://127.0.0.1:${process.env.REMAN_PORT ?? '6100'}`;
const token = readFileSync(join(dataDir, 'access-token'), 'utf8').trim();

async function call(method, path, body) {
	const response = await fetch(base + path, {
		method,
		headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body),
		...(body === undefined ? {} : {}),
	});
	const text = await response.text();
	if (!response.ok) throw new Error(`${method} ${path} ${response.status} ${text.slice(0, 300)}`);
	return text ? JSON.parse(text) : {};
}

const out = value => process.stdout.write(JSON.stringify(value) + '\n');

const [action, ...args] = process.argv.slice(2);
try {
	if (action === 'state') {
		const state = await call('GET', '/v1/state');
		out({ ok: true, revision: state.revision });
	} else if (action === 'init') {
		const [provider, model, toolsJson, workingDirectory, reasoning] = args;
		const definition = {
			model: { provider, name: model },
			// 思考强度显式给定，不依赖运行时的默认值。
			...(reasoning ? { reasoning } : {}),
			tools: JSON.parse(toolsJson),
			directMessage: 'all',
			timeAwareness: false,
		};
		// 无人值守：能设审批方式的工具都设成 allow（不问就执行）。有些工具本身就无需审批，写了会报错。
		const wanted = JSON.parse(toolsJson);
		const info = (await call('GET', '/v1/tools')).tools;
		const toolPolicies = Object.fromEntries(
			info.filter(tool => wanted.includes(tool.name) && tool.policies.length > 0).map(tool => [tool.name, 'allow']),
		);
		const ai = (await call('POST', '/v1/members', {
			type: 'ai', name: '试次', definition, workingDirectory, toolPolicies,
		})).member;
		// 反查一遍实际装上的工具：评测环境里不该出现计划外的工具（浏览器、发消息、群聊这些）。
		// 以后改新成员的默认工具也不会悄悄漏进来。
		const actual = [...(await call('GET', `/v1/members/${ai.memberId}`)).member.tools].sort();
		const expected = [...new Set(wanted)].sort();
		const extra = actual.filter(name => !expected.includes(name));
		const missing = expected.filter(name => !actual.includes(name));
		if (extra.length > 0 || missing.length > 0) {
			throw new Error(`成员的工具和预期不一致：多了 [${extra.join(', ')}]，少了 [${missing.join(', ')}]`);
		}
		out({ ok: true, aiId: ai.memberId, tools: actual });
	} else if (action === 'send') {
		const [aiId, textFile] = args;
		const text = readFileSync(textFile, 'utf8');
		// 用户直接对成员说话：进成员时间线、唤醒它，不属于任何对话（服务端注释也是这么写的）。
		// 不能用 POST /v1/messages —— 那是成员私聊，成员会看到「来源说明：来自成员 X」，行为完全不同。
		const { item } = await call('POST', `/v1/members/${aiId}/timeline`, { text });
		out({ ok: true, timelineItemId: item?.itemId ?? null, kind: item?.kind ?? null });
	} else if (action === 'wait') {
		const [aiId, quietMs, timeoutMs] = args;
		if (!Number.isSafeInteger(Number(quietMs)) || !Number.isSafeInteger(Number(timeoutMs))) {
			throw new Error('wait 要两个整数：静默窗口毫秒、最长等多少毫秒');
		}
		// 长轮询：服务端等到真的停下来才返回；比在外面轮询状态准，也不会把「刚做完又要开始」当成做完。
		const work = await call('GET', `/v1/members/${aiId}/work/wait?quietMs=${Number(quietMs)}&timeoutMs=${Number(timeoutMs)}`);
		out({ ok: true, ...work.work });
	} else if (action === 'poll') {
		const [aiId] = args;
		const states = (await call('GET', '/v1/member-states')).states;
		const state = states.find(item => item.memberId === aiId) ?? null;
		const tasks = (await call('GET', `/v1/members/${aiId}/tasks`)).tasks;
		const revision = (await call('GET', '/v1/state')).revision;
		const running = tasks.filter(task => task.status === 'running');
		out({
			ok: true, revision,
			status: state?.status ?? 'gone',
			error: state?.error ?? null,
			activity: state?.activity ?? null,
			runningTasks: running.map(task => ({ taskId: task.taskId, toolName: task.toolName, startedAt: task.startedAt })),
			lastTask: tasks[0] ? { status: tasks[0].status, toolName: tasks[0].toolName } : null,
		});
	} else if (action === 'who') {
		const members = (await call('GET', '/v1/members')).members;
		const ais = members.filter(member => member.type === 'ai' && !member.deleted);
		out({ ok: true, ais: ais.map(member => ({ memberId: member.memberId, name: member.name, workingDirectory: member.workingDirectory ?? null })) });
	} else if (action === 'workdir') {
		const [aiId, dir] = args;
		const response = await call('PUT', `/v1/members/${aiId}/working-directory`, { workingDirectory: dir });
		out({ ok: true, workingDirectory: response.member?.workingDirectory ?? null });
	} else if (action === 'usage') {
		const usage = (await call('GET', '/v1/usage')).usage;
		out({ ok: true, usage });
	} else if (action === 'approve') {
		// 无人值守：把待审批的调用全部放行（scope=run，只对本次运行有效）。
		// cc / dsh 都没有审批环节，reman 不这么做就不对等；有些动作（改 .git 配置等）即使在 allow 策略下也要审批。
		const scope = args[0] ?? 'once';
		const pending = (await call('GET', '/v1/approvals?pending=1')).approvals ?? [];
		const approved = [];
		for (const approval of pending) {
			try {
				await call('POST', `/v1/approvals/${approval.approvalId}/approve`, { scope });
				approved.push(approval.approvalId);
			} catch (error) {
				// “修改运行时数据的调用只能允许本次”：某些动作只接受 once，这里退回 once 再试一次。
				if (scope !== 'once') {
					await call('POST', `/v1/approvals/${approval.approvalId}/approve`, { scope: 'once' });
					approved.push(approval.approvalId);
				} else {
					throw error;
				}
			}
		}
		out({ ok: true, approved });
	} else {
		throw new Error(`不认识的 action：${action}`);
	}
} catch (error) {
	out({ ok: false, error: String(error && error.message ? error.message : error) });
	process.exitCode = 1;
}
