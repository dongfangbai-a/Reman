import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../api/client.ts';
import { useMemory } from '../api/directory.ts';
import { queryKeys } from '../api/keys.ts';
import { errorMessage } from '../lib/errors.ts';
import { Button } from '../ui/Button.tsx';
import { resolvePath } from '../workbench/paths.ts';
import { PromptSection } from './PromptSection.tsx';

type Tab = 'prompt' | 'memory';

const CACHE_HINT = '修改会降低缓存命中';

/**
 * 成员页的提示词和记忆：同一个框，两个标签。提示词跟着页面保存；记忆是成员自己维护的，单独保存，
 * 没保存时「记忆」标签上有个点。onMemoryDirtyChange 报告记忆有没有没保存的修改。
 * deleting：成员正在删除，不再请求它的记忆。promptEdited：提示词有没保存的修改。
 * 提示词和记忆都在上下文开头，改了下一次请求从这里起命中不了缓存，有改动时提醒一句。
 */
export function PromptAndMemory({ memberId, memberName, folderPath, prompt, promptEdited, deleting = false, onPromptChange, onMemoryDirtyChange }: {
	memberId: string;
	memberName: string;
	deleting?: boolean;
	/** 成员文件夹的路径，没拿到时不显示文件路径。 */
	folderPath?: string;
	prompt: string;
	promptEdited: boolean;
	onPromptChange: (prompt: string) => void;
	onMemoryDirtyChange: (dirty: boolean) => void;
}) {
	const [tab, setTab] = useState<Tab>('prompt');
	const memory = useMemory(memberId, !deleting);
	const queryClient = useQueryClient();
	const server = memory.data?.memory ?? '';
	const limit = memory.data?.limit ?? 0;
	// 开始改时记下服务端的内容，之后服务端变了（成员自己改了、别处改了）提示保存会覆盖。
	const [draft, setDraft] = useState<string>();
	const [base, setBase] = useState('');
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string>();
	const editing = draft !== undefined && draft !== base;
	const value = editing ? draft : server;
	const stale = editing && server !== base;
	const length = value.trim().length;
	useEffect(() => onMemoryDirtyChange(editing), [editing, onMemoryDirtyChange]);

	const changeMemory = (next: string) => {
		if (!editing) setBase(server);
		setDraft(next);
		setError(undefined);
	};
	const discard = () => {
		setDraft(undefined);
		setError(undefined);
	};
	const save = async () => {
		setSaving(true);
		setError(undefined);
		try {
			const result = await api<{ memory: string; limit: number }>('PUT', `/v1/members/${memberId}/memory`, { memory: value });
			queryClient.setQueryData(queryKeys.memory(memberId), result);
			setDraft(undefined);
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setSaving(false);
		}
	};

	// 路径是运行时所在机器上的，按那边的分隔符拼。
	const path = (name: string) => folderPath && resolvePath(folderPath, name);
	const heading = (
		<div role="tablist" className="flex shrink-0 items-center gap-4 self-stretch text-[13px]">
			<TabButton active={tab === 'prompt'} onClick={() => setTab('prompt')}>提示词</TabButton>
			<TabButton active={tab === 'memory'} onClick={() => setTab('memory')}>
				记忆{editing && tab !== 'memory' && <span aria-label="有未保存的修改" className="ml-1 inline-block size-1.5 rounded-full bg-accent align-middle" />}
			</TabButton>
		</div>
	);

	if (tab === 'prompt') {
		return <PromptSection value={prompt} onChange={onPromptChange} path={path('prompt.md')} memberName={memberName} heading={heading} hint={promptEdited ? CACHE_HINT : undefined} />;
	}
	return (
		<PromptSection
			value={value}
			onChange={changeMemory}
			path={path('memory.md')}
			memberName={memberName}
			label="记忆"
			placeholder={memory.isPending ? '读取中…' : memory.error ? `读取失败：${memory.error.message}` : '暂无记忆'}
			missingNote="尚无记忆时该文件不存在"
			heading={heading}
			hint={editing ? CACHE_HINT : undefined}
			aside={memory.data && <span className={clsx('text-xs tabular-nums', length > limit ? 'text-warning' : 'text-fg-3')}>{length} / {limit} 字</span>}
			footer={(editing || error) && (
				<div className="flex shrink-0 flex-wrap items-center gap-2 rounded-b-xl border-t border-line px-4 py-2">
					<div className="min-w-0 flex-1 text-[13px]">
						{error
							? <span className="text-danger">保存失败：{error}</span>
							: stale
								? <span className="text-warning">记忆已在别处修改，保存将覆盖</span>
								: <span className="text-xs text-fg-3">{CACHE_HINT}</span>}
					</div>
					<Button className="h-7 px-2.5" disabled={saving} onClick={discard}>放弃修改</Button>
					<Button className="h-7 px-2.5" variant="primary" disabled={saving || !editing} onClick={() => void save()}>保存记忆</Button>
				</div>
			)}
		/>
	);
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
	return (
		<button
			type="button"
			role="tab"
			aria-selected={active}
			onClick={onClick}
			className={clsx('-mb-px flex h-full items-center border-b-2', active ? 'border-accent font-medium text-fg' : 'border-transparent text-fg-3 hover:text-fg-2')}
		>
			{children}
		</button>
	);
}
