import clsx from 'clsx';
import { Activity, LoaderCircle } from 'lucide-react';
import { create } from 'zustand';
import { api } from '../api/client.ts';
import type { IModelRef, PingResult } from '../api/types.ts';
import { errorMessage } from '../lib/errors.ts';
import { IconButton } from '../ui/Button.tsx';

type TestState = { readonly running: true } | { readonly running: false; readonly result: PingResult };

/** 模型的测试结果，按「供应商\n模型」记，只在页面内存里：刷新后没有，不写进 models.json。 */
const useModelTests = create<Record<string, TestState>>(() => ({}));

/** 模型在页面里的标识：供应商和模型名，用换行隔开。 */
export function modelKey(ref: IModelRef): string {
	return `${ref.provider}\n${ref.model}`;
}

/** 编辑了供应商（地址、key）后，它下面模型以前的结果不算数了。 */
export function forgetModelTests(providerId: string): void {
	useModelTests.setState(state => Object.fromEntries(Object.entries(state).filter(([key]) => !key.startsWith(`${providerId}\n`))), true);
}

async function runTest(ref: IModelRef): Promise<void> {
	const key = modelKey(ref);
	useModelTests.setState({ [key]: { running: true } });
	let result: PingResult;
	try {
		result = await api<PingResult>('POST', '/v1/models/test', ref);
	} catch (error) {
		result = { ok: false, error: errorMessage(error) };
	}
	useModelTests.setState({ [key]: { running: false, result } });
}

/** 这个模型最近一次测试的结果；没测过、正在测时是 undefined。 */
export function useModelTestResult(ref: IModelRef): PingResult | undefined {
	return useModelTests(state => {
		const test = state[modelKey(ref)];
		return test && !test.running ? test.result : undefined;
	});
}

/** 模型行上的「测试」：测的时候转圈，结果出来前不能再点。 */
export function ModelTestButton({ model }: { model: IModelRef }) {
	const running = useModelTests(state => state[modelKey(model)]?.running ?? false);
	return (
		<IconButton label="测试" disabled={running} onClick={() => void runTest(model)}>
			{running ? <LoaderCircle size={14} className="animate-spin" /> : <Activity size={14} />}
		</IconButton>
	);
}

/** 写在模型行里的结果：可用和用时，悬停看回复的文字、用时和用量；回复为空时橙色；不能用时红色，原因写在行下面。 */
export function ModelTestStatus({ result, className }: { result: PingResult; className?: string }) {
	if (!result.ok) return <span className={clsx('shrink-0 text-xs text-danger', className)}>不可用</span>;
	const times = [result.firstOutputMs !== null && `首次输出 ${seconds(result.firstOutputMs)}`, `全部 ${seconds(result.totalMs)}`].filter(Boolean).join(' · ');
	const detail = [
		result.reply ? `回复：${result.reply}` : '请求成功，但回复中没有文本',
		`用时：${times}`,
		result.usage && `输入 ${result.usage.inputTokens} token · 输出 ${result.usage.outputTokens} token`,
	].filter(Boolean).join('\n');
	return (
		<span className={clsx('shrink-0 text-xs', result.reply ? 'text-success' : 'text-warning', className)} title={detail}>
			{result.reply ? `可用 · ${seconds(result.totalMs)}` : '可用，但回复为空'}
		</span>
	);
}

/** 1.3 秒；10 秒以上不带小数。 */
function seconds(ms: number): string {
	return `${ms < 10_000 ? (ms / 1000).toFixed(1) : Math.round(ms / 1000)} 秒`;
}
