import * as Popover from '@radix-ui/react-popover';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ChevronRight, Folder, FolderX, GitBranch, Pencil } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../api/client.ts';
import { queryKeys } from '../api/keys.ts';
import { useSandboxProblem } from '../api/system.ts';
import type { IGitRepositoryInfo, IMember } from '../api/types.ts';
import { IconButton } from '../ui/Button.tsx';
import { CopyablePath } from '../ui/CopyablePath.tsx';
import { openGit } from '../workbench/tabs.ts';

/**
 * 私聊顶部的目录标签：工作目录的最后一级目录名，用默认目录时写「默认目录」；指定的目录有问题时变红。
 * 点开看完整路径，标题右边的铅笔打开成员设置对话框去改；工作目录在 Git 仓库里时，下面一行打开这个仓库的 Git 标签。
 */
export function DirectoryPill({ member, onOpenSettings }: { member: IMember; onOpenSettings: () => void }) {
	const queryClient = useQueryClient();
	// 目录在外面被删掉或改名时没有事件，打开这个对话和点开卡片时重新取一次成员数据，让检查结果是新的。
	const recheck = () => void queryClient.invalidateQueries({ queryKey: queryKeys.members });
	useEffect(recheck, [member.memberId]);
	const path = member.workingDirectory ?? member.defaultWorkingDirectory;
	const sandboxProblem = useSandboxProblem(path);
	const [open, setOpen] = useState(false);
	if (!path) return null;
	const problem = member.workingDirectoryProblem;
	const label = member.workingDirectory ? lastSegment(member.workingDirectory) : '默认目录';
	const Icon = problem ? FolderX : Folder;
	return (
		<Popover.Root open={open} onOpenChange={next => {
			setOpen(next);
			if (next) recheck();
		}}>
			<Popover.Trigger asChild>
				<button
					type="button"
					title={problem ? `工作目录异常（${problem}）：${path}` : `工作目录：${path}`}
					className={clsx(
						'inline-flex h-6 min-w-0 max-w-44 items-center gap-1 rounded-full border px-2 text-xs transition-colors',
						problem ? 'border-danger/40 text-danger hover:bg-danger-soft' : 'border-line-strong text-fg-2 hover:bg-hover hover:text-fg',
					)}
				>
					<Icon size={13} className="shrink-0" />
					{/* 顶部一行窄时（两侧栏占了地方、手机）只显示图标。 */}
					<span className="truncate @max-[36rem]:hidden">{label}</span>
				</button>
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content align="start" sideOffset={6} className="z-50 w-80 rounded-lg border border-line bg-raised p-3 shadow-lg">
					<div className="flex items-center justify-between gap-2">
						<div className="text-[13px] font-medium">工作目录 · {member.workingDirectory ? '指定目录' : '默认目录'}</div>
						{/* 和下面路径的复制按钮一样大、右边对齐；上下用负边距，不撑高标题行。 */}
						<Popover.Close asChild>
							<IconButton label="修改工作目录" onClick={onOpenSettings} className="-my-0.5 size-6 shrink-0">
								<Pencil size={13} />
							</IconButton>
						</Popover.Close>
					</div>
					<div className="mt-1.5"><CopyablePath path={path} wrap /></div>
					{problem && <div className="mt-1.5 text-xs text-danger">{problem}，成员在此目录中执行命令将会出错</div>}
					{!problem && sandboxProblem && <div className="mt-1.5 text-xs text-fg-2">命令未在沙箱中执行（{sandboxProblem}）</div>}
					{!problem && open && <GitRow path={path} onOpen={() => setOpen(false)} />}
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}

/**
 * 工作目录在 Git 仓库里时（是仓库的子目录也算）：「Git 仓库 · 分支」，点它在工作台打开这个仓库的 Git 标签。
 * 每次点开卡片都重新查一次，成员可能刚在这里建了仓库、切了分支。不在仓库里、找不到 git 时什么都不显示；
 * 是仓库但 git 报错（如目录的所有者不对）时写 git 的原话。
 */
function GitRow({ path, onOpen }: { path: string; onOpen: () => void }) {
	const info = useQuery({
		queryKey: ['gitRepository', path],
		queryFn: () => api<IGitRepositoryInfo>('GET', `/v1/git/repository?path=${encodeURIComponent(path)}`),
		staleTime: 0,
		retry: false,
	});
	const repository = info.data?.repository;
	if (info.data?.error) {
		return (
			<div className="mt-2 text-xs">
				<div className="flex items-center gap-1.5 text-fg-2"><GitBranch size={13} className="shrink-0 text-fg-3" />无法读取 Git 仓库</div>
				<div className="mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap break-words text-fg-3">{info.data.error}</div>
			</div>
		);
	}
	if (!repository) return null;
	return (
		<button
			type="button"
			title={`在工作台打开 ${repository.root} 的 Git`}
			onClick={() => {
				openGit(repository.root);
				onOpen();
			}}
			className="-mx-1.5 mt-2 flex w-[calc(100%+0.75rem)] items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[13px] text-fg-2 hover:bg-hover hover:text-fg"
		>
			<GitBranch size={14} className="shrink-0 text-fg-3" />
			<span className="shrink-0">Git 仓库</span>
			<span className="min-w-0 truncate font-mono text-xs text-fg-3">· {repository.branch ?? '分离的 HEAD'}</span>
			<ChevronRight size={14} className="ml-auto shrink-0 text-fg-3" />
		</button>
	);
}

/** 路径的最后一级目录名；盘符根目录这类没有目录名的原样返回。 */
function lastSegment(path: string): string {
	return path.split(/[\\/]+/).filter(Boolean).at(-1) ?? path;
}
