import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { useState } from 'react';
import { api } from '../api/client.ts';
import { useSkillSources } from '../api/directory.ts';
import { queryKeys } from '../api/keys.ts';
import type { ISkillCandidate, ISkillSource } from '../api/types.ts';
import { errorMessage } from '../lib/errors.ts';
import { BackLink } from '../ui/BackLink.tsx';
import { Button } from '../ui/Button.tsx';
import { CheckMark } from '../ui/Checkbox.tsx';
import { CopyablePath } from '../ui/CopyablePath.tsx';
import { DirectoryPicker } from '../ui/DirectoryPicker.tsx';
import { SettingsPage } from './SettingsPage.tsx';

/** 从常见的全局 agent 技能目录或任意文件夹导入技能：复制整个技能文件夹到技能目录。 */
export function SkillImport() {
	const queryClient = useQueryClient();
	const globals = useSkillSources('');
	const [folder, setFolder] = useState<string>();
	const [picking, setPicking] = useState(false);
	const [selected, setSelected] = useState<ReadonlyMap<string, ISkillCandidate>>(new Map());
	const [busy, setBusy] = useState(false);
	const [result, setResult] = useState<{ imported: string[]; failed: string[] }>();

	const toggle = (candidate: ISkillCandidate) => setSelected(current => {
		const next = new Map(current);
		if (next.has(candidate.directory)) next.delete(candidate.directory);
		else next.set(candidate.directory, candidate);
		return next;
	});
	const importSelected = async () => {
		setBusy(true);
		setResult(undefined);
		const imported: string[] = [];
		const failed: string[] = [];
		for (const candidate of selected.values()) {
			try {
				await api('POST', '/v1/skills/import', { directory: candidate.directory, overwrite: candidate.exists });
				imported.push(candidate.name);
			} catch (caught) {
				failed.push(`${candidate.name}：${errorMessage(caught)}`);
			}
		}
		setSelected(new Map());
		setResult({ imported, failed });
		setBusy(false);
		void queryClient.invalidateQueries({ queryKey: queryKeys.skills });
		void queryClient.invalidateQueries({ queryKey: ['skillSources'] });
	};

	return (
		<SettingsPage>
			<BackLink to="/settings/skills" label="技能" />
			<h1 className="mb-1 text-xl font-semibold">导入技能</h1>
			<div className="mb-5 text-[13px] text-fg-2">导入会将整个技能文件夹复制到技能目录，此后修改或删除原文件夹不影响成员。</div>
			{globals.isPending && <div className="text-center text-[13px] text-fg-3">正在查找…</div>}
			{globals.isError && <div className="text-[13px] text-danger">查找失败：{globals.error.message}</div>}
			<div className="flex flex-col gap-4">
				{globals.data?.map(source => <SourceCard key={source.directory} source={source} selected={selected} onToggle={toggle} />)}
				<section className="rounded-xl border border-line bg-raised">
					<div className="flex h-10 items-center gap-2 border-b border-line pl-4 pr-1.5 text-[13px]">
						<span className="font-medium">从文件夹导入</span>
						<Button className="ml-auto h-7 px-2.5" onClick={() => setPicking(true)}>{folder ? '更换文件夹' : '选择文件夹'}</Button>
					</div>
					{folder
						? <FolderSkills path={folder} selected={selected} onToggle={toggle} />
						: <div className="px-4 py-3 text-xs text-fg-3">选择一个技能文件夹（其中包含 SKILL.md），或包含多个技能的文件夹。</div>}
				</section>
			</div>
			{(selected.size > 0 || result) && (
				<div className="sticky bottom-0 -mx-1 mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-raised px-4 py-3 shadow-lg">
					<div className="min-w-0 flex-1 text-[13px]">
						{selected.size > 0
							? <span className="text-fg-2">已选 {selected.size} 个技能</span>
							: result && (
								<>
									{result.imported.length > 0 && <div className="text-fg-2">已导入：{result.imported.join('、')}</div>}
									{result.failed.map(line => <div key={line} className="text-danger">导入失败：{line}</div>)}
								</>
							)}
					</div>
					{selected.size > 0 && <Button variant="primary" disabled={busy} onClick={() => void importSelected()}>导入</Button>}
				</div>
			)}
			{picking && (
				<DirectoryPicker
					title="选择技能文件夹"
					initial={folder ?? ''}
					onClose={() => setPicking(false)}
					onSelect={path => {
						setFolder(path);
						setPicking(false);
					}}
				/>
			)}
		</SettingsPage>
	);
}

function SourceCard({ source, selected, onToggle }: { source: ISkillSource; selected: ReadonlyMap<string, ISkillCandidate>; onToggle: (candidate: ISkillCandidate) => void }) {
	return (
		<section className="rounded-xl border border-line bg-raised">
			<div className="flex h-10 items-center gap-2 border-b border-line px-4 text-[13px]">
				<span className="shrink-0 font-mono font-medium">{source.label}</span>
				{source.exists && <div className="ml-auto min-w-0"><CopyablePath path={source.directory} /></div>}
			</div>
			<Candidates source={source} selected={selected} onToggle={onToggle} />
		</section>
	);
}

/** 选的文件夹里的技能。 */
function FolderSkills({ path, selected, onToggle }: { path: string; selected: ReadonlyMap<string, ISkillCandidate>; onToggle: (candidate: ISkillCandidate) => void }) {
	const sources = useSkillSources(path);
	if (sources.isPending) return <div className="px-4 py-3 text-[13px] text-fg-3">正在查找…</div>;
	if (sources.isError) return <div className="px-4 py-3 text-[13px] text-danger">查找失败：{sources.error.message}</div>;
	const source = sources.data[0]!;
	return (
		<>
			<div className="border-b border-line px-4 py-1.5"><CopyablePath path={source.directory} /></div>
			<Candidates source={source} selected={selected} onToggle={onToggle} />
		</>
	);
}

function Candidates({ source, selected, onToggle }: { source: ISkillSource; selected: ReadonlyMap<string, ISkillCandidate>; onToggle: (candidate: ISkillCandidate) => void }) {
	if (!source.exists) return <div className="px-4 py-3 text-xs text-fg-3">该目录不存在</div>;
	if (source.skills.length === 0) return <div className="px-4 py-3 text-xs text-fg-3">此处没有技能（技能文件夹中须包含 SKILL.md）</div>;
	return (
		<div className="divide-y divide-line">
			{source.skills.map(candidate => {
				const checked = selected.has(candidate.directory);
				const disabled = candidate.problem !== null;
				return (
					<button
						key={candidate.directory}
						type="button"
						disabled={disabled}
						onClick={() => onToggle(candidate)}
						className={clsx('flex w-full items-center gap-3 px-4 py-2 text-left last:rounded-b-xl', !disabled && 'hover:bg-hover')}
					>
						<CheckMark checked={checked} disabled={disabled} />
						<div className="min-w-0 flex-1">
							<div className={clsx('truncate font-mono text-[13px]', disabled && 'text-fg-3')}>{candidate.name}</div>
							{candidate.problem
								? <div className="truncate text-xs text-danger" title={candidate.problem}>{candidate.problem}</div>
								: <div className="truncate text-xs text-fg-3" title={candidate.description}>{candidate.description || '无说明'}</div>}
						</div>
						{!disabled && candidate.exists && <span className="shrink-0 text-xs text-warning">已存在同名技能，导入将覆盖</span>}
					</button>
				);
			})}
		</div>
	);
}
