import { create } from 'zustand';
import { usePreferences } from '../stores.ts';

/**
 * 工作台的标签：终端、文件、Git、后台任务。打开哪些、什么顺序记在浏览器里（stores.ts）；
 * 看到的位置、重新读的次数、没看过的终端只在内存里。打开标签时视角页里换掉时间线。
 */

/** 终端标签的标识：按终端 ID。 */
export function terminalTab(terminalId: string): string {
	return `terminal:${terminalId}`;
}

/** 打开工作台，给了终端时切到它，它的标签闪一下。 */
export function openTerminal(terminalId?: string): void {
	usePreferences.getState().set({ workbenchOpen: true, timelineOpen: false, ...(terminalId ? { workbenchTab: terminalTab(terminalId) } : {}) });
	if (terminalId) flashTab(terminalTab(terminalId));
}

/** 标签闪多久（毫秒），和 index.css 里 .tab-flash 的动画一样长。 */
const TAB_FLASH_MS = 1200;

/**
 * 刚从链接打开的标签：闪一下，告诉使用者点到了哪里。终端本来就开着时点了没有别的变化，不闪会以为没点上。
 * count 每次加一：连着点同一个也重新闪。闪完清掉，免得工作台收起再展开时又闪一次。
 */
export const useTabFlash = create<{ key: string | undefined; count: number }>(() => ({ key: undefined, count: 0 }));

function flashTab(key: string): void {
	const count = useTabFlash.getState().count + 1;
	useTabFlash.setState({ key, count });
	setTimeout(() => {
		if (useTabFlash.getState().count === count) useTabFlash.setState({ key: undefined });
	}, TAB_FLASH_MS);
}

/** 给终端起名字；空的是去掉名字。 */
export function renameTerminal(terminalId: string, name: string): void {
	const { terminalNames, set } = usePreferences.getState();
	const { [terminalId]: _, ...rest } = terminalNames;
	set({ terminalNames: name.trim() ? { ...rest, [terminalId]: name.trim() } : rest });
}

/**
 * AI 新开、使用者还没看过的终端。打开页面时已有的都算看过；之后出现的、AI 建的，在工作台里看到之前都算没看过。
 */
export const useUnseenTerminals = create<{ known: ReadonlySet<string> | undefined; unseen: ReadonlySet<string> }>(() => ({ known: undefined, unseen: new Set() }));

export function markTerminalSeen(terminalId: string): void {
	const { unseen } = useUnseenTerminals.getState();
	if (!unseen.has(terminalId)) return;
	const next = new Set(unseen);
	next.delete(terminalId);
	useUnseenTerminals.setState({ unseen: next });
}

/** 文件标签的标识：按路径。 */
export function fileTab(path: string): string {
	return `file:${path}`;
}

/** 在工作台里打开文件：已经开着时切过去并重新读，没开时在最后加一个标签。 */
export function openFile(path: string): void {
	const { openFiles, set } = usePreferences.getState();
	set({
		workbenchOpen: true, timelineOpen: false, workbenchTab: fileTab(path),
		...(openFiles.some(file => file.path === path) ? {} : { openFiles: [...openFiles, { path, openedAt: Date.now() }] }),
	});
	reloadFile(path);
}

/** 关掉工作台里的文件，忘掉看到的位置。 */
export function closeFile(path: string): void {
	const { openFiles, workbenchOrder, set } = usePreferences.getState();
	set({ openFiles: openFiles.filter(file => file.path !== path), workbenchOrder: workbenchOrder.filter(key => key !== fileTab(path)) });
	fileViews.delete(path);
}

/** 每个文件被要求重新读了几次（点了链接、点了刷新）：文件预览按它变了就重新取。 */
export const useFileReloads = create<Record<string, number>>(() => ({}));

export function reloadFile(path: string): void {
	useFileReloads.setState(state => ({ [path]: (state[path] ?? 0) + 1 }));
}

/** 一个文件标签看到的位置和「源码」切换。 */
export interface IFileViewState {
	readonly scrollTop: number;
	readonly source: boolean;
}

/** 各个文件标签看到的位置，按路径记，只在内存里：切走再回来、收起再展开工作台都停在原处，刷新页面后从头开始。 */
const fileViews = new Map<string, IFileViewState>();

export function fileViewState(path: string): IFileViewState {
	return fileViews.get(path) ?? { scrollTop: 0, source: false };
}

export function saveFileViewState(path: string, patch: Partial<IFileViewState>): void {
	fileViews.set(path, { ...fileViewState(path), ...patch });
}

/** Git 标签的标识：每个仓库一个，按根目录。 */
export function gitTab(root: string): string {
	return `git:${root}`;
}

/** 在工作台打开仓库的 Git 标签：已经开着时切过去并重新读，没开时在最后加一个标签。 */
export function openGit(root: string): void {
	const { openRepositories, set } = usePreferences.getState();
	set({
		workbenchOpen: true, timelineOpen: false, workbenchTab: gitTab(root),
		...(openRepositories.some(repository => repository.root === root) ? {} : { openRepositories: [...openRepositories, { root, openedAt: Date.now() }] }),
	});
	reloadGit(root);
}

/** 关掉 Git 标签，忘掉看到的页和展开的行。 */
export function closeGit(root: string): void {
	const { openRepositories, workbenchOrder, set } = usePreferences.getState();
	set({ openRepositories: openRepositories.filter(repository => repository.root !== root), workbenchOrder: workbenchOrder.filter(key => key !== gitTab(root)) });
	gitViews.delete(root);
}

/** 每个仓库被要求重新读了几次（又从目录卡片打开、点了刷新）。 */
export const useGitReloads = create<Record<string, number>>(() => ({}));

export function reloadGit(root: string): void {
	useGitReloads.setState(state => ({ [root]: (state[root] ?? 0) + 1 }));
}

/** 一个 Git 标签看的是改动还是历史，展开了哪些行。 */
export interface IGitViewState {
	readonly page: 'changes' | 'history';
	readonly expanded: ReadonlySet<string>;
}

/** 各个 Git 标签的样子，按仓库记，只在内存里：切走再回来还是原样，刷新页面后从「改动」开始。 */
const gitViews = new Map<string, IGitViewState>();

export function gitViewState(root: string): IGitViewState {
	return gitViews.get(root) ?? { page: 'changes', expanded: new Set() };
}

export function saveGitViewState(root: string, patch: Partial<IGitViewState>): void {
	gitViews.set(root, { ...gitViewState(root), ...patch });
}

/** 后台任务标签的标识：每个成员一个。 */
export function tasksTab(memberId: string): string {
	return `tasks:${memberId}`;
}

/** 要在后台任务标签里展开、滚到的任务；nonce 每次打开都变，同一个任务再点一次也会再滚过去。 */
export const useTaskFocus = create<{ taskId: string | undefined; nonce: number }>(() => ({ taskId: undefined, nonce: 0 }));

/** 在工作台打开成员的后台任务标签，已经开着时切过去；给了任务时展开它并滚过去。 */
export function openTasks(memberId: string, taskId?: string): void {
	const { openTaskLists, set } = usePreferences.getState();
	set({
		workbenchOpen: true, timelineOpen: false, workbenchTab: tasksTab(memberId),
		...(openTaskLists.some(list => list.memberId === memberId) ? {} : { openTaskLists: [...openTaskLists, { memberId, openedAt: Date.now() }] }),
	});
	if (taskId) useTaskFocus.setState(state => ({ taskId, nonce: state.nonce + 1 }));
}

export function closeTasks(memberId: string): void {
	const { openTaskLists, workbenchOrder, set } = usePreferences.getState();
	set({ openTaskLists: openTaskLists.filter(list => list.memberId !== memberId), workbenchOrder: workbenchOrder.filter(key => key !== tasksTab(memberId)) });
}
