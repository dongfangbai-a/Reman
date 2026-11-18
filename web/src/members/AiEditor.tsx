import clsx from 'clsx';
import { ChevronRight, Dices, Eraser, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router';
import { api } from '../api/client.ts';
import { useGroups, useMcp, useMemberFolders, useSkills, useToolCatalog, useTools } from '../api/directory.ts';
import { useMembers } from '../api/queries.ts';
import { useSandboxProblem } from '../api/system.ts';
import type { IMember, IToolInfo, MemberRuleMode, ToolPolicy } from '../api/types.ts';
import { errorMessage } from '../lib/errors.ts';
import { Button, IconButton } from '../ui/Button.tsx';
import { Choice } from '../ui/Choice.tsx';
import { CopyablePath } from '../ui/CopyablePath.tsx';
import { ConfirmDialog, INPUT_CLASS } from '../ui/Dialog.tsx';
import { DirectoryInput } from '../ui/DirectoryInput.tsx';
import { HelpTip } from '../ui/HelpTip.tsx';
import { MemberName } from '../ui/MemberName.tsx';
import { AiTag } from '../ui/MemberNote.tsx';
import { Switch } from '../ui/Switch.tsx';
import { MAX_TERMINALS_PER_MEMBER } from '../../../src/terminals/limits.ts';
import { EMPTY_FORM, RULE_LABELS, directoryValue, fromMember, sameForm, toDefinition, toolsForm, type IAiForm } from './aiForm.ts';
import { suggestMemberName } from './memberNames.ts';
import { MemberPicker } from './MemberPicker.tsx';
import { ModelSelects } from './ModelSelects.tsx';
import { PromptAndMemory } from './PromptAndMemory.tsx';
import { PromptSection } from './PromptSection.tsx';
import { configurableTools, customToolTitle, customTools, mcpTools, ToolRow } from './ToolRow.tsx';

type Update = (patch: Partial<IAiForm>) => void;

/** 名字下面的备注输入框：平时像普通文字，悬停和输入时显示边框。 */
export const NOTE_INPUT_CLASS = '-ml-2 mt-1 h-7 w-full max-w-xl rounded-md border border-transparent bg-transparent px-2 text-[13px] text-fg-2 outline-none placeholder:text-fg-3 hover:border-line focus:border-accent';

/**
 * AI 成员设置：头部是名字和备注，下面左栏是常用设置和提示词、右栏是工具、技能和群聊。member 为空时是新建。
 * 统一用「保存」：先写成员文件，再设审批方式和工作目录；新建时一次建好。
 * deleting：成员正在删除，不再请求它的工具和记忆。
 */
export function AiEditor({ member, deleting = false, avatar, status, actions, notices, onDirtyChange, saveBarTarget, onClose }: {
	member?: IMember;
	deleting?: boolean;
	/** 头部左边的头像，新建时没有。 */
	avatar?: ReactNode;
	/** 名字后面的状态。 */
	status?: ReactNode;
	/** 头部右边的操作。 */
	actions?: ReactNode;
	/** 头部下面的提示，比如成员文件夹的问题。 */
	notices?: ReactNode;
	/** 有没有没保存的修改，对话框关闭前确认用。 */
	onDirtyChange?: (dirty: boolean) => void;
	/** 保存栏放到这个元素里（对话框底部）：一直显示，没修改时按钮是灰的，出现修改时布局不变。给了它也表示在对话框里，间距收紧。 */
	saveBarTarget?: HTMLElement | null;
	/** 关掉所在的弹窗：新建好了、去设置页时。 */
	onClose?: () => void;
}) {
	const members = useMembers();
	const tools = useTools(member?.memberId, !deleting);
	const catalog = useToolCatalog(!member);
	const skills = useSkills();
	const memberFolders = useMemberFolders();
	const folder = memberFolders.data?.folders.find(item => member && item.memberId === member.memberId);
	const navigate = useNavigate();
	const initial = useMemo(() => member ? fromMember(member, tools.data) : EMPTY_FORM, [member, tools.data]);
	const [form, setForm] = useState(initial);
	const [base, setBase] = useState(initial);
	const [stale, setStale] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string>();
	const savingRef = useRef(false);

	// 服务端的配置变了：表单没改过或已经和它一样就跟着更新；改过的保留，提示保存会覆盖。
	const formRef = useRef(form);
	formRef.current = form;
	const baseRef = useRef(base);
	baseRef.current = base;
	useEffect(() => {
		if (!member || savingRef.current) return;
		if (sameForm(formRef.current, initial) || sameForm(formRef.current, baseRef.current)) {
			setForm(initial);
			setBase(initial);
			setStale(false);
		} else {
			setStale(true);
		}
	}, [member, initial]);

	// 新建时工具列表到了，按默认设置填进表单。
	useEffect(() => {
		if (!member && catalog.data) setForm(current => Object.keys(current.tools).length > 0 ? current : { ...current, tools: toolsForm(catalog.data) });
	}, [member, catalog.data]);

	// 新建时技能列表到了，按默认技能勾好；只填一次，之后都不勾也是用户选的。
	const defaultSkills = useMemo(() => (skills.data ?? []).filter(skill => skill.defaultEnabled).map(skill => skill.name), [skills.data]);
	const skillsFilled = useRef(false);
	useEffect(() => {
		if (member || !skills.data || skillsFilled.current) return;
		skillsFilled.current = true;
		setForm(current => ({ ...current, skills: defaultSkills }));
	}, [member, skills.data, defaultSkills]);

	// 推荐名字要避开现有成员、已删除成员（用它的名字新建会恢复那个成员）和成员文件夹的名字。
	const nameInput = useRef<HTMLInputElement>(null);
	/** 新建时推荐的名字，没改过不算填了内容。 */
	const suggestedName = useRef('');
	const namesLoaded = !!members.data && !!memberFolders.data;
	const occupiedNames = () => [...(members.data ?? []).filter(item => !item.purged).map(item => item.name), ...(memberFolders.data?.folders ?? []).map(item => item.name)];
	const suggestName = () => {
		const name = suggestMemberName(occupiedNames(), form.name.trim());
		if (!name) return;
		update({ name });
		nameInput.current?.focus();
		requestAnimationFrame(() => nameInput.current?.select());
	};

	// 新建时先填一个推荐的名字，选中它，直接输入就能覆盖；名单到之前已经输入了就不填。
	useEffect(() => {
		if (member || !namesLoaded) return;
		const name = suggestMemberName(occupiedNames());
		if (!name) return;
		suggestedName.current = name;
		setForm(current => current.name ? current : { ...current, name });
		requestAnimationFrame(() => {
			if (document.activeElement === nameInput.current && nameInput.current?.value === name) nameInput.current.select();
		});
	}, [member, namesLoaded]);

	const dirty = member ? !sameForm(form, base) : form.name.trim().length > 0;
	// 记忆单独保存，没保存的记忆也算没保存的修改。
	const [memoryDirty, setMemoryDirty] = useState(false);
	useEffect(() => onDirtyChange?.(dirty || memoryDirty), [dirty, memoryDirty, onDirtyChange]);
	// 离开页面去设置页：有没保存的内容时先确认放弃。新建时只有推荐的名字、其他都没动过不算。
	const [leaveTo, setLeaveTo] = useState<string>();
	const pristine = useMemo(() => ({ ...EMPTY_FORM, tools: toolsForm(catalog.data), skills: defaultSkills }), [catalog.data, defaultSkills]);
	const filled = !member && ((form.name.trim() !== '' && form.name !== suggestedName.current) || !sameForm(form, pristine));
	const leave = (to: string) => {
		navigate(to);
		onClose?.();
	};
	const openSettings = (to: string) => (member ? dirty || memoryDirty : filled) ? setLeaveTo(to) : leave(to);
	const nameOf = (memberId: string) => members.data?.find(item => item.memberId === memberId)?.name ?? memberId;
	const aiCandidates = (members.data ?? []).filter(item => item.type === 'ai' && !item.deleted && item.memberId !== member?.memberId);
	const update: Update = patch => setForm(current => ({ ...current, ...patch }));

	const save = async () => {
		setSaving(true);
		savingRef.current = true;
		setError(undefined);
		try {
			if (form.customDirectory && !form.workingDirectory.trim()) throw new Error('请选择目录');
			const definition = toDefinition(form, nameOf);
			if (member) {
				await api('PUT', `/v1/members/${member.memberId}/files`, { definition, prompt: form.prompt });
				for (const [name, tool] of Object.entries(form.tools)) {
					if (base.tools[name]?.policy !== tool.policy) await api('PUT', `/v1/members/${member.memberId}/tools/${name}`, { policy: tool.policy });
				}
				if (directoryValue(form) !== directoryValue(base)) {
					await api('PUT', `/v1/members/${member.memberId}/working-directory`, { workingDirectory: directoryValue(form) });
				}
				setBase(form);
				setStale(false);
			} else {
				// 每个工具的审批方式都记下来，以后改新成员的默认设置不影响这个成员。不用审批的工具不记。
				const approvable = new Set((catalog.data ?? []).filter(tool => tool.policies.length > 0).map(tool => tool.name));
				const toolPolicies = Object.fromEntries(Object.entries(form.tools).filter(([name]) => approvable.has(name)).map(([name, tool]) => [name, tool.policy]));
				const { member: created } = await api<{ member: IMember }>('POST', '/v1/members', {
					type: 'ai', name: form.name.trim(), definition, prompt: form.prompt, toolPolicies, workingDirectory: directoryValue(form),
				});
				leave(`/members/${created.memberId}`);
			}
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			savingRef.current = false;
			setSaving(false);
		}
	};
	const discard = () => {
		setForm(initial);
		setBase(initial);
		setStale(false);
		setError(undefined);
	};

	return (
		<div>
			<header className="flex flex-wrap items-start gap-x-4 gap-y-3">
				{avatar}
				<div className="min-w-0 flex-1 basis-56">
					{member
						? (
							<div className="flex min-w-0 items-center gap-2">
								<AiTag member={member} />
								<MemberName member={member} />
								{status && <span className="truncate text-[13px] text-fg-3">{status}</span>}
							</div>
						)
						: (
							<>
								<div className="relative max-w-md">
									<input
										ref={nameInput}
										autoFocus
										aria-label="成员名"
										placeholder="成员名"
										value={form.name}
										onChange={event => update({ name: event.target.value })}
										className={clsx(INPUT_CLASS, 'h-9 pr-10 font-semibold')}
									/>
									<IconButton label="随机换名" disabled={!namesLoaded} onClick={suggestName} className="absolute right-0.5 top-1/2 -translate-y-1/2">
										<Dices size={17} />
									</IconButton>
								</div>
								<div className="mt-1 text-xs text-fg-3">可包含汉字、英文字母、点号、横杠和下划线，最长约 5 个汉字或 20 个英文字母；创建后不能修改。</div>
							</>
						)}
					<input
						aria-label="备注"
						placeholder="添加备注"
						title="一句话，最长约 30 个汉字"
						value={form.description}
						onChange={event => update({ description: event.target.value })}
						className={NOTE_INPUT_CLASS}
					/>
				</div>
				{actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
			</header>
			{notices}
			{/* 两栏底部对齐：左栏的提示词往下撑满到右栏的高度。 */}
			<div className={clsx('grid gap-4 lg:grid-cols-2', saveBarTarget === undefined ? 'mt-5' : 'mt-3')}>
				<div className="flex min-w-0 flex-col gap-4">
					<Panel title="基本设置">
						<Row label="模型">
							<ModelSelects model={form.model} reasoning={form.reasoning} onModel={model => update({ model })} onReasoning={reasoning => update({ reasoning })} />
						</Row>
						<Row label="工作目录">
							<WorkingDirectorySection form={form} update={update} member={member} />
						</Row>
						<Row label="私聊">
							<MemberRuleSection
								label="与其他 AI 成员私聊"
								mode={form.dmMode}
								memberIds={form.dmMemberIds}
								onChange={(dmMode, dmMemberIds) => update({ dmMode, dmMemberIds })}
								candidates={aiCandidates}
								note="与其他 AI 成员私聊须双方均允许；真人与 AI 成员之间始终可以私聊。"
							/>
						</Row>
						<Row label="群聊">
							<MemberRuleSection
								label="被其他 AI 成员邀请加入群聊"
								mode={form.groupMode}
								memberIds={form.groupMemberIds}
								onChange={(groupMode, groupMemberIds) => update({ groupMode, groupMemberIds })}
								candidates={aiCandidates}
								note="允许哪些 AI 成员邀请该成员加入新群聊；真人成员的邀请不受此限制。"
							/>
						</Row>
						<Row label="时间感知" help="开启后，成员可从收到的内容中得知大致时间；切换仅影响此后收到的内容。">
							<div className="pt-1.5">
								<Switch checked={form.timeAwareness} label="时间感知" onChange={timeAwareness => update({ timeAwareness })} />
							</div>
						</Row>
						<Row label="终端上限" help="这个成员自己建的终端同时最多保留几个；没关闭的都算，接管不影响。默认 3，最多 16。">
							<input
								type="number" min={1} max={MAX_TERMINALS_PER_MEMBER} step={1}
								className={clsx(INPUT_CLASS, 'h-9 w-24')}
								value={form.maxTerminals}
								onChange={event => {
									const value = Number(event.target.value);
									if (Number.isInteger(value) && value >= 1 && value <= MAX_TERMINALS_PER_MEMBER) update({ maxTerminals: value });
								}}
							/>
						</Row>
					</Panel>
					{member
						? <PromptAndMemory memberId={member.memberId} memberName={member.name} folderPath={folder?.path} prompt={form.prompt} promptEdited={form.prompt !== base.prompt} deleting={deleting} onPromptChange={prompt => update({ prompt })} onMemoryDirtyChange={setMemoryDirty} />
						: <PromptSection value={form.prompt} onChange={prompt => update({ prompt })} />}
				</div>
				<div className="flex min-w-0 flex-col gap-4">
					<ToolsSection
						tools={member ? tools.data : catalog.data}
						loadError={(member ? tools.error : catalog.error)?.message}
						form={form}
						update={update}
						onOpenDefaults={member ? undefined : () => openSettings('/settings/tools')}
						onOpenCustomTools={() => openSettings('/settings/custom-tools')}
						memberId={member?.memberId}
					/>
					<SkillsSection form={form} update={update} onOpenSettings={() => openSettings('/settings/skills')} />
					{member && <GroupsSection memberId={member.memberId} />}
				</div>
			</div>
			{(dirty || error || stale || saveBarTarget) && (() => {
				// 对话框底部的保存栏收紧：按钮矮一些、两边留白少一些，字号不变。
				const buttonClass = saveBarTarget ? 'h-7 px-2.5' : undefined;
				const bar = (
					<>
						<div className="min-w-0 flex-1 text-[13px]">
							{error
								? <span className="text-danger">{member ? '保存失败' : '新建失败'}：{error}</span>
								: stale
									? <span className="text-warning">配置已在别处修改，保存将覆盖</span>
									: dirty && <span className="text-fg-2">{member ? '有未保存的修改' : '填写完成后即可新建'}</span>}
						</div>
						{member && <Button className={buttonClass} disabled={saving || !dirty && !stale && !error} onClick={discard}>放弃修改</Button>}
						<Button className={buttonClass} variant="primary" disabled={saving || !dirty && !stale} onClick={() => void save()}>{member ? '保存' : '新建'}</Button>
					</>
				);
				return saveBarTarget
					? createPortal(<div className="flex flex-wrap items-center gap-2 border-t border-line px-5 py-2">{bar}</div>, saveBarTarget)
					: <div className="sticky bottom-0 -mx-1 mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-raised px-4 py-3 shadow-lg">{bar}</div>;
			})()}
			<ConfirmDialog
				open={leaveTo !== undefined}
				onOpenChange={open => !open && setLeaveTo(undefined)}
				title="放弃修改？"
				detail={`前往设置页将关闭此窗口，${member ? '未保存的修改' : '已填写的内容'}将会丢失。`}
				confirmLabel="放弃"
				onConfirm={() => leave(leaveTo!)}
			/>
		</div>
	);
}

/** 带标题的一块，里面的行用细线隔开。 */
function Panel({ title, titleAction, aside, className, children }: { title: string; titleAction?: ReactNode; aside?: ReactNode; className?: string; children: ReactNode }) {
	return (
		<section className={clsx('rounded-xl border border-line bg-raised', className)}>
			<div className="flex h-10 items-center gap-2 border-b border-line px-4 text-[13px]">
				<span className="font-medium">{title}</span>
				{titleAction}
				{aside && <span className="ml-auto text-xs text-fg-3">{aside}</span>}
			</div>
			<div className="divide-y divide-line">{children}</div>
		</section>
	);
}

/** 设置的一行：左边标签，右边内容。help 是标签后面问号图标里的说明。 */
function Row({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
	return (
		<div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-start gap-3 px-4 py-3">
			<div className="flex items-center gap-0.5 whitespace-nowrap pt-1.5 text-[13px] text-fg-2">
				{label}
				{help && <HelpTip label={label}>{help}</HelpTip>}
			</div>
			<div className="min-w-0">{children}</div>
		</div>
	);
}

/** 工作目录：默认目录（运行时分配，显示实际路径）或指定目录（输入框加选择目录）。 */
function WorkingDirectorySection({ form, update, member }: { form: IAiForm; update: Update; member: IMember | undefined }) {
	const folders = useMemberFolders();
	const root = folders.data?.workspacesDirectory;
	const options = [[false, '默认目录'], [true, '指定目录']] as const;
	const sandboxProblem = useSandboxProblem(form.customDirectory ? form.workingDirectory.trim() : member?.defaultWorkingDirectory);
	return (
		<div>
			<div className="flex gap-1.5" role="radiogroup" aria-label="工作目录">
				{options.map(([custom, label]) => (
					<Choice key={label} checked={form.customDirectory === custom} onClick={() => update({ customDirectory: custom })}>{label}</Choice>
				))}
			</div>
			<div className="mt-2">
				{form.customDirectory
					? <DirectoryInput label="指定的工作目录" placeholder="选择或输入绝对路径" pickerTitle="选择工作目录" value={form.workingDirectory} onChange={workingDirectory => update({ workingDirectory })} />
					: member?.defaultWorkingDirectory
						? <CopyablePath path={member.defaultWorkingDirectory} />
						: root && <div className="text-xs text-fg-3">创建后分配在 <span className="font-mono">{root}{root.includes('\\') ? '\\' : '/'}</span> 目录下</div>}
			</div>
			{sandboxProblem && <div className="mt-1.5 text-xs text-fg-2">命令未在沙箱中执行（{sandboxProblem}）</div>}
		</div>
	);
}

/** 技能：和工具一样每个一行，开关加说明。 */
function SkillsSection({ form, update, onOpenSettings }: { form: IAiForm; update: Update; onOpenSettings: () => void }) {
	const skills = useSkills();
	const known = new Set((skills.data ?? []).map(skill => skill.name));
	const missing = form.skills.filter(name => !known.has(name));
	const toggle = (name: string) => update({ skills: form.skills.includes(name) ? form.skills.filter(item => item !== name) : [...form.skills, name] });
	return (
		<Panel title="技能" titleAction={<button type="button" onClick={onOpenSettings} className="text-xs text-accent hover:underline">管理技能</button>}>
			{skills.data?.length === 0 && missing.length === 0 && <div className="px-4 py-3 text-[13px] text-fg-3">暂无技能</div>}
			{skills.data?.map(skill => {
				const enabled = form.skills.includes(skill.name);
				return (
					<div key={skill.name} className="flex h-10 items-center gap-3 px-4">
						<Switch checked={enabled} label={skill.name} onChange={() => toggle(skill.name)} />
						<span className={clsx('min-w-0 truncate font-mono text-[13px]', !enabled && 'text-fg-3')}>{skill.name}</span>
						<span className="min-w-0 flex-1 truncate text-xs text-fg-3" title={skill.description}>{skill.description}</span>
					</div>
				);
			})}
			{missing.map(name => (
				<div key={name} className="flex h-10 items-center gap-3 px-4 text-warning">
					<Switch checked label={name} onChange={() => toggle(name)} />
					<span className="min-w-0 truncate font-mono text-[13px]">{name}</span>
					<span className="flex min-w-0 items-center gap-1 truncate text-xs"><TriangleAlert size={12} className="shrink-0" />技能目录中不存在，无法读取</span>
				</div>
			))}
		</Panel>
	);
}

/**
 * 成员所在的群聊：群名、人数、关注开关。没有时不显示。
 * 关注只决定它什么时候被唤醒，是它自己的设置，使用者可以改；改了立即生效，不走页面的保存，运行时会记进它的时间线。
 */
function GroupsSection({ memberId }: { memberId: string }) {
	const groups = useGroups();
	const [busy, setBusy] = useState<string>();
	const [error, setError] = useState<string>();
	const joined = (groups.data ?? []).filter(group => group.members.some(membership => membership.memberId === memberId));
	if (joined.length === 0) return null;
	const watch = async (groupId: string, watching: boolean) => {
		setBusy(groupId);
		setError(undefined);
		try {
			await api('PUT', `/v1/groups/${groupId}/members/${memberId}/watching`, { watching });
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(undefined);
		}
	};
	return (
		<Panel title="群聊">
			{joined.map(group => {
				const watching = group.members.find(membership => membership.memberId === memberId)!.watching;
				return (
					<div key={group.groupId} className="flex items-center gap-3 px-4 py-2 text-[13px]">
						<span className="min-w-0 flex-1 truncate">{group.name}</span>
						<span className="shrink-0 text-xs text-fg-3">{group.members.length} 人</span>
						<label className="flex shrink-0 items-center gap-2 text-xs text-fg-2" title="关注后，群中任何成员发言都会唤醒该成员，无需点名">
							关注
							<Switch checked={watching} label={`关注群聊「${group.name}」`} disabled={busy !== undefined} onChange={checked => void watch(group.groupId, checked)} />
						</label>
					</div>
				);
			})}
			{error && <div className="px-4 py-2 text-xs text-danger">操作失败：{error}</div>}
		</Panel>
	);
}

/** 浏览器一行右边的「清除浏览数据」，窄时只有图标：确认后关掉成员的浏览器，删掉登录状态和 Cookie。 */
function ClearBrowserData({ memberId }: { memberId: string }) {
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const clear = async () => {
		setError(undefined);
		setBusy(true);
		try {
			await api('DELETE', `/v1/members/${memberId}/browser`);
			setOpen(false);
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	};
	return (
		<>
			<button type="button" onClick={() => setOpen(true)} title="清除浏览数据" aria-label="清除浏览数据" className="ml-auto flex shrink-0 items-center gap-1 text-xs text-accent hover:underline">
				<Eraser size={13} /><span className="hidden @min-[26rem]:inline">清除浏览数据</span>
			</button>
			<ConfirmDialog
				open={open}
				onOpenChange={setOpen}
				title="清除浏览数据？"
				detail="将关闭成员正在使用的浏览器，并删除登录状态和 Cookie，已登录的网站须重新登录。"
				confirmLabel="清除"
				busy={busy}
				error={error}
				onConfirm={() => void clear()}
			/>
		</>
	);
}

function MemberRuleSection({ label, mode, memberIds, onChange, candidates, note }: {
	label: string;
	mode: MemberRuleMode;
	memberIds: readonly string[];
	onChange: (mode: MemberRuleMode, memberIds: readonly string[]) => void;
	candidates: readonly IMember[];
	note: string;
}) {
	return (
		<div>
			<div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={label}>
				{(Object.keys(RULE_LABELS) as MemberRuleMode[]).map(item => (
					<Choice key={item} checked={mode === item} onClick={() => onChange(item, memberIds)}>{RULE_LABELS[item]}</Choice>
				))}
			</div>
			{(mode === 'allow' || mode === 'deny') && (
				<div className="mt-2"><MemberPicker candidates={candidates} selected={memberIds} onChange={ids => onChange(mode, ids)} /></div>
			)}
			<div className="mt-1.5 text-xs text-fg-3">{note}</div>
		</div>
	);
}

/**
 * onOpenDefaults：新建时给出，标题行显示「默认设置」，跳到设置页的工具分类。onOpenCustomTools：跳到设置页的自定义工具分类。
 * memberId：已有成员才有，浏览器一行可以清除浏览数据。
 */
function ToolsSection({ tools, loadError, form, update, onOpenDefaults, onOpenCustomTools, memberId }: {
	tools: readonly IToolInfo[] | undefined;
	loadError?: string;
	form: IAiForm;
	update: Update;
	onOpenDefaults?: () => void;
	onOpenCustomTools: () => void;
	memberId?: string;
}) {
	const [showFixed, setShowFixed] = useState(false);
	const mcp = useMcp();
	const configurable = configurableTools(tools ?? []);
	const custom = customTools(tools ?? []);
	const servers = mcpTools(tools ?? []);
	const statuses = new Map(mcp.data?.servers.map(server => [server.name, server.status]));
	// 文件里写了、但没有的自定义工具和没配置的 MCP 服务器。MCP 服务器配置了但还没有工具的不列，也不算没有。
	const missingOf = (prefix: string) => tools ? Object.keys(form.tools).filter(name => name.startsWith(prefix) && !tools.some(tool => tool.name === name)) : [];
	const missingCustom = missingOf('custom:');
	const missing = missingOf('mcp:');
	const fixed = (tools ?? []).filter(tool => !tool.configurable);
	const set = (name: string, patch: Partial<{ enabled: boolean; policy: ToolPolicy }>) => update({ tools: { ...form.tools, [name]: { ...form.tools[name]!, ...patch } } });
	const drop = (name: string) => update({ tools: Object.fromEntries(Object.entries(form.tools).filter(([key]) => key !== name)) });
	const titleAction = onOpenDefaults && (
		<button type="button" onClick={onOpenDefaults} className="text-xs text-accent hover:underline">默认设置</button>
	);
	return (
		<Panel title="工具" titleAction={titleAction} aside="审批方式">
			{loadError && <div className="px-4 py-3 text-[13px] text-danger">加载失败：{loadError}</div>}
			{!tools && !loadError && <div className="px-4 py-3 text-[13px] text-fg-3">正在加载…</div>}
			{configurable.map(tool => {
				const value = form.tools[tool.name];
				return value && (
					<ToolRow key={tool.name} tool={tool} enabled={value.enabled} policy={value.policy} onChange={patch => set(tool.name, patch)}>
						{tool.name === 'browser' && memberId && <ClearBrowserData memberId={memberId} />}
					</ToolRow>
				);
			})}
			{custom.map(tool => {
				const value = form.tools[tool.name];
				const { folder, origin, disabled, problem } = tool.customTool!;
				// 停用和未配置只影响调用的结果，开关和审批方式照常能改。
				return value && (
					<ToolRow key={tool.name} tool={tool} label={folder} tag={origin === 'builtin' ? '内置' : '自定义'} title={customToolTitle(tool)} enabled={value.enabled} policy={value.policy} onChange={patch => set(tool.name, patch)}>
						{disabled
							? <button type="button" title="调用时将返回已停用，可在设置的「自定义工具」中启用" onClick={onOpenCustomTools} className="ml-2 shrink-0 text-xs text-fg-3 hover:underline">已停用</button>
							: problem && <button type="button" title={problem} onClick={onOpenCustomTools} className="ml-2 shrink-0 text-xs text-warning hover:underline">未配置</button>}
					</ToolRow>
				);
			})}
			{missingCustom.map(name => (
				<div key={name} className="flex h-10 items-center gap-3 px-4 text-warning">
					<Switch checked label={name} onChange={() => drop(name)} />
					<span className="min-w-0 truncate font-mono text-[13px]">{name.slice('custom:'.length)}</span>
					<span className="flex min-w-0 items-center gap-1 truncate text-xs"><TriangleAlert size={12} className="shrink-0" />该自定义工具不存在</span>
				</div>
			))}
			{(servers.length > 0 || missing.length > 0) && <div className="px-4 pb-1 pt-2.5 text-xs text-fg-3">MCP 服务器</div>}
			{servers.map(tool => {
				const value = form.tools[tool.name];
				return value && (
					<ToolRow key={tool.name} tool={tool} label={tool.mcpServer!} enabled={value.enabled} policy={value.policy} onChange={patch => set(tool.name, patch)}>
						{statuses.get(tool.mcpServer!) === 'failed' && <span title="连接失败" aria-label="连接失败" className="ml-2 text-warning"><TriangleAlert size={12} /></span>}
					</ToolRow>
				);
			})}
			{missing.map(name => (
				<div key={name} className="flex h-10 items-center gap-3 px-4 text-warning">
					<Switch checked label={name} onChange={() => drop(name)} />
					<span className="min-w-0 truncate font-mono text-[13px]">{name.slice('mcp:'.length)}</span>
					<span className="flex min-w-0 items-center gap-1 truncate text-xs"><TriangleAlert size={12} className="shrink-0" />不存在该 MCP 服务器</span>
				</div>
			))}
			{fixed.length > 0 && (
				<div className="px-4 py-2.5">
					<button type="button" onClick={() => setShowFixed(value => !value)} className="flex items-center gap-1 text-xs text-fg-3 hover:text-fg-2">
						<ChevronRight size={13} className={clsx('transition-transform', showFixed && 'rotate-90')} />始终可用的工具 {fixed.length} 个
					</button>
					{showFixed && <div className="mt-1 pl-4 text-xs">{fixed.map((tool, index) => (
						<span key={tool.name}>{index > 0 && <span className="text-fg-3">、</span>}<span className="font-mono text-fg-2">{tool.name}</span>{tool.label && <span className="ml-1 text-fg-3">{tool.label}</span>}</span>
					))}</div>}
				</div>
			)}
		</Panel>
	);
}
