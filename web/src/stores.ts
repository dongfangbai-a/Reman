import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { defaultTerminalPanelWidth } from './terminals/font.ts';

export type Theme = 'system' | 'light' | 'dark';
/** 消息通知：关闭、私聊和 @、全部。 */
export type MessageNotifications = 'off' | 'mentions' | 'all';
/** 成员页的类型筛选。 */
export type MemberFilter = 'all' | 'ai' | 'human';
/** 成员页的排序：按名字，最新创建（新建的在前），最早创建（先建的在前）。 */
export type MemberSort = 'name' | 'newest' | 'oldest';

/** 一个对话的草稿：文字和点名。附件不保存。 */
interface IDraft {
	readonly text: string;
	readonly mentions: readonly string[] | 'all';
}

/** 工作台里开着的一个文件。 */
export interface IOpenFile {
	readonly path: string;
	readonly openedAt: number;
}

export interface IOpenTaskList {
	readonly memberId: string;
	readonly openedAt: number;
}

/** 工作台里开着的一个 Git 仓库标签：仓库的根目录。 */
export interface IOpenRepository {
	readonly root: string;
	readonly openedAt: number;
}

/** 概况栏里可以收起的栏。待处理不能收起：那是要你处理的事。 */
export type OverviewSection = 'plan' | 'reminders';

interface IPreferences {
	theme: Theme;
	/** 按「视角|对话标识」保存的草稿；时间线的按「timeline|成员 ID」。 */
	drafts: Record<string, IDraft>;
	/** 拖出来的列表栏宽度，各页共用。 */
	listWidth: number;
	listCollapsed: boolean;
	/** 功能区宽的那一栏（工作台，视角页里也放时间线）和概况栏：宽度、开没开。 */
	wideWidth: number;
	overviewWidth: number;
	workbenchOpen: boolean;
	/** 视角页里宽的那一栏换成时间线。 */
	timelineOpen: boolean;
	overviewOpen: boolean;
	/** 工作台最大化：中间隐藏，工作台占满中间和它自己那一栏。 */
	workbenchMaximized: boolean;
	/** 工作台选的标签（tabKey）。 */
	workbenchTab: string | undefined;
	/** 拖过的标签顺序（tabKey）；没拖过的按新建、打开的先后排在后面。 */
	workbenchOrder: readonly string[];
	/** 工作台里开着的文件和打开的时间。 */
	openFiles: readonly IOpenFile[];
	/** 工作台里开着的后台任务标签：哪个成员的、打开的时间。 */
	openTaskLists: readonly IOpenTaskList[];
	/** 工作台里开着的 Git 标签：哪个仓库、打开的时间。 */
	openRepositories: readonly IOpenRepository[];
	/** 你给终端起的名字，按终端 ID 记，只在这个浏览器里有效；终端没了就删掉。 */
	terminalNames: Readonly<Record<string, string>>;
	/** 上次用的视角。 */
	perspectiveId: string | undefined;
	/** 成员页上次的地址（首页或某个 AI 成员的时间线），从图标栏切回成员页时回到这里。 */
	membersPath: string | undefined;
	/** 每个视角上次打开的对话，按视角成员 ID 记「direct/成员ID」或「group/群聊ID」；回到这个视角的首页时去掉。 */
	perspectiveConversations: Readonly<Record<string, string>>;
	memberFilter: MemberFilter;
	memberSort: MemberSort;
	/** 折叠了的分组：分组 ID，「未分组」是 unsectioned。 */
	collapsedSections: readonly string[];
	/** 概况栏里收起了的栏：计划、定时。不分成员，换一个成员看时照旧。 */
	overviewCollapsed: readonly OverviewSection[];
	/** 成员页最底下的「已删除」展开了，默认收起。 */
	deletedOpen: boolean;
	/** 时间线里的过程默认展开。 */
	timelineExpandProcess: boolean;
	/** 有新的审批或接管请求时发系统通知。 */
	inboxNotifications: boolean;
	messageNotifications: MessageNotifications;
	/** AI 成员出错停止时发系统通知。 */
	failureNotifications: boolean;
	/** 要提醒的真人；没选过时是 undefined，只提醒第一个真人。 */
	notifyHumans: readonly string[] | undefined;
	set(change: Partial<Omit<IPreferences, 'set' | 'setDraft'>>): void;
	setDraft(key: string, draft: IDraft | undefined): void;
}

/** 记在浏览器里的偏好。 */
export const usePreferences = create<IPreferences>()(persist(set => ({
	theme: 'system',
	drafts: {},
	listWidth: 288,
	listCollapsed: false,
	wideWidth: defaultTerminalPanelWidth(),
	overviewWidth: 320,
	workbenchOpen: false,
	timelineOpen: false,
	overviewOpen: false,
	workbenchMaximized: false,
	workbenchTab: undefined,
	workbenchOrder: [],
	openFiles: [],
	openTaskLists: [],
	openRepositories: [],
	terminalNames: {},
	perspectiveId: undefined,
	membersPath: undefined,
	perspectiveConversations: {},
	memberFilter: 'all',
	memberSort: 'name',
	collapsedSections: [],
	overviewCollapsed: [],
	deletedOpen: false,
	timelineExpandProcess: false,
	inboxNotifications: false,
	messageNotifications: 'off',
	failureNotifications: false,
	notifyHumans: undefined,
	set: change => set(change),
	setDraft: (key, draft) => set(state => {
		const drafts = { ...state.drafts };
		if (draft && (draft.text.trim() || draft.mentions === 'all' || draft.mentions.length > 0)) drafts[key] = draft;
		else delete drafts[key];
		return { drafts };
	}),
}), { name: 'reman-web' }));

export function draftKey(perspectiveId: string, conversationKey: string): string {
	return `${perspectiveId}|${conversationKey}`;
}
