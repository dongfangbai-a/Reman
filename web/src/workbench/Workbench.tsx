import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import clsx from 'clsx';
import { ChevronDown, Copy, FileText, GitBranch, LoaderCircle, Maximize2, Minimize2, Pencil, Plus, X } from 'lucide-react';
import { useEffect, useRef, useState, type DragEvent, type RefObject } from 'react';
import { api } from '../api/client.ts';
import { useTasks } from '../api/member.ts';
import { useMembers } from '../api/queries.ts';
import { useOutputtingTerminals, useTerminals } from '../api/system.ts';
import type { IMember, ITerminalInfo } from '../api/types.ts';
import { HEADER_RIGHT } from '../layout/PanelToggles.tsx';
import { copyText } from '../lib/clipboard.ts';
import { useIsPhone } from '../lib/media.ts';
import { usePreferences, type IOpenFile, type IOpenRepository, type IOpenTaskList } from '../stores.ts';
import { TasksView } from '../tasks/TaskList.tsx';
import { CloseTerminal, NewTerminalDialog, TerminalDetail, terminalStatus, TerminalTabLabel } from '../terminals/TerminalDetail.tsx';
import { Avatar } from '../ui/Avatar.tsx';
import { IconButton } from '../ui/Button.tsx';
import { CenteredMessage } from '../ui/CenteredMessage.tsx';
import { ErrorBoundary } from '../ui/ErrorBoundary.tsx';
import { MenuContent, MenuItem } from '../ui/Menu.tsx';
import { PointMenu, useMenuTrigger, type IPoint } from '../ui/PointMenu.tsx';
import { FileView } from './FileView.tsx';
import { GitView } from './GitView.tsx';
import { directoryOf, fileName } from './paths.ts';
import { closeFile, closeGit, closeTasks, fileTab, gitTab, markTerminalSeen, renameTerminal, tasksTab, terminalTab, useTabFlash, useUnseenTerminals } from './tabs.ts';

/** 工作台里的一个标签：终端、文件、某个成员的后台任务或某个仓库的 Git。addedAt 是新建、打开的时间，没拖过的按它排。 */
type Item =
	| { readonly kind: 'terminal'; readonly key: string; readonly addedAt: number; readonly terminal: ITerminalInfo }
	| { readonly kind: 'file'; readonly key: string; readonly addedAt: number; readonly path: string }
	| { readonly kind: 'tasks'; readonly key: string; readonly addedAt: number; readonly memberId: string }
	| { readonly kind: 'git'; readonly key: string; readonly addedAt: number; readonly root: string };

/** 工作台：第一行是标签页（终端、文件、后台任务、Git），第二行是选中的这一个的信息和操作，下面是内容。 */
export function Workbench() {
	const terminals = useTerminals();
	const members = useMembers();
	const tab = usePreferences(state => state.workbenchTab);
	const order = usePreferences(state => state.workbenchOrder);
	const files = usePreferences(state => state.openFiles);
	const taskLists = usePreferences(state => state.openTaskLists);
	const repositories = usePreferences(state => state.openRepositories);
	const names = usePreferences(state => state.terminalNames);
	const maximized = usePreferences(state => state.workbenchMaximized);
	const set = usePreferences(state => state.set);
	const phone = useIsPhone();
	const [creating, setCreating] = useState(false);
	const [closing, setClosing] = useState<ITerminalInfo>();
	const items = sortItems(terminals.data ?? [], files, taskLists, repositories, order);
	const selected = items.find(item => item.key === tab) ?? items[0];
	const memberById = new Map((members.data ?? []).map(member => [member.memberId, member]));
	const select = (key: string) => set({ workbenchTab: key });
	// 已退出的终端里面没有在跑的程序，直接关，不用确认；还在运行的先确认。关不掉的（比如刚被别人关了）留在列表里，不另外提示。
	const closeTerminal = (terminal: ITerminalInfo) => api('POST', `/v1/terminals/${terminal.terminalId}/close`);
	const close = (item: Item) => {
		if (item.kind === 'terminal') {
			if (item.terminal.status === 'running') setClosing(item.terminal);
			else void closeTerminal(item.terminal).catch(() => undefined);
		} else if (item.kind === 'file') closeFile(item.path);
		else if (item.kind === 'git') closeGit(item.root);
		else closeTasks(item.memberId);
	};
	const exited = (terminals.data ?? []).filter(terminal => terminal.status === 'exited');
	const closeExited = () => void Promise.allSettled(exited.map(closeTerminal));

	// 选中的就是看过了。工作台开着时 AI 新开的终端可能直接被选中（例如只有它一个），
	// 这时它比记成没看过还早一步被选中，要等记上以后再消掉。
	const unseen = useUnseenTerminals(state => state.unseen);
	const outputting = useOutputtingTerminals(state => state.ids);
	const selectedTerminal = selected?.kind === 'terminal' ? selected.terminal.terminalId : undefined;
	useEffect(() => {
		if (selectedTerminal && unseen.has(selectedTerminal)) markTerminalSeen(selectedTerminal);
	}, [selectedTerminal, unseen]);

	// 成员没了（彻底删除了，或者浏览器里记着的是另一份数据里的成员）时，它的后台任务标签一起关掉：读不到了，留着只会一直报错。
	// 只删除、还能恢复的成员留着，它的后台任务还能看。
	useEffect(() => {
		if (!members.data) return;
		const alive = new Set(members.data.filter(member => !member.purged).map(member => member.memberId));
		for (const list of taskLists) if (!alive.has(list.memberId)) closeTasks(list.memberId);
	}, [members.data, taskLists]);

	// 终端关掉、运行时重启后没了时，它的名字一起删掉。
	useEffect(() => {
		if (!terminals.data) return;
		const alive = new Set(terminals.data.map(terminal => terminal.terminalId));
		if (Object.keys(names).some(id => !alive.has(id))) set({ terminalNames: Object.fromEntries(Object.entries(names).filter(([id]) => alive.has(id))) });
	}, [terminals.data, names, set]);

	const move = (key: string, beforeKey: string | undefined) => {
		const keys = items.map(item => item.key).filter(other => other !== key);
		const index = beforeKey === undefined ? keys.length : keys.indexOf(beforeKey);
		keys.splice(index < 0 ? keys.length : index, 0, key);
		set({ workbenchOrder: keys });
	};

	return (
		<div className="flex h-full min-h-0 flex-col">
			<header className={clsx('flex h-12 shrink-0 items-center gap-1 border-b border-line pl-2', HEADER_RIGHT)}>
				<Tabs items={items} selectedKey={selected?.key} memberById={memberById} names={names} onCloseExited={exited.length > 0 ? closeExited : undefined} onSelect={select} onMove={move} onClose={close} />
				<IconButton label="新建终端" className="size-7 shrink-0" onClick={() => setCreating(true)}><Plus size={16} /></IconButton>
				{items.length > 1 && (
					<DropdownMenu.Root>
						<DropdownMenu.Trigger asChild>
							<IconButton label="全部标签" className="size-7 shrink-0"><ChevronDown size={16} /></IconButton>
						</DropdownMenu.Trigger>
						<MenuContent align="end">
							{items.map(item => (
								<MenuItem key={item.key} onSelect={() => select(item.key)} className={clsx(item.key === selected?.key && 'font-medium', item.kind === 'terminal' && item.terminal.status === 'exited' && 'text-fg-3')}>
									{item.kind === 'terminal' ? <TerminalMenuLabel terminal={item.terminal} creator={item.terminal.createdBy ? memberById.get(item.terminal.createdBy) : undefined} outputting={isOutputting(item.terminal, outputting)} name={names[item.terminal.terminalId]} />
										: item.kind === 'file' ? <FileMenuLabel path={item.path} /> : item.kind === 'git' ? <GitMenuLabel root={item.root} />
											: <TasksLabel memberId={item.memberId} member={memberById.get(item.memberId)} />}
								</MenuItem>
							))}
						</MenuContent>
					</DropdownMenu.Root>
				)}
				{!phone && (
					<IconButton label={maximized ? '恢复' : '最大化'} className="size-7 shrink-0" onClick={() => set({ workbenchMaximized: !maximized })}>
						{maximized ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
					</IconButton>
				)}
			</header>
			{terminals.isError && <div className="px-4 py-3 text-[13px] text-danger">加载终端失败：{terminals.error.message}</div>}
			{terminals.isSuccess && !selected && (
				<div className="min-h-0 flex-1">
					<CenteredMessage title="暂无终端" detail="AI 成员打开的终端将显示在此处，也可点击「＋」自行新建" />
				</div>
			)}
			{/* 一个标签出错只换掉它的内容，标签栏还在：能切到别的、把它关掉。打开的标签记在浏览器里，整个工作台一起坏的话刷新后还是坏的。 */}
			{selected && (
				<ErrorBoundary key={selected.key} title="该标签页出错" action={{ label: '关闭该标签页', onClick: () => close(selected) }} className="min-h-0 flex-1">
					{selected.kind === 'terminal' && <TerminalDetail terminal={selected.terminal} memberById={memberById} />}
					{selected.kind === 'file' && <FileView path={selected.path} />}
					{selected.kind === 'tasks' && <TasksView memberId={selected.memberId} />}
					{selected.kind === 'git' && <GitView root={selected.root} />}
				</ErrorBoundary>
			)}
			{creating && <NewTerminalDialog onClose={() => setCreating(false)} onCreated={id => select(terminalTab(id))} />}
			{closing && <CloseTerminal terminal={closing} onDone={() => setClosing(undefined)} />}
		</div>
	);
}

/** 下拉里的终端：起了名字的写名字，后面跟灰色的 ID；头像和成员名挨着，免得把终端 ID 看成成员的；末尾是起始目录的最后一级。 */
function TerminalMenuLabel({ terminal, creator, outputting, name }: { terminal: ITerminalInfo; creator: IMember | undefined; outputting: boolean; name: string | undefined }) {
	const mine = terminal.status !== 'exited' && terminal.controller === 'user' && 'text-accent';
	return (
		<>
			{name
				? <><span className={clsx('max-w-40 truncate', mine)}>{name}</span><span className="shrink-0 font-mono text-xs font-normal text-fg-3">{terminal.terminalId}</span></>
				: <span className={clsx('shrink-0 font-mono text-xs', mine)}>{terminal.terminalId}</span>}
			{outputting && <OutputDot />}
			{terminal.createdBy && (
				<span className="flex min-w-0 items-center gap-1.5">
					<Avatar member={creator} size={14} className={clsx(terminal.status === 'exited' && 'opacity-60')} />
					<span className="max-w-32 truncate">{creator?.name ?? '未知成员'}</span>
				</span>
			)}
			<span className="ml-auto max-w-40 truncate pl-3 text-xs font-normal text-fg-3" title={terminal.cwd}>{fileName(terminal.cwd)}</span>
		</>
	);
}

/** 下拉里的文件：文件名，末尾是所在目录的最后一级。 */
function FileMenuLabel({ path }: { path: string }) {
	return (
		<>
			<FileText size={14} className="shrink-0 text-fg-3" />
			<span className="max-w-48 truncate">{fileName(path)}</span>
			<span className="ml-auto max-w-40 truncate pl-3 text-xs font-normal text-fg-3" title={path}>{fileName(directoryOf(path))}</span>
		</>
	);
}

/** Git 标签：Git 图标和「Git · 仓库根目录的目录名」。 */
function GitTabLabel({ root }: { root: string }) {
	return (
		<>
			<GitBranch size={14} className="shrink-0 text-fg-3" />
			<span className="shrink-0">Git ·</span>
			<span className="max-w-32 truncate">{fileName(root)}</span>
		</>
	);
}

/** 下拉里的 Git 标签：和标签上一样，末尾是仓库所在目录的最后一级。 */
function GitMenuLabel({ root }: { root: string }) {
	return (
		<>
			<GitTabLabel root={root} />
			<span className="ml-auto max-w-40 truncate pl-3 text-xs font-normal text-fg-3" title={root}>{fileName(directoryOf(root))}</span>
		</>
	);
}

/**
 * 后台任务标签：成员的小头像和「后台任务 · 名字」，只有头像时颜色相近、同姓的成员容易认错；名字太长截断，悬停看全名。
 * 有运行中的任务时转圈。
 */
function TasksLabel({ memberId, member }: { memberId: string; member: IMember | undefined }) {
	const running = (useTasks(memberId).data ?? []).some(task => task.status === 'running');
	return (
		<>
			<Avatar member={member} size={14} />
			<span className="shrink-0">后台任务 ·</span>
			<span className="max-w-28 truncate" title={member?.name}>{member?.name ?? '未知成员'}</span>
			{running && <LoaderCircle size={12} className="shrink-0 animate-spin text-accent" aria-label="有运行中的任务" />}
		</>
	);
}

/** 拖过的在前、按拖的顺序；没拖过的按新建、打开的先后排在后面。 */
function sortItems(terminals: readonly ITerminalInfo[], files: readonly IOpenFile[], taskLists: readonly IOpenTaskList[], repositories: readonly IOpenRepository[], order: readonly string[]): Item[] {
	const items: Item[] = [
		...terminals.map(terminal => ({ kind: 'terminal' as const, key: terminalTab(terminal.terminalId), addedAt: terminal.createdAt, terminal })),
		...files.map(file => ({ kind: 'file' as const, key: fileTab(file.path), addedAt: file.openedAt, path: file.path })),
		...taskLists.map(list => ({ kind: 'tasks' as const, key: tasksTab(list.memberId), addedAt: list.openedAt, memberId: list.memberId })),
		...repositories.map(repository => ({ kind: 'git' as const, key: gitTab(repository.root), addedAt: repository.openedAt, root: repository.root })),
	];
	const position = new Map(order.map((key, index) => [key, index]));
	return items.sort((left, right) => {
		const a = position.get(left.key) ?? Infinity;
		const b = position.get(right.key) ?? Infinity;
		return a !== b ? a - b : left.addedAt - right.addedAt;
	});
}

function Tabs({ items, selectedKey, memberById, names, onCloseExited, onSelect, onMove, onClose }: {
	items: readonly Item[];
	selectedKey: string | undefined;
	memberById: Map<string, IMember>;
	names: Readonly<Record<string, string>>;
	/** 有已退出的终端时才有。 */
	onCloseExited: (() => void) | undefined;
	onSelect: (key: string) => void;
	onMove: (key: string, beforeKey: string | undefined) => void;
	onClose: (item: Item) => void;
}) {
	const unseen = useUnseenTerminals(state => state.unseen);
	const outputting = useOutputtingTerminals(state => state.ids);
	const [dragging, setDragging] = useState<string>();
	const [dropBefore, setDropBefore] = useState<string | null>();
	const [menu, setMenu] = useState<{ point: IPoint; item: Item }>();
	const [renaming, setRenaming] = useState<string>();
	// 拖到某个标签的左半边放在它前面，右半边放在它后面。
	const onDragOver = (event: DragEvent<HTMLElement>, index: number) => {
		if (!dragging) return;
		event.preventDefault();
		const rect = event.currentTarget.getBoundingClientRect();
		const after = event.clientX > rect.left + rect.width / 2;
		setDropBefore(after ? items[index + 1]?.key ?? null : items[index]!.key);
	};
	const reset = () => {
		setDragging(undefined);
		setDropBefore(undefined);
	};
	const { ref, thumb } = useTabScroll(selectedKey, items.length);
	const menuPath = menu?.item.kind === 'file' ? menu.item.path : menu?.item.kind === 'git' ? menu.item.root : undefined;
	return (
		<div className="relative flex min-w-0 flex-1 items-center">
			{/* 只表示左右还有多少，不能拖：盖在标签下面的空白上，不占高度，出现、消失时标签不动。 */}
			{thumb && (
				<div className="pointer-events-none absolute inset-x-0 top-full mt-0.5 h-[3px] rounded-full bg-hover">
					<div className="absolute inset-y-0 rounded-full bg-line-strong" style={{ left: thumb.left, width: thumb.width }} />
				</div>
			)}
			<div ref={ref} role="tablist" className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]">
				{items.map((item, index) => (
					<Tab
						key={item.key}
						item={item}
						creator={item.kind === 'terminal' && item.terminal.createdBy ? memberById.get(item.terminal.createdBy) : item.kind === 'tasks' ? memberById.get(item.memberId) : undefined}
						selected={item.key === selectedKey}
						unseen={item.kind === 'terminal' && unseen.has(item.terminal.terminalId)}
						outputting={item.kind === 'terminal' && isOutputting(item.terminal, outputting)}
						name={item.kind === 'terminal' ? names[item.terminal.terminalId] : undefined}
						renaming={renaming === item.key}
						onRename={() => setRenaming(item.key)}
						onRenamed={() => setRenaming(undefined)}
						dropMark={dragging !== undefined && dropBefore === item.key ? 'before' : dragging !== undefined && dropBefore === null && index === items.length - 1 ? 'after' : undefined}
						onSelect={() => onSelect(item.key)}
						onClose={() => onClose(item)}
						onMenu={point => setMenu({ point, item })}
						onDragStart={event => {
							event.dataTransfer.effectAllowed = 'move';
							event.dataTransfer.setData('text/plain', item.key);
							setDragging(item.key);
						}}
						onDragOver={event => onDragOver(event, index)}
						onDrop={event => {
							event.preventDefault();
							if (dragging && dropBefore !== undefined) onMove(dragging, dropBefore ?? undefined);
							reset();
						}}
						// 没放在标签上（拖到别处或按了 Esc）时不移动。
						onDragEnd={reset}
					/>
				))}
				<PointMenu point={menu?.point} onClose={() => setMenu(undefined)}>
					{menuPath !== undefined
						? <MenuItem onSelect={() => void copyText(menuPath)}><Copy size={15} />复制路径</MenuItem>
						: menu?.item.kind === 'tasks' ? null : <>
							<MenuItem onSelect={() => menu && setRenaming(menu.item.key)}><Pencil size={15} />重命名</MenuItem>
							<MenuItem onSelect={() => menu?.item.kind === 'terminal' && void copyText(menu.item.terminal.terminalId)}><Copy size={15} />复制终端 ID</MenuItem>
						</>}
					<MenuItem className="text-danger" onSelect={() => menu && onClose(menu.item)}><X size={15} />关闭</MenuItem>
					{menu?.item.kind === 'terminal' && onCloseExited && <MenuItem onSelect={onCloseExited}><X size={15} />关闭所有已退出的终端</MenuItem>}
				</PointMenu>
			</div>
		</div>
	);
}

/** 滑块最短多宽，标签很多时也看得见。 */
const MIN_THUMB_PX = 24;

interface IThumb {
	readonly left: number;
	readonly width: number;
}

/**
 * 标签放不下时：浏览器自带的滚动条占高度，不用，另画一条只表示位置的细滚动条（thumb 是滑块的位置，放得下时是 undefined）；
 * 滚轮横向滚动；选中的标签滚进可见范围。
 */
function useTabScroll(selectedKey: string | undefined, count: number): { ref: RefObject<HTMLDivElement | null>; thumb: IThumb | undefined } {
	const ref = useRef<HTMLDivElement>(null);
	const [thumb, setThumb] = useState<IThumb>();

	useEffect(() => {
		const element = ref.current;
		if (!element) return;
		const update = () => {
			const { scrollLeft, clientWidth, scrollWidth } = element;
			// 缩放页面时宽度可能是小数，差 1px 以内算放得下。
			if (scrollWidth - clientWidth <= 1) {
				setThumb(undefined);
				return;
			}
			const width = Math.max(MIN_THUMB_PX, clientWidth * clientWidth / scrollWidth);
			const left = Math.round(scrollLeft / (scrollWidth - clientWidth) * (clientWidth - width));
			setThumb(previous => previous?.left === left && previous.width === width ? previous : { left, width });
		};
		// 竖着滚的滚轮也拿来横向滚；触控板横扫浏览器自己会滚。要拦下默认行为，不能用 React 的 onWheel（它是被动的）。
		const onWheel = (event: WheelEvent) => {
			if (event.deltaY === 0 || Math.abs(event.deltaX) > Math.abs(event.deltaY) || element.scrollWidth <= element.clientWidth) return;
			event.preventDefault();
			element.scrollLeft += event.deltaY;
		};
		update();
		element.addEventListener('scroll', update, { passive: true });
		element.addEventListener('wheel', onWheel, { passive: false });
		const observer = new ResizeObserver(update);
		observer.observe(element);
		return () => {
			element.removeEventListener('scroll', update);
			element.removeEventListener('wheel', onWheel);
			observer.disconnect();
		};
	}, []);

	// 标签增减时宽度变了，容器大小不一定变，也要重算；选中的标签换了时滚进可见范围。
	useEffect(() => {
		const element = ref.current;
		if (!element) return;
		element.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
		element.dispatchEvent(new Event('scroll'));
	}, [selectedKey, count]);

	return { ref, thumb };
}

/** 一个标签：点击选中，末尾的「×」关闭（选中的一直显示，别的悬停时显示，不显示时也占着位置，标签宽度不跳）。 */
function Tab({ item, creator, selected, unseen, outputting, name, renaming, onRename, onRenamed, dropMark, onSelect, onClose, onMenu, onDragStart, onDragOver, onDrop, onDragEnd }: {
	item: Item;
	creator: IMember | undefined;
	selected: boolean;
	unseen: boolean;
	outputting: boolean;
	name: string | undefined;
	renaming: boolean;
	onRename: () => void;
	onRenamed: () => void;
	dropMark: 'before' | 'after' | undefined;
	onSelect: () => void;
	onClose: () => void;
	onMenu: (point: IPoint) => void;
	onDragStart: (event: DragEvent<HTMLElement>) => void;
	onDragOver: (event: DragEvent<HTMLElement>) => void;
	onDrop: (event: DragEvent<HTMLElement>) => void;
	onDragEnd: () => void;
}) {
	const trigger = useMenuTrigger(onMenu);
	const flash = useTabFlash(state => state.key === item.key ? state.count : 0);
	const terminal = item.kind === 'terminal' ? item.terminal : undefined;
	const exited = terminal?.status === 'exited';
	const mine = !!terminal && !exited && terminal.controller === 'user';
	const closeLabel = terminal ? '关闭终端' : item.kind === 'file' ? '关闭文件' : item.kind === 'git' ? '关闭 Git' : '关闭后台任务';
	return (
		<div
			draggable={!renaming}
			title={terminal ? `${name ? `${terminal.terminalId}\n` : ''}${terminal.cwd}\n${terminal.title} · ${terminalStatus(terminal)}` : item.kind === 'file' ? item.path : item.kind === 'git' ? `Git 仓库：${item.root}` : `${creator?.name ?? '未知成员'}的后台任务`}
			onDragStart={onDragStart}
			onDragOver={onDragOver}
			onDrop={onDrop}
			onDragEnd={onDragEnd}
			{...trigger}
			className={clsx(
				'group/tab relative flex h-7 shrink-0 items-center rounded-md text-[13px] transition-colors',
				selected ? 'bg-selected' : 'hover:bg-hover',
				exited ? 'text-fg-3' : mine ? 'text-accent' : 'text-fg-2',
				selected && !exited && !mine && 'text-fg',
			)}
		>
			{dropMark && <span className={clsx('absolute inset-y-1 w-0.5 rounded bg-accent', dropMark === 'before' ? '-left-px' : '-right-px')} />}
			{/* 刚从链接打开时闪一下；按次数换 key，连着点也重新闪。 */}
			{flash > 0 && <span key={flash} className="tab-flash pointer-events-none absolute inset-0 rounded-md" />}
			{terminal && renaming && <RenameInput terminal={terminal} name={name} onDone={onRenamed} />}
			<button type="button" role="tab" aria-selected={selected} onClick={onSelect} onDoubleClick={terminal && onRename} className={clsx('flex h-full min-w-0 items-center gap-1.5 pl-2 pr-1', renaming && 'hidden')}>
				{terminal ? <TerminalTabLabel terminal={terminal} creator={creator} name={name} /> : item.kind === 'file' ? (
					<>
						<FileText size={14} className="shrink-0 text-fg-3" />
						<span className="max-w-40 truncate">{fileName(item.path)}</span>
					</>
				) : item.kind === 'git' ? <GitTabLabel root={item.root} /> : item.kind === 'tasks' && <TasksLabel memberId={item.memberId} member={creator} />}
				{outputting && <OutputDot />}
				{unseen && <span className="size-1.5 shrink-0 rounded-full bg-accent" aria-label="新终端" />}
				{!unseen && terminal && !exited && terminal.takeoverRequests.length > 0 && <span className="size-1.5 shrink-0 rounded-full bg-accent" aria-label="请你接管" />}
			</button>
			<button
				type="button"
				aria-label={closeLabel}
				title={closeLabel}
				onClick={onClose}
				className={clsx(
					'mr-1 flex size-5 shrink-0 items-center justify-center rounded text-fg-3 hover:bg-line hover:text-fg focus-visible:visible',
					!selected && 'invisible group-hover/tab:visible',
				)}
			>
				<X size={13} />
			</button>
		</div>
	);
}

/** 已退出的不算在输出：退出前最后那点输出还没过安静时间。 */
function isOutputting(terminal: ITerminalInfo, outputting: ReadonlySet<string>): boolean {
	return terminal.status !== 'exited' && outputting.has(terminal.terminalId);
}

/** 终端正在输出：绿色小圆点，轻轻闪。 */
function OutputDot() {
	return <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-success" aria-label="正在输出" title="正在输出" />;
}

/** 标签上改终端的名字：回车或点别处保存，Esc 取消；清空是去掉名字，标签又写终端 ID。 */
function RenameInput({ terminal, name, onDone }: { terminal: ITerminalInfo; name: string | undefined; onDone: () => void }) {
	const [value, setValue] = useState(name ?? '');
	const input = useRef<HTMLInputElement>(null);
	const done = useRef(false);
	const finish = (save: boolean) => {
		if (done.current) return;
		done.current = true;
		if (save) renameTerminal(terminal.terminalId, value);
		onDone();
	};
	useEffect(() => {
		input.current?.focus();
		input.current?.select();
	}, []);
	return (
		<input
			ref={input}
			value={value}
			placeholder={terminal.terminalId}
			aria-label="终端名称"
			onChange={event => setValue(event.target.value)}
			onKeyDown={event => {
				event.stopPropagation();
				if (event.key === 'Enter') finish(true);
				if (event.key === 'Escape') finish(false);
			}}
			onBlur={() => finish(true)}
			className="mx-1 h-6 w-36 rounded border border-accent bg-page px-1.5 text-[13px] text-fg outline-none"
		/>
	);
}
