import * as Popover from '@radix-ui/react-popover';
import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ChevronDown } from 'lucide-react';
import { useState } from 'react';
import { api } from '../api/client.ts';
import { useModels } from '../api/directory.ts';
import { queryKeys } from '../api/keys.ts';
import type { IMember } from '../api/types.ts';
import { errorMessage } from '../lib/errors.ts';
import { modelKey, REASONING_LABELS } from '../members/aiForm.ts';
import { modelDisplay, ModelSelects } from '../members/ModelSelects.tsx';

/** 私聊顶部的模型标签：写 AI 成员实际用的模型和思考强度，点开直接改，选了立刻保存。 */
export function ModelPill({ member, onOpenSettings }: { member: IMember; onOpenSettings: () => void }) {
	const models = useModels();
	const queryClient = useQueryClient();
	const [open, setOpen] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string>();
	if (!models.data) return null;

	const display = modelDisplay(models.data, member.model);
	const effort = member.reasoningEffort ? REASONING_LABELS[member.reasoningEffort] ?? member.reasoningEffort : undefined;
	const model = member.model ? modelKey(member.model.provider, member.model.model) : '';
	const reasoning = member.reasoningEffort ?? '';
	const save = async (nextModel: string, nextReasoning: string) => {
		setSaving(true);
		setError(undefined);
		try {
			const [provider, name] = nextModel.split('\n');
			await api('PUT', `/v1/members/${member.memberId}/model`, { model: nextModel ? { provider, name } : null, reasoning: nextReasoning || null });
			await queryClient.invalidateQueries({ queryKey: queryKeys.members });
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setSaving(false);
		}
	};

	return (
		<Popover.Root open={open} onOpenChange={next => {
			setOpen(next);
			if (!next) setError(undefined);
		}}>
			<Popover.Trigger asChild>
				<button
					type="button"
					title={display.unavailable ? '模型不可用，点击更换' : '模型和思考强度'}
					className={clsx(
						'inline-flex h-6 min-w-16 max-w-52 items-center gap-0.5 rounded-full border pl-2.5 pr-1.5 text-xs transition-colors',
						display.unavailable ? 'border-danger/40 text-danger hover:bg-danger-soft' : 'border-line-strong text-fg-2 hover:bg-hover hover:text-fg',
					)}
				>
					<span className="truncate">{display.name}{effort && ` · ${effort}`}</span>
					<ChevronDown size={13} className="shrink-0" />
				</button>
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content align="start" sideOffset={6} className="z-50 w-80 rounded-lg border border-line bg-raised p-3 shadow-lg">
					<ModelSelects
						model={model}
						reasoning={reasoning}
						disabled={saving}
						onModel={next => void save(next, reasoning)}
						onReasoning={next => void save(model, next)}
					/>
					{error && <div className="mt-2 text-xs text-danger">保存失败：{error}</div>}
					<div className="mt-3 flex items-center justify-between text-xs">
						<span className="text-fg-3">自下一次运行起生效</span>
						<button
							type="button"
							className="text-accent hover:underline"
							onClick={() => {
								setOpen(false);
								onOpenSettings();
							}}
						>
							全部设置
						</button>
					</div>
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}
