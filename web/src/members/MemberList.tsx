import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArchiveRestore, ArrowDownUp, Check, ChevronRight, CircleAlert, FolderPlus, Pause, Pencil, Play, Plus, Settings, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { useMatch, useNavigate } from 'react-router';
import { api } from '../api/client.ts';
import { useGroups, useMemberFolders } from '../api/directory.ts';
import { queryKeys } from '../api/keys.ts';
import { useMemberStates } from '../api/member.ts';
import { useMemberOverview, useMemberSections, useMembers } from '../api/queries.ts';
import type { IMemberFolderState, IMemberSection, IMember } from '../api/types.ts';
import { useSearchFocus } from '../chat/searchFocus.ts';
import { useInbox } from '../inbox/inbox.ts';
import { CollapseListButton } from '../layout/CollapseListButton.tsx';
import { HEADER_RIGHT } from '../layout/PanelToggles.tsx';
import { openMemberDialog } from '../layout/uiState.ts';
import { errorMessage } from '../lib/errors.ts';
import { useNotifyHumans } from '../perspective/notifyHumans.ts';
import { usePreferences, type MemberFilter, type MemberSort } from '../stores.ts';
import { IconButton } from '../ui/Button.tsx';
import { CopyMenuItems, memberReference } from '../ui/CopyMenuItems.tsx';
import { ConfirmDialog } from '../ui/Dialog.tsx';
import { MENU_ITEM_CLASS, MenuContent, MenuItem, MenuSeparator } from '../ui/Menu.tsx';
import { PointMenu, useMenuTrigger, type IPoint } from '../ui/PointMenu.tsx';
import { keywords, matchesAll, SearchBox } from '../ui/SearchBox.tsx';
import { DELETE_DETAIL, PURGE_DETAIL } from './aiForm.ts';
import { DeletedMemberRow, MemberRow } from './MemberRow.tsx';
import { SectionNameDialog } from './NewDialogs.tsx';

/** 「未分组」的折叠状态用这个标识记。 */
const UNSECTIONED = 'unsectioned';
const FILTERS: readonly [MemberFilter, string][] = [['all', '全部'], ['ai', 'AI'], ['human', '真人']];
const SORTS: readonly [MemberSort, string][] = [['name', '按名字'], ['newest', '最新创建'], ['oldest', '最早创建']];

/** 成员菜单针对的成员，以及在哪个分组里点的（多一项「从分组移除」）。 */
interface IMemberMenu {
	readonly point: IPoint;
	readonly member: IMember;
	readonly sectionId?: string;
}

/**
 * 成员页的列表栏：全部成员，按分组显示，已删除的 AI 成员放在最底下。
 * 搜索按名字、备注、分组名找，不分组、平铺显示。
 */
export function MemberList() {
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const members = useMembers();
	const overview = useMemberOverview();
	const sections = useMemberSections();
	const folders = useMemberFolders();
	const states = useMemberStates();
	const inbox = useInbox();
	const groups = useGroups();
	const notify = useNotifyHumans();
	const filter = usePreferences(state => state.memberFilter);
	const sort = usePreferences(state => state.memberSort);
	const collapsed = usePreferences(state => state.collapsedSections);
	const deletedOpen = usePreferences(state => state.deletedOpen);
	const set = usePreferences(state => state.set);
	const selectedId = useMatch('/members/:memberId')?.params.memberId;
	const [search, setSearch] = useState('');
	const words = keywords(search);
	const searching = words.length > 0;
	const input = useRef<HTMLInputElement>(null);
	const focusRequested = useSearchFocus(state => state.requested);
	useEffect(() => {
		if (!focusRequested) return;
		input.current?.focus();
		input.current?.select();
		useSearchFocus.getState().done();
	}, [focusRequested]);

	const [menu, setMenu] = useState<IMemberMenu>();
	const [sectionMenu, setSectionMenu] = useState<{ point: IPoint; section: IMemberSection }>();
	const [renaming, setRenaming] = useState<IMemberSection>();
	const [removingSection, setRemovingSection] = useState<IMemberSection>();
	const [confirm, setConfirm] = useState<{ action: 'delete' | 'purge'; member: IMember }>();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();

	const all = members.data ?? [];
	const sectionList = sections.data ?? [];
	const memberById = new Map(all.map(member => [member.memberId, member]));
	const groupById = new Map((groups.data ?? []).map(group => [group.groupId, group]));
	const folderByMember = new Map((folders.data?.folders ?? []).filter(folder => folder.memberId).map(folder => [folder.memberId!, folder]));
	const brokenFolders = (folders.data?.folders ?? []).filter(folder => !folder.memberId && folder.status === 'error');
	const pendingByMember = new Map<string, number>();
	for (const item of inbox.items) pendingByMember.set(item.memberId, (pendingByMember.get(item.memberId) ?? 0) + 1);
	const sectionsOf = (memberId: string) => sectionList.filter(section => section.memberIds.includes(memberId));
	const matches = (member: IMember) => matchesAll([member.name, member.description, ...sectionsOf(member.memberId).map(section => section.name)].join(' '), words);
	const ofType = (member: IMember) => filter === 'all' || member.type === filter;
	// 位置稳定：按名字或创建时间排，不会因为 AI 在运行就跳动。
	const compare = sort === 'name'
		? (left: IMember, right: IMember) => left.name.localeCompare(right.name, 'zh-CN')
		: sort === 'newest'
			? (left: IMember, right: IMember) => right.createdAt - left.createdAt
			: (left: IMember, right: IMember) => left.createdAt - right.createdAt;
	const alive = all.filter(member => !member.deleted && ofType(member)).sort(compare);
	// 已删除的按删除时间，最近的在前；彻底删除的不列。
	const deleted = all.filter(member => member.type === 'ai' && member.deleted && !member.purged && ofType(member) && (!searching || matches(member)))
		.sort((left, right) => (right.deletedAt ?? 0) - (left.deletedAt ?? 0));

	const run = async (work: () => Promise<unknown>) => {
		setBusy(true);
		setError(undefined);
		try {
			await work();
			return true;
		} catch (caught) {
			setError(errorMessage(caught));
			return false;
		} finally {
			setBusy(false);
		}
	};
	const saveSections = (next: IMemberSection[], request: () => Promise<unknown>) => {
		queryClient.setQueryData(queryKeys.memberSections, next);
		void run(request).then(() => queryClient.invalidateQueries({ queryKey: queryKeys.memberSections }));
	};
	const setInSection = (section: IMemberSection, memberId: string, inside: boolean) => {
		const memberIds = inside ? [...section.memberIds, memberId] : section.memberIds.filter(id => id !== memberId);
		saveSections(sectionList.map(item => item.sectionId === section.sectionId ? { ...item, memberIds } : item), () => api('PUT', `/v1/member-sections/${section.sectionId}`, { memberIds }));
	};
	const moveSection = (sectionId: string, beforeId: string | undefined) => {
		const moving = sectionList.find(section => section.sectionId === sectionId);
		if (!moving || sectionId === beforeId) return;
		const rest = sectionList.filter(section => section.sectionId !== sectionId);
		const index = beforeId === undefined ? rest.length : rest.findIndex(section => section.sectionId === beforeId);
		rest.splice(index < 0 ? rest.length : index, 0, moving);
		saveSections(rest, () => api('PUT', '/v1/member-section-order', { sectionIds: rest.map(section => section.sectionId) }));
	};
	const memberAction = (member: IMember, path: string) => void run(async () => {
		await api('POST', `/v1/members/${member.memberId}/${path}`);
		await queryClient.invalidateQueries({ queryKey: queryKeys.members });
	});
	const confirmAction = async () => {
		if (!confirm) return;
		const { action, member } = confirm;
		const done = await run(async () => {
			if (action === 'delete') await api('DELETE', `/v1/members/${member.memberId}`);
			else await api('POST', `/v1/members/${member.memberId}/purge`);
			await queryClient.invalidateQueries({ queryKey: queryKeys.members });
		});
		if (!done) return;
		setConfirm(undefined);
		if (action === 'purge' && selectedId === member.memberId) navigate('/');
	};

	const row = (member: IMember, sectionId?: string) => (
		<MemberRow
			key={`${sectionId ?? ''}:${member.memberId}`}
			member={member}
			overview={overview.data?.get(member.memberId)}
			state={states.data?.get(member.memberId)}
			pending={pendingByMember.get(member.memberId) ?? 0}
			folder={folderByMember.get(member.memberId)}
			notify={notify.has(member.memberId)}
			words={words}
			selected={member.memberId === selectedId}
			memberById={memberById}
			groupById={groupById}
			onMenu={point => setMenu({ point, member, sectionId })}
		/>
	);
	const toggleCollapsed = (key: string) => set({ collapsedSections: collapsed.includes(key) ? collapsed.filter(item => item !== key) : [...collapsed, key] });

	let body: ReactNode;
	if (searching) {
		const found = alive.filter(matches);
		body = found.length === 0 && deleted.length === 0
			? <div className="px-4 py-3 text-[13px] text-fg-3">无匹配的成员</div>
			: found.map(member => row(member));
	} else if (sectionList.length === 0) {
		body = alive.map(member => row(member));
	} else {
		const unsectioned = alive.filter(member => sectionsOf(member.memberId).length === 0);
		body = (
			<>
				<SectionList
					sections={sectionList}
					membersOf={section => alive.filter(member => section.memberIds.includes(member.memberId))}
					hideEmpty={filter !== 'all'}
					collapsed={collapsed}
					onToggle={toggleCollapsed}
					onMove={moveSection}
					onMenu={(point, section) => setSectionMenu({ point, section })}
					renderRow={row}
				/>
				{unsectioned.length > 0 && (
					<Section title="未分组" count={unsectioned.length} open={!collapsed.includes(UNSECTIONED)} onToggle={() => toggleCollapsed(UNSECTIONED)}>
						{unsectioned.map(member => row(member))}
					</Section>
				)}
			</>
		);
	}

	const menuMember = menu && (memberById.get(menu.member.memberId) ?? menu.member);
	const menuSection = menu?.sectionId ? sectionList.find(section => section.sectionId === menu.sectionId) : undefined;
	return (
		<aside className="flex min-h-0 w-full flex-1 flex-col border-r border-line bg-pane">
			<header className={clsx('flex h-12 shrink-0 items-center gap-1 border-b border-line pl-4', HEADER_RIGHT)}>
				<span className="flex-1 font-semibold">成员</span>
				<DropdownMenu.Root>
					<DropdownMenu.Trigger asChild>
						<IconButton label="新建"><Plus size={17} /></IconButton>
					</DropdownMenu.Trigger>
					<MenuContent align="end">
						<MenuItem onSelect={() => openMemberDialog({ kind: 'newAi' })}>新建 AI 成员</MenuItem>
						<MenuItem onSelect={() => openMemberDialog({ kind: 'newHuman' })}>新建真人</MenuItem>
						<MenuSeparator />
						<MenuItem onSelect={() => openMemberDialog({ kind: 'newSection' })}>新建分组</MenuItem>
					</MenuContent>
				</DropdownMenu.Root>
				<CollapseListButton />
			</header>
			<div className="shrink-0 px-3 pt-2">
				<SearchBox ref={input} value={search} onChange={setSearch} placeholder="搜索成员" />
			</div>
			<div className="flex shrink-0 items-center gap-1 px-3 pb-1 pt-1.5">
				<div className="flex flex-1 items-center gap-0.5 text-[13px]">
					{FILTERS.map(([value, label]) => (
						<button
							key={value}
							type="button"
							aria-pressed={filter === value}
							onClick={() => set({ memberFilter: value })}
							className={clsx('rounded-md px-2 py-0.5', filter === value ? 'bg-selected font-medium text-fg' : 'text-fg-2 hover:bg-hover')}
						>
							{label}
						</button>
					))}
				</div>
				<DropdownMenu.Root>
					<DropdownMenu.Trigger asChild>
						<IconButton label="排序" className="size-7"><ArrowDownUp size={15} /></IconButton>
					</DropdownMenu.Trigger>
					<MenuContent align="end">
						{SORTS.map(([value, label]) => (
							<MenuItem key={value} onSelect={() => set({ memberSort: value })}>
								<span className="flex-1">{label}</span>
								{sort === value && <Check size={14} className="text-accent" />}
							</MenuItem>
						))}
					</MenuContent>
				</DropdownMenu.Root>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto pb-2">
				{members.isError && <div className="px-4 py-3 text-[13px] text-danger">加载失败：{members.error.message}</div>}
				{error && !confirm && (
					<div className="mx-3 mb-1 flex items-start gap-1.5 rounded-md bg-danger-soft px-2.5 py-1.5 text-[13px] text-danger">
						<span className="min-w-0 flex-1">操作失败：{error}</span>
						<button type="button" aria-label="知道了" onClick={() => setError(undefined)}><X size={14} /></button>
					</div>
				)}
				{!searching && brokenFolders.length > 0 && <BrokenFolders folders={brokenFolders} />}
				{body}
				{deleted.length > 0 && (
					<Section title="已删除" count={deleted.length} open={searching || deletedOpen} onToggle={() => set({ deletedOpen: !deletedOpen })}>
						{deleted.map(member => (
							<DeletedMemberRow key={member.memberId} member={member} words={words} selected={member.memberId === selectedId} onMenu={point => setMenu({ point, member })} />
						))}
					</Section>
				)}
			</div>

			<PointMenu point={menu?.point} onClose={() => setMenu(undefined)}>
				{menuMember && <CopyMenuItems reference={memberReference(menuMember)} id={menuMember.memberId} />}
				{menuMember && <MenuSeparator />}
				{menuMember && !menuMember.deleted && (
					<>
						<MenuItem onSelect={() => openMemberDialog({ kind: 'settings', memberId: menuMember.memberId })}><Settings size={15} />设置</MenuItem>
						<DropdownMenu.Sub>
							<DropdownMenu.SubTrigger className={clsx(MENU_ITEM_CLASS, 'data-[state=open]:bg-hover')}>
								<FolderPlus size={15} /><span className="flex-1">添加到分组</span><ChevronRight size={14} className="text-fg-3" />
							</DropdownMenu.SubTrigger>
							<DropdownMenu.Portal>
								<DropdownMenu.SubContent sideOffset={4} className="menu-panel max-h-[60vh] min-w-44">
									{sectionList.map(section => {
										const inside = section.memberIds.includes(menuMember.memberId);
										return (
											<DropdownMenu.CheckboxItem
												key={section.sectionId}
												checked={inside}
												onCheckedChange={checked => setInSection(section, menuMember.memberId, checked)}
												onSelect={event => event.preventDefault()}
												className={MENU_ITEM_CLASS}
											>
												<span className="flex size-4 shrink-0 items-center justify-center"><DropdownMenu.ItemIndicator><Check size={14} className="text-accent" /></DropdownMenu.ItemIndicator></span>
												<span className="truncate">{section.name}</span>
											</DropdownMenu.CheckboxItem>
										);
									})}
									{sectionList.length > 0 && <MenuSeparator />}
									<MenuItem onSelect={() => openMemberDialog({ kind: 'newSection', addMemberId: menuMember.memberId })}><span className="size-4" />新建分组…</MenuItem>
								</DropdownMenu.SubContent>
							</DropdownMenu.Portal>
						</DropdownMenu.Sub>
						{menuSection && (
							<MenuItem onSelect={() => setInSection(menuSection, menuMember.memberId, false)}><X size={15} />从「{menuSection.name}」移除</MenuItem>
						)}
						{menuMember.type === 'ai' && (
							<>
								<MenuSeparator />
								{menuMember.paused
									? <MenuItem onSelect={() => memberAction(menuMember, 'resume')}><Play size={15} />恢复运行</MenuItem>
									: <MenuItem onSelect={() => memberAction(menuMember, 'pause')}><Pause size={15} />暂停</MenuItem>}
								<MenuItem className="text-danger" onSelect={() => setConfirm({ action: 'delete', member: menuMember })}><Trash2 size={15} />删除</MenuItem>
							</>
						)}
					</>
				)}
				{menuMember?.deleted && (
					<>
						<MenuItem onSelect={() => memberAction(menuMember, 'restore')}><ArchiveRestore size={15} />恢复</MenuItem>
						<MenuItem className="text-danger" onSelect={() => setConfirm({ action: 'purge', member: menuMember })}><Trash2 size={15} />彻底删除</MenuItem>
					</>
				)}
			</PointMenu>
			<PointMenu point={sectionMenu?.point} onClose={() => setSectionMenu(undefined)}>
				{sectionMenu && (
					<>
						<MenuItem onSelect={() => setRenaming(sectionMenu.section)}><Pencil size={15} />重命名</MenuItem>
						<MenuItem className="text-danger" onSelect={() => setRemovingSection(sectionMenu.section)}><Trash2 size={15} />删除分组</MenuItem>
					</>
				)}
			</PointMenu>

			<SectionNameDialog
				open={!!renaming}
				onOpenChange={open => !open && setRenaming(undefined)}
				title="重命名分组"
				initial={renaming?.name ?? ''}
				submitLabel="保存"
				onSubmit={async name => {
					await api('PUT', `/v1/member-sections/${renaming!.sectionId}`, { name });
					await queryClient.invalidateQueries({ queryKey: queryKeys.memberSections });
				}}
			/>
			<ConfirmDialog
				open={!!removingSection}
				onOpenChange={open => !open && setRemovingSection(undefined)}
				title={`删除分组「${removingSection?.name ?? ''}」？`}
				detail="分组中的成员不受影响。"
				confirmLabel="删除"
				busy={busy}
				onConfirm={() => {
					const section = removingSection!;
					setRemovingSection(undefined);
					saveSections(sectionList.filter(item => item.sectionId !== section.sectionId), () => api('DELETE', `/v1/member-sections/${section.sectionId}`));
				}}
			/>
			<ConfirmDialog
				open={!!confirm}
				onOpenChange={open => {
					if (open) return;
					setConfirm(undefined);
					setError(undefined);
				}}
				title={confirm?.action === 'purge' ? `彻底删除 ${confirm.member.name}？` : `删除 ${confirm?.member.name ?? ''}？`}
				detail={confirm?.action === 'purge' ? PURGE_DETAIL : DELETE_DETAIL}
				confirmLabel={confirm?.action === 'purge' ? '彻底删除' : '删除'}
				busy={busy}
				error={confirm ? error : undefined}
				onConfirm={() => void confirmAction()}
			/>
		</aside>
	);
}

/** 分组：标题可以折叠、右键改名删除、拖动调整先后。 */
function SectionList({ sections, membersOf, hideEmpty, collapsed, onToggle, onMove, onMenu, renderRow }: {
	sections: readonly IMemberSection[];
	membersOf: (section: IMemberSection) => IMember[];
	/** 按类型筛选时，空的分组不显示。 */
	hideEmpty: boolean;
	collapsed: readonly string[];
	onToggle: (sectionId: string) => void;
	onMove: (sectionId: string, beforeId: string | undefined) => void;
	onMenu: (point: IPoint, section: IMemberSection) => void;
	renderRow: (member: IMember, sectionId: string) => ReactNode;
}) {
	const [dragging, setDragging] = useState<string>();
	/** 放在哪个分组前面；null 是放到最后。 */
	const [dropBefore, setDropBefore] = useState<string | null>();
	const shown = sections.map(section => ({ section, members: membersOf(section) })).filter(item => !hideEmpty || item.members.length > 0);
	const onDragOver = (event: DragEvent<HTMLElement>, index: number) => {
		if (!dragging) return;
		event.preventDefault();
		const rect = event.currentTarget.getBoundingClientRect();
		const after = event.clientY > rect.top + rect.height / 2;
		setDropBefore(after ? shown[index + 1]?.section.sectionId ?? null : shown[index]!.section.sectionId);
	};
	const reset = () => {
		setDragging(undefined);
		setDropBefore(undefined);
	};
	return shown.map(({ section, members }, index) => (
		<Section
			key={section.sectionId}
			title={section.name}
			count={members.length}
			open={!collapsed.includes(section.sectionId)}
			onToggle={() => onToggle(section.sectionId)}
			onMenu={point => onMenu(point, section)}
			drag={{
				dropMark: dragging === undefined ? undefined : dropBefore === section.sectionId ? 'before' : dropBefore === null && index === shown.length - 1 ? 'after' : undefined,
				onDragStart: event => {
					event.dataTransfer.effectAllowed = 'move';
					event.dataTransfer.setData('text/plain', section.sectionId);
					setDragging(section.sectionId);
				},
				onDragOver: event => onDragOver(event, index),
				onDrop: event => {
					event.preventDefault();
					if (dragging && dropBefore !== undefined) onMove(dragging, dropBefore ?? undefined);
					reset();
				},
				// 没放在分组标题上（拖到别处或按了 Esc）时不移动。
				onDragEnd: reset,
			}}
		>
			{members.map(member => renderRow(member, section.sectionId))}
		</Section>
	));
}

interface ISectionDrag {
	readonly dropMark: 'before' | 'after' | undefined;
	readonly onDragStart: (event: DragEvent<HTMLElement>) => void;
	readonly onDragOver: (event: DragEvent<HTMLElement>) => void;
	readonly onDrop: (event: DragEvent<HTMLElement>) => void;
	readonly onDragEnd: () => void;
}

/** 一组成员：标题后面写人数，点标题折叠。给了 onMenu 时标题上右键、长按有菜单，给了 drag 时可以拖动。 */
function Section({ title, count, open, onToggle, onMenu, drag, children }: {
	title: string;
	count: number;
	open: boolean;
	onToggle: () => void;
	onMenu?: (point: IPoint) => void;
	drag?: ISectionDrag;
	children: ReactNode;
}) {
	const trigger = useMenuTrigger(point => onMenu?.(point));
	return (
		<section className="mt-1">
			<div
				draggable={!!drag}
				onDragStart={drag?.onDragStart}
				onDragOver={drag?.onDragOver}
				onDrop={drag?.onDrop}
				onDragEnd={drag?.onDragEnd}
				{...(onMenu ? trigger : {})}
				className="relative px-3"
			>
				{drag?.dropMark && <span className={clsx('absolute inset-x-3 h-0.5 rounded bg-accent', drag.dropMark === 'before' ? 'top-0' : 'bottom-0')} />}
				<button type="button" onClick={onToggle} aria-expanded={open} className="flex w-full items-center gap-1 rounded px-1 pb-1 pt-1.5 text-left text-xs text-fg-3 hover:text-fg-2">
					<ChevronRight size={12} className={clsx('shrink-0 transition-transform', open && 'rotate-90')} />
					<span className="truncate">{title}</span>
					<span className="shrink-0">{count}</span>
				</button>
			</div>
			{open && children}
		</section>
	);
}

/** 读不出成员的文件夹。 */
function BrokenFolders({ folders }: { folders: readonly IMemberFolderState[] }) {
	const [open, setOpen] = useState(false);
	return (
		<div className="mx-3 mb-1 mt-1 rounded-lg bg-danger-soft px-2.5 py-1.5 text-[13px] text-danger">
			<button type="button" onClick={() => setOpen(value => !value)} className="flex w-full items-center gap-1.5 text-left">
				<CircleAlert size={14} />
				<span className="flex-1">{folders.length} 个成员文件夹配置有误</span>
				<ChevronRight size={14} className={clsx('transition-transform', open && 'rotate-90')} />
			</button>
			{open && (
				<div className="mt-1.5 space-y-1.5">
					{folders.map(folder => (
						<div key={folder.name}>
							<div className="font-medium">{folder.name}</div>
							{folder.issues.map((issue, index) => <div key={index} className="text-xs">{issue}</div>)}
						</div>
					))}
				</div>
			)}
		</div>
	);
}
