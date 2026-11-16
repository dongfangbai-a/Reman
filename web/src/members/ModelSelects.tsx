import { useModels } from '../api/directory.ts';
import type { IModelList, IModelRef } from '../api/types.ts';
import { Select } from '../ui/Select.tsx';
import { modelKey, REASONING_LABELS } from './aiForm.ts';

/** 模型和思考强度两个下拉框。model 是「供应商\n模型」，空表示默认模型；reasoning 空表示不指定。成员页和对话页的模型标签共用。 */
export function ModelSelects({ model, reasoning, onModel, onReasoning, disabled }: {
	model: string;
	reasoning: string;
	onModel: (model: string) => void;
	onReasoning: (reasoning: string) => void;
	disabled?: boolean;
}) {
	const models = useModels();
	const options = (models.data?.providers ?? []).flatMap(provider => provider.models.map(entry => ({
		key: modelKey(provider.id, entry.model), label: `${provider.name} / ${entry.displayName || entry.model}`,
	})));
	const fallback = models.data?.defaultModel;
	const defaultLabel = fallback ? options.find(option => option.key === modelKey(fallback.provider, fallback.model))?.label ?? `${fallback.provider} / ${fallback.model}` : '未设置';
	const selected = options.find(option => option.key === model);
	return (
		<>
			<div className="flex flex-wrap gap-2">
				<Select
					label="模型"
					value={model}
					onChange={onModel}
					disabled={disabled}
					className="min-w-48 flex-1"
					options={[
						{ value: '', label: `默认模型（${defaultLabel}）` },
						...options.map(option => ({ value: option.key, label: option.label })),
						...model && !selected ? [{ value: model, label: `${model.replace('\n', ' / ')}（已不可用）` }] : [],
					]}
				/>
				<Select
					label="思考强度"
					title="思考强度"
					value={reasoning}
					onChange={onReasoning}
					disabled={disabled}
					className="w-32 shrink-0"
					options={[
						{ value: '', label: '思考：不指定' },
						...Object.entries(REASONING_LABELS).map(([effort, label]) => ({ value: effort, label: `思考：${label}` })),
						...reasoning && !REASONING_LABELS[reasoning] ? [{ value: reasoning, label: `思考：${reasoning}` }] : [],
					]}
				/>
			</div>
			{models.data?.error && <div className="mt-1 text-xs text-danger">模型配置有误：{models.data.error}</div>}
		</>
	);
}

/** 成员实际用的模型的显示名：没指定时是默认模型；模型已不可用或没有默认模型时 unavailable。 */
export function modelDisplay(list: IModelList, ref: IModelRef | null): { readonly name: string; readonly unavailable: boolean } {
	const target = ref ?? list.defaultModel;
	if (!target) return { name: '未设置模型', unavailable: true };
	const entry = list.providers.find(provider => provider.id === target.provider)?.models.find(item => item.model === target.model);
	return entry ? { name: entry.displayName || entry.model, unavailable: false } : { name: target.model, unavailable: true };
}
