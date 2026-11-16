import { keepPreviousData, useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ChevronRight, Copy, FileText, GitBranch, LoaderCircle, RotateCw, SquareTerminal } from 'lucide-react';
import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { api } from '../api/client.ts';
import { queryKeys } from '../api/keys.ts';
import type { GitDiffArea, GitState, IGitChange, IGitCommit, IGitCommitDetail, IGitDiff, IGitStatus, ITerminalInfo } from '../api/types.ts';
import { copyText } from '../lib/clipboard.ts';
import { errorMessage } from '../lib/errors.ts';
import { dayTime, fullTime } from '../lib/format.ts';
import { isSelectingText } from '../lib/selection.ts';
import { IconButton } from '../ui/Button.tsx';
import { CopyButton } from '../ui/CopyButton.tsx';
import { MenuItem, MenuSeparator } from '../ui/Menu.tsx';
import { PointMenu, useMenuTrigger, type IPoint } from '../ui/PointMenu.tsx';
import { parseDiff } from './diff.ts';
import { directoryOf, fileName, resolvePath } from './paths.ts';
import { gitViewState, openFile, openTerminal, reloadGit, saveGitViewState, useGitReloads, type IGitViewState } from './tabs.ts';

/** 历史一次取这么多个提交。 */
const LOG_PAGE = 50;

const STATE_LABELS: Record<GitState, string> = {
	merging: '正在合并，冲突和后续操作请在终端中处理',
	rebasing: '正在变基，冲突和后续操作请在终端中处理',
	'cherry-picking': '正在拣选提交，冲突和后续操作请在终端中处理',
	reverting: '正在还原提交，冲突和后续操作请在终端中处理',
	bisecting: '正在二分查找，后续操作请在终端中处理',
};

/** 文件的状态字母和颜色；未跟踪的写 U，有冲突的写 !。 */
const STATUS_LETTERS: Record<IGitChange['status'], { letter: string; label: string; className: string }> = {
	modified: { letter: 'M', label: '修改', className: 'text-warning' },
	added: { letter: 'A', label: '新增', className: 'text-success' },
	deleted: { letter: 'D', label: '删除', className: 'text-danger' },
	renamed: { letter: 'R', label: '重命名', className: 'text-accent' },
	copied: { letter: 'C', label: '复制', className: 'text-accent' },
	typeChanged: { letter: 'T', label: '类型变更', className: 'text-fg-2' },
};

type Group = 'conflicted' | 'staged' | 'unstaged' | 'untracked';

const GROUPS: readonly { readonly group: Group; readonly title: string; readonly area: GitDiffArea }[] = [
	{ group: 'conflicted', title: '有冲突', area: 'unstaged' },
	{ group: 'staged', title: '已暂存', area: 'staged' },
	{ group: 'unstaged', title: '未暂存', area: 'unstaged' },
	{ group: 'untracked', title: '未跟踪', area: 'untracked' },
];

/**
 * 工作台里一个仓库的 Git 标签，只读（WEB_DESIGN.md「Git」）：第二行是改动、历史的切换，分支和操作；下面是这一页。
 * 切到这个标签（重新挂上）、又从目录卡片打开、点刷新时重新读，不轮询。
 */
export function GitView({ root }: { root: string }) {
	const reloads = useGitReloads(state => state[root] ?? 0);
	const status = useQuery({
		queryKey: ['gitStatus', root, reloads],
		queryFn: () => api<IGitStatus>('GET', `/v1/git/status?path=${encodeURIComponent(root)}`),
		staleTime: 0,
		retry: false,
		placeholderData: keepPreviousData,
	});
	const [view, setView] = useState(() => gitViewState(root));
	const update = (patch: Partial<IGitViewState>) => {
		setView(previous => ({ ...previous, ...patch }));
		saveGitViewState(root, patch);
	};
	// 按最新的状态改：连着点几行时每次都算数。
	const toggle = (key: string) => setView(previous => {
		const expanded = new Set(previous.expanded);
		if (!expanded.delete(key)) expanded.add(key);
		saveGitViewState(root, { expanded });
		return { ...previous, expanded };
	});
	const data = status.data;
	const total = data ? Object.values(data.changes).reduce((sum, group) => sum + group.length, 0) : undefined;
	return (
		<>
			<div className="flex shrink-0 items-center gap-3 border-b border-line bg-pane px-3 py-1.5 text-xs">
				<div className="flex shrink-0 rounded-md border border-line p-0.5" role="radiogroup" aria-label="更改与历史">
					{(['changes', 'history'] as const).map(page => (
						<button
							key={page}
							type="button"
							role="radio"
							aria-checked={view.page === page}
							onClick={() => update({ page })}
							className={clsx('rounded px-2 py-0.5', view.page === page ? 'bg-accent-soft text-accent' : 'text-fg-2 hover:bg-hover')}
						>
							{page === 'changes' ? <>更改{total ? <span className="ml-1 tabular-nums">{total}{data?.truncated && '+'}</span> : null}</> : '历史'}
						</button>
					))}
				</div>
				{data && <BranchInfo status={data} />}
				<div className="ml-auto flex shrink-0 items-center gap-0.5">
					{status.isFetching && <LoaderCircle size={13} className="mr-1 animate-spin text-fg-3" aria-label="正在读取" />}
					<IconButton label="刷新" className="size-6" onClick={() => reloadGit(root)}><RotateCw size={14} /></IconButton>
					<OpenTerminalButton root={root} />
				</div>
			</div>
			{data?.state && <div className="shrink-0 border-b border-line bg-hover px-3 py-1.5 text-xs text-fg-2">{STATE_LABELS[data.state]}</div>}
			<div className="min-h-0 flex-1 overflow-y-auto">
				{view.page === 'changes'
					? status.isError ? <GitError message={status.error.message} /> : data && <ChangesPage status={data} root={root} reloads={reloads} expanded={view.expanded} onToggle={toggle} />
					: <HistoryPage root={root} reloads={reloads} expanded={view.expanded} onToggle={toggle} />}
			</div>
		</>
	);
}

/**
 * 分支名（不在分支上时写「分离的 HEAD · 短哈希」）；有跟踪的远程分支时写领先、落后几个，后面是上次获取远程的时间：
 * 面板不获取远程，数字是和那时比的。
 * 放不下时从后往前整块藏起来（先藏获取时间，再藏远程分支），不截掉半个：一行高、超出的藏起来，放不下的换到看不见的第二行。
 */
function BranchInfo({ status }: { status: IGitStatus }) {
	const upstream = status.upstream;
	const fetched = status.fetchedAt ? `上次获取于 ${dayTime(status.fetchedAt)}` : '尚未获取远程';
	return (
		<div className="flex h-[18px] min-w-0 flex-1 flex-wrap items-center gap-x-2 overflow-hidden text-fg-2">
			<span className="flex h-[18px] min-w-0 max-w-full items-center gap-1" title={status.branch ?? undefined}>
				<GitBranch size={13} className="shrink-0 text-fg-3" />
				<span className="truncate font-mono text-[11px]">{status.branch ?? `分离的 HEAD · ${status.head?.hash.slice(0, 7) ?? ''}`}</span>
			</span>
			{upstream && (
				<span className="flex h-[18px] max-w-full shrink-0 items-center gap-1.5 text-fg-3" title={`与上次获取远程时相比，${fetched}`}>
					{upstream.ahead > 0 && <span className="shrink-0 tabular-nums">↑{upstream.ahead}</span>}
					{upstream.behind > 0 && <span className="shrink-0 tabular-nums">↓{upstream.behind}</span>}
					<span className="truncate font-mono text-[11px]">{upstream.name}</span>
				</span>
			)}
			{upstream && <span className="flex h-[18px] shrink-0 items-center text-fg-3" title={status.fetchedAt ? fullTime(status.fetchedAt) : undefined}>{fetched}</span>}
		</div>
	);
}

/** 在仓库根目录新建一个终端，由你操作：要暂存、提交、切分支时在这里自己用 git。 */
function OpenTerminalButton({ root }: { root: string }) {
	const queryClient = useQueryClient();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const open = async () => {
		setBusy(true);
		setError(undefined);
		try {
			const { terminal } = await api<{ terminal: ITerminalInfo }>('POST', '/v1/terminals', { cwd: root });
			await queryClient.invalidateQueries({ queryKey: queryKeys.terminals });
			openTerminal(terminal.terminalId);
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	};
	return (
		<>
			{error && <span className="max-w-60 truncate text-danger" title={error}>{error}</span>}
			<IconButton label="在终端中打开" className="size-6" disabled={busy} onClick={() => void open()}><SquareTerminal size={14} /></IconButton>
		</>
	);
}

/** git 的报错原样显示：常常有好几行，后面写了怎么处理（如把目录加进 safe.directory）。 */
function GitError({ message }: { message: string }) {
	return (
		<div className="p-4">
			<div className="mb-1.5 text-[13px] font-medium">无法读取该仓库</div>
			<pre className="whitespace-pre-wrap break-words rounded-md bg-code px-3 py-2 font-mono text-xs text-fg-2">{message}</pre>
		</div>
	);
}

/** 改动：有冲突、已暂存、未暂存、未跟踪几组，没有的组不显示。 */
function ChangesPage({ status, root, reloads, expanded, onToggle }: { status: IGitStatus; root: string; reloads: number; expanded: ReadonlySet<string>; onToggle: (key: string) => void }) {
	const groups = GROUPS.filter(({ group }) => status.changes[group].length > 0);
	if (groups.length === 0) return <div className="px-4 py-8 text-center text-[13px] text-fg-3">没有更改</div>;
	return (
		<div className="space-y-3 p-2">
			{status.truncated && <div className="px-2 text-xs text-fg-3">更改过多，每组仅列出前 1000 个</div>}
			{groups.map(({ group, title, area }) => (
				<section key={group}>
					<h3 className="px-2 pb-0.5 text-xs font-medium text-fg-3">{title}<span className="ml-1.5 font-normal tabular-nums">{status.changes[group].length}</span></h3>
					{status.changes[group].map(change => {
						const key = `${group}:${change.path}`;
						return (
							<ChangeRow key={key} change={change} root={root} group={group} open={expanded.has(key)} onToggle={() => onToggle(key)}>
								<DiffView root={root} area={area} change={change} reloads={reloads} />
							</ChangeRow>
						);
					})}
				</section>
			))}
		</div>
	);
}

/**
 * 一个改了的文件：状态字母、文件名、灰色的所在目录、增删的行数，右边「打开文件」（删掉的没有）。
 * 点一行展开 diff，再点收起；拖着选文字松开时不算。右键（手机上长按）复制文件名、路径。
 */
function ChangeRow({ change, root, group, open, onToggle, children }: { change: IGitChange; root: string; group?: Group; open: boolean; onToggle: () => void; children: ReactNode }) {
	// 提交里的文件打开的是现在工作区里的，不是那个提交里的。
	const openLabel = group ? '打开文件' : '打开文件（当前版本）';
	const status = group === 'untracked' ? { letter: 'U', label: '未跟踪', className: 'text-success' }
		: group === 'conflicted' ? { letter: '!', label: '有冲突', className: 'text-danger' } : STATUS_LETTERS[change.status];
	const sameDirectory = !change.oldPath || directoryOf(change.oldPath) === directoryOf(change.path);
	const directory = sameDirectory ? directoryOf(change.path) : '';
	const name = change.oldPath ? sameDirectory ? `${fileName(change.oldPath)} → ${fileName(change.path)}` : `${change.oldPath} → ${change.path}` : fileName(change.path);
	const fullPath = resolvePath(root, change.path);
	const [menu, setMenu] = useState<IPoint>();
	const trigger = useMenuTrigger(setMenu);
	const onRowClick = (event: MouseEvent<HTMLDivElement>) => {
		if (isSelectingText(event)) return;
		onToggle();
	};
	return (
		<div>
			<div {...trigger} onClick={onRowClick} className={clsx('flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-[13px] hover:bg-hover', menu && 'bg-hover')}>
				<button type="button" aria-expanded={open} title={change.oldPath ? `${change.oldPath} → ${change.path}` : change.path} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
					<ChevronRight size={13} className={clsx('shrink-0 text-fg-3 transition-transform', open && 'rotate-90')} />
					<span className={clsx('w-3 shrink-0 text-center font-mono text-xs font-semibold', status.className)} title={status.label}>{status.letter}</span>
					<span className={clsx('min-w-0 shrink truncate', change.status === 'deleted' && 'line-through decoration-fg-3')}>{name}</span>
					{directory && <span className="min-w-0 flex-1 truncate text-xs text-fg-3">{directory}</span>}
				</button>
				<Counts change={change} />
				{change.status !== 'deleted' && (
					<span onClick={event => event.stopPropagation()}>
						<IconButton label={openLabel} className="size-6" onClick={() => openFile(fullPath)}><FileText size={13} /></IconButton>
					</span>
				)}
			</div>
			{/* 放在可点的那一行外面：菜单里的点击会顺着组件冒泡，放在里面会把这一行展开、收起。只在打开时挂上，几千行也不多开几千个菜单。 */}
			{menu && (
				<PointMenu point={menu} onClose={() => setMenu(undefined)}>
					<MenuItem onSelect={() => void copyText(fileName(change.path))}><Copy size={15} />复制文件名</MenuItem>
					<MenuItem onSelect={() => void copyText(change.path)}><Copy size={15} />复制相对路径</MenuItem>
					<MenuItem onSelect={() => void copyText(fullPath)}><Copy size={15} />复制完整路径</MenuItem>
					{change.oldPath && <MenuItem onSelect={() => void copyText(change.oldPath!)}><Copy size={15} />复制原路径</MenuItem>}
					{change.status !== 'deleted' && (
						<>
							<MenuSeparator />
							<MenuItem onSelect={() => openFile(fullPath)}><FileText size={15} />{openLabel}</MenuItem>
						</>
					)}
				</PointMenu>
			)}
			{open && <div className="mb-2 mt-0.5">{children}</div>}
		</div>
	);
}

function Counts({ change }: { change: IGitChange }) {
	if (change.binary) return <span className="shrink-0 text-xs text-fg-3">二进制</span>;
	if (change.added === undefined && change.removed === undefined) return null;
	return (
		<span className="shrink-0 font-mono text-xs tabular-nums">
			{!!change.added && <span className="text-success">+{change.added}</span>}
			{!!change.added && !!change.removed && ' '}
			{!!change.removed && <span className="text-danger">−{change.removed}</span>}
		</span>
	);
}

/** 一个文件的 diff。工作区的改动跟着刷新重新读；提交里的不会变，读一次就够。 */
function DiffView({ root, area, change, commit, reloads = 0 }: { root: string; area: GitDiffArea; change: IGitChange; commit?: string; reloads?: number }) {
	const params = new URLSearchParams({ path: root, file: change.path, area });
	if (change.oldPath) params.set('oldPath', change.oldPath);
	if (commit) params.set('commit', commit);
	const diff = useQuery({
		queryKey: ['gitDiff', root, area, change.path, change.oldPath, commit, area === 'commit' ? 0 : reloads],
		queryFn: () => api<IGitDiff>('GET', `/v1/git/diff?${params}`),
		staleTime: area === 'commit' ? Infinity : 0,
		retry: false,
		placeholderData: keepPreviousData,
	});
	if (diff.isError) return <div className="px-2 text-xs text-danger whitespace-pre-wrap">{diff.error.message}</div>;
	if (!diff.data) return <div className="px-2 text-xs text-fg-3">正在读取…</div>;
	if (diff.data.binary) return <div className="px-2 text-xs text-fg-3">二进制文件，不显示内容</div>;
	return <DiffBody text={diff.data.diff} truncated={diff.data.truncated} />;
}

/** diff 的样子和时间线里改文件那一步一样：增的行绿底、删的行红底；前面两列是原来和现在的行号。 */
function DiffBody({ text, truncated }: { text: string; truncated: boolean }) {
	const lines = parseDiff(text);
	if (lines.length === 0) return <div className="px-2 text-xs text-fg-3">内容无变化</div>;
	// 合并冲突的 diff 没有行号，不留这两列。
	const numbered = lines.some(line => line.old !== undefined || line.new !== undefined);
	const digits = String(lines.reduce((max, line) => Math.max(max, line.old ?? 0, line.new ?? 0), 0)).length;
	const gutter = { width: `${digits + 1.5}ch` };
	return (
		<div className="max-h-[36rem] overflow-auto rounded-md border border-line font-mono text-xs leading-5">
			<div className="w-max min-w-full">
				{lines.map((line, index) => (
					<div
						key={index}
						className={clsx(
							'flex',
							line.kind === 'add' && 'bg-success/12 text-success',
							line.kind === 'remove' && 'bg-danger/12 text-danger',
							(line.kind === 'hunk' || line.kind === 'note') && 'bg-hover/60 text-fg-3',
						)}
					>
						{numbered && <span className="shrink-0 select-none pr-1 text-right text-fg-3/70" style={gutter}>{line.old}</span>}
						{numbered && <span className="shrink-0 select-none pr-1 text-right text-fg-3/70" style={gutter}>{line.new}</span>}
						<span className="whitespace-pre pl-2 pr-3">{line.text || ' '}</span>
					</div>
				))}
				{truncated && <div className="px-2 py-1 text-fg-3">内容过长，仅显示开头部分（最多 5000 行、1 MB）</div>}
			</div>
		</div>
	);
}

/** 历史：当前分支的提交，从新到旧，每次取 50 个，滚到底再取。 */
function HistoryPage({ root, reloads, expanded, onToggle }: { root: string; reloads: number; expanded: ReadonlySet<string>; onToggle: (key: string) => void }) {
	const log = useInfiniteQuery({
		queryKey: ['gitLog', root, reloads],
		queryFn: ({ pageParam }) => api<{ commits: IGitCommit[] }>('GET', `/v1/git/log?${new URLSearchParams({ path: root, limit: String(LOG_PAGE), ...pageParam ? { before: pageParam } : {} })}`),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: last => last.commits.length < LOG_PAGE ? undefined : last.commits.at(-1)!.hash,
		staleTime: 0,
		retry: false,
		placeholderData: keepPreviousData,
	});
	const sentinel = useRef<HTMLDivElement>(null);
	const { hasNextPage, isFetchingNextPage, fetchNextPage } = log;
	useEffect(() => {
		const element = sentinel.current;
		if (!element || !hasNextPage) return;
		const observer = new IntersectionObserver(entries => {
			if (entries.some(entry => entry.isIntersecting) && !isFetchingNextPage) void fetchNextPage();
		}, { rootMargin: '200px' });
		observer.observe(element);
		return () => observer.disconnect();
	}, [hasNextPage, isFetchingNextPage, fetchNextPage]);
	if (log.isError && !log.data) return <GitError message={log.error.message} />;
	if (!log.data) return null;
	const commits = log.data.pages.flatMap(page => page.commits);
	if (commits.length === 0) return <div className="px-4 py-8 text-center text-[13px] text-fg-3">暂无提交</div>;
	return (
		<div className="space-y-0.5 p-2">
			{commits.map(commit => {
				const key = `commit:${commit.hash}`;
				return <CommitRow key={key} commit={commit} root={root} open={expanded.has(key)} onToggle={() => onToggle(key)} expanded={expanded} onToggleFile={onToggle} />;
			})}
			<div ref={sentinel} />
			{isFetchingNextPage && <div className="px-2 py-1 text-xs text-fg-3">正在读取…</div>}
			{log.isError && <div className="px-2 py-1 text-xs text-danger">{log.error.message}</div>}
		</div>
	);
}

/** 一个提交的详情：完整的提交说明、改了的文件。展开时和复制提交说明共用。 */
function commitQuery(root: string, hash: string) {
	return {
		queryKey: ['gitCommit', root, hash],
		queryFn: () => api<IGitCommitDetail>('GET', `/v1/git/commits/${hash}?path=${encodeURIComponent(root)}`),
		retry: false,
	} as const;
}

/**
 * 一个提交：提交说明的第一行，下面灰色小字写作者、时间、短哈希。点开看完整的提交说明和改了的文件。
 * 右键（手机上长按）复制哈希、完整的提交说明。
 */
function CommitRow({ commit, root, open, onToggle, expanded, onToggleFile }: {
	commit: IGitCommit;
	root: string;
	open: boolean;
	onToggle: () => void;
	expanded: ReadonlySet<string>;
	onToggleFile: (key: string) => void;
}) {
	const queryClient = useQueryClient();
	const [menu, setMenu] = useState<IPoint>();
	const trigger = useMenuTrigger(setMenu);
	const onRowClick = (event: MouseEvent<HTMLDivElement>) => {
		if (isSelectingText(event)) return;
		onToggle();
	};
	// 列表里只有第一行，完整的要取详情；展开过的已经取过了。
	const copyMessage = async () => {
		const detail = await queryClient.fetchQuery(commitQuery(root, commit.hash)).catch(() => undefined);
		if (detail) await copyText(detail.message);
	};
	return (
		<div>
			<div {...trigger} onClick={onRowClick} className={clsx('cursor-pointer rounded-md px-2 py-1.5 text-[13px] hover:bg-hover', menu && 'bg-hover')}>
				<button type="button" aria-expanded={open} className="flex w-full min-w-0 items-start gap-1.5 text-left">
					<ChevronRight size={13} className={clsx('mt-[3px] shrink-0 text-fg-3 transition-transform', open && 'rotate-90')} />
					<span className="min-w-0 flex-1 truncate" title={commit.subject}>{commit.subject || '（无提交说明）'}</span>
				</button>
				<div className="flex flex-wrap items-center gap-x-2 pl-[19px] text-xs text-fg-3">
					<span className="max-w-40 truncate" title={commit.email}>{commit.author}</span>
					<span title={fullTime(commit.authoredAt)}>{dayTime(commit.authoredAt)}</span>
					<span className="font-mono">{commit.hash.slice(0, 7)}</span>
					{commit.parents.length > 1 && <span className="rounded bg-hover px-1 text-[11px] leading-4">合并</span>}
				</div>
			</div>
			{menu && (
				<PointMenu point={menu} onClose={() => setMenu(undefined)}>
					<MenuItem onSelect={() => void copyText(commit.hash)}><Copy size={15} />复制哈希</MenuItem>
					<MenuItem onSelect={() => void copyMessage()}><Copy size={15} />复制提交说明</MenuItem>
				</PointMenu>
			)}
			{open && <CommitDetail commit={commit} root={root} expanded={expanded} onToggleFile={onToggleFile} />}
		</div>
	);
}

/** 提交展开后：提交说明第一行以后的部分、完整哈希，和它相对第一个父提交改了的文件，文件再点开看 diff。 */
function CommitDetail({ commit, root, expanded, onToggleFile }: { commit: IGitCommit; root: string; expanded: ReadonlySet<string>; onToggleFile: (key: string) => void }) {
	const detail = useQuery(commitQuery(root, commit.hash));
	if (detail.isError) return <div className="mb-2 px-2 pl-[27px] text-xs text-danger whitespace-pre-wrap">{detail.error.message}</div>;
	if (!detail.data) return <div className="mb-2 pl-[27px] text-xs text-fg-3">正在读取…</div>;
	const body = detail.data.message.split('\n').slice(1).join('\n').trim();
	return (
		<div className="mb-2 mt-0.5 space-y-1.5">
			{body && <div className="whitespace-pre-wrap break-words pl-[27px] pr-2 text-[13px] text-fg-2">{body}</div>}
			<div className="group/copy flex items-center gap-1 pl-[27px] font-mono text-[11px] text-fg-3">
				<span className="select-all">{commit.hash}</span>
				<CopyButton text={commit.hash} />
			</div>
			{detail.data.files.length === 0
				? <div className="pl-[27px] text-xs text-fg-3">没有更改的文件</div>
				: (
					<div className="pl-[19px]">
						{detail.data.files.map(change => {
							const key = `commit:${commit.hash}:${change.path}`;
							return (
								<ChangeRow key={key} change={change} root={root} open={expanded.has(key)} onToggle={() => onToggleFile(key)}>
									<DiffView root={root} area="commit" change={change} commit={commit.hash} />
								</ChangeRow>
							);
						})}
					</div>
				)}
		</div>
	);
}
