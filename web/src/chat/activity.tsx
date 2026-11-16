import { useEffect, useState, type ReactNode } from 'react';
import { useToolCatalog } from '../api/directory.ts';
import type { IMemberState } from '../api/types.ts';
import { firstLine } from '../lib/format.ts';
import { isRecord, unwrapCall } from '../timeline/ToolCard.tsx';

/** 一个成员写的内容换了以后至少停留这么久，免得一闪而过。 */
const MIN_SHOW_MS = 300;
/** 很快就执行完的内置工具，不写。 */
const QUICK_TOOLS = new Set(['send_message', 'write_file', 'edit_file', 'view_image', 'read_skill', 'search_history', 'manage_group', 'manage_background_tasks', 'manage_reminders', 'manage_memory', 'update_plan']);
/** 参数里可能是整份文件、一大段消息或脚本，模型要写一阵的工具：写调用时这样写。其他工具的参数短，不写。 */
const WRITING_CALLS = new Map([['write_file', '正在写入文件'], ['edit_file', '正在修改文件'], ['send_message', '正在编写消息'], ['run_tool_script', '正在编写工具脚本']]);

/** 一个成员在做什么：动作，加上命令、路径之类的细节；同时执行几个工具时 count 是要写的工具数。 */
export interface IStep {
	readonly verb: string;
	readonly detail?: string;
	readonly count?: number;
	readonly waiting?: boolean;
}

/** 运行中的一个成员。 */
export interface IRunningMember {
	readonly memberId: string;
	readonly state: IMemberState;
}

export const RUNNING: IStep = { verb: '正在运行' };
export const OPTIMIZING: IStep = { verb: '正在整理上下文' };
const WAITING: IStep = { verb: '等待你审批', waiting: true };

/** 写着的内容，和开始写的时间。 */
interface IDisplayed {
	readonly step: IStep;
	readonly since: number;
}

export function isRunning(state: IMemberState | undefined): state is IMemberState {
	return state?.status === 'running' || state?.status === 'waiting_approval';
}

/**
 * 每个运行中的成员现在写什么（运行状态行、时间线最后一段过程共用）。很快的工具不写，保持前面的内容；
 * 换了以后至少停留 MIN_SHOW_MS，期间又变了到时直接换成最新的。等审批立即换。
 */
export function useSteps(members: readonly IRunningMember[]): Map<string, IStep> {
	const [displayed, setDisplayed] = useState<ReadonlyMap<string, IDisplayed>>(() => new Map());
	const [tick, setTick] = useState(0);
	const catalog = useToolCatalog();
	// 自定义工具的短说明，如「搜索网页」，执行时写「正在搜索网页」。
	const customLabels = new Map((catalog.data ?? []).filter(tool => tool.customTool !== null).flatMap(tool => tool.groupTools).map(tool => [tool.name, tool.label]));
	const targets = new Map(members.map(member => [member.memberId, targetStep(member.state, customLabels)]));
	const targetsKey = JSON.stringify([...targets]);
	useEffect(() => {
		const now = Date.now();
		const next = new Map<string, IDisplayed>();
		let changed = false;
		let wait = Infinity;
		for (const [memberId, target] of targets) {
			const current = displayed.get(memberId);
			const step = target ?? current?.step ?? RUNNING;
			const remaining = current && !step.waiting ? current.since + MIN_SHOW_MS - now : 0;
			if (current && (sameStep(current.step, step) || remaining > 0)) {
				next.set(memberId, current);
				if (!sameStep(current.step, step)) wait = Math.min(wait, remaining);
				continue;
			}
			next.set(memberId, { step, since: now });
			changed = true;
		}
		if (changed || next.size !== displayed.size) setDisplayed(next);
		if (wait === Infinity) return;
		const timer = window.setTimeout(() => setTick(value => value + 1), wait);
		return () => window.clearTimeout(timer);
	}, [targetsKey, displayed, tick]);
	const steps = new Map<string, IStep>();
	for (const [memberId, target] of targets) {
		steps.set(memberId, target?.waiting ? target : displayed.get(memberId)?.step ?? target ?? RUNNING);
	}
	return steps;
}

/** 一个成员现在写什么；没在运行时是 undefined。 */
export function useStep(memberId: string, state: IMemberState | undefined): IStep | undefined {
	return useSteps(isRunning(state) ? [{ memberId, state }] : []).get(memberId);
}

function sameStep(a: IStep, b: IStep): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * 成员此刻在做的事；模型在写参数短的工具调用、只有很快的工具在执行（或这批工具刚执行完）时是 undefined，
 * 保持前面的内容。
 */
function targetStep(state: IMemberState, customLabels: ReadonlyMap<string, string | null>): IStep | undefined {
	if (state.status === 'waiting_approval') return WAITING;
	const activity = state.activity;
	if (!activity) return RUNNING;
	if (activity.phase === 'optimizing') return OPTIMIZING;
	if (activity.phase === 'model') {
		const { output } = activity;
		if (output?.type === 'text') return { verb: '正在输出' };
		if (output?.type !== 'call') return { verb: '正在思考' };
		const verb = WRITING_CALLS.get(output.name);
		return verb === undefined ? undefined : { verb };
	}
	const steps = activity.calls.map(call => describeCall(call.name, call.args, customLabels)).filter(step => step !== undefined);
	const [first] = steps;
	return first && { ...first, count: steps.length };
}

export function StepText({ step }: { step: IStep }): ReactNode {
	return (
		<>
			{step.verb}
			{step.detail && <> <code className="font-mono text-[12px] leading-none">{step.detail}</code></>}
			{step.count !== undefined && step.count > 1 && ` 等 ${step.count} 个工具`}
		</>
	);
}

/** 正在执行的工具写成一句话；很快的内置工具不写，返回 undefined。自定义工具写「正在」加它的短说明。 */
function describeCall(rawName: string, rawArgs: unknown, customLabels: ReadonlyMap<string, string | null>): IStep | undefined {
	const { name, args, describe } = unwrapCall(rawName, rawArgs);
	if (describe || QUICK_TOOLS.has(name)) return undefined;
	const record = isRecord(args) ? args : {};
	const text = (key: string) => typeof record[key] === 'string' ? firstLine(record[key]) : undefined;
	switch (name) {
		case 'shell':
			return { verb: '正在执行', detail: text('command') };
		case 'run_tool_script':
			return { verb: '正在用脚本调用工具' };
		case 'read_pdf':
			return { verb: '正在读取 PDF', detail: text('path') };
		case 'terminal':
			return { verb: '正在使用终端' };
		case 'browser':
			return record['action'] === 'open' ? { verb: '正在打开', detail: text('url') } : { verb: '正在使用浏览器' };
		default: {
			const label = customLabels.get(name);
			return label ? { verb: `正在${label}` } : { verb: '正在调用', detail: name };
		}
	}
}

