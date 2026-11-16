import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useQueryClient } from '@tanstack/react-query';
import { ArchiveRestore, CircleAlert, Ellipsis, ImageMinus, ImageUp, Pause, Play, Trash2, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client.ts';
import { useMemberFolders } from '../api/directory.ts';
import { queryKeys } from '../api/keys.ts';
import { useMemberStates } from '../api/member.ts';
import type { IMember } from '../api/types.ts';
import { errorMessage } from '../lib/errors.ts';
import { dayTime, fullTime } from '../lib/format.ts';
import { Avatar } from '../ui/Avatar.tsx';
import { Button, IconButton } from '../ui/Button.tsx';
import { ConfirmDialog } from '../ui/Dialog.tsx';
import { MemberName } from '../ui/MemberName.tsx';
import { MenuContent, MenuItem, MenuSeparator } from '../ui/Menu.tsx';
import { STATUS_LABELS } from '../ui/StatusDot.tsx';
import { AiEditor, NOTE_INPUT_CLASS } from './AiEditor.tsx';
import { DELETE_DETAIL, PURGE_DETAIL } from './aiForm.ts';

/** 成员设置的内容。onDone：删除、彻底删除后关掉弹窗。 */
export function MemberDetail({ member, onDirtyChange, saveBarTarget, onDone }: {
	member: IMember;
	onDirtyChange?: (dirty: boolean) => void;
	/** 对话框底部放保存栏的元素。 */
	saveBarTarget?: HTMLElement | null;
	onDone: () => void;
}) {
	// 删除、恢复后重新挂载，不留着删除前的状态。
	return member.type === 'ai'
		? <AiPage key={`${member.memberId}:${member.deleted}`} member={member} onDirtyChange={onDirtyChange} saveBarTarget={saveBarTarget} onDone={onDone} />
		: <HumanPage member={member} />;
}

/** 真人：名字和备注，不做改名和删除。 */
function HumanPage({ member }: { member: IMember }) {
	return (
		<div className="flex items-center gap-4 pb-2">
			<Avatar member={member} size={56} />
			<div className="min-w-0 flex-1">
				<div className="flex min-w-0 items-center gap-2"><MemberName member={member} /></div>
				<HumanNote member={member} />
				<div className="text-[13px] text-fg-3">真人</div>
			</div>
		</div>
	);
}

/** 真人的备注：直接在这里改，按 Enter 或离开输入框时保存，按 Esc 撤销。 */
function HumanNote({ member }: { member: IMember }) {
	const [value, setValue] = useState(member.description);
	const [error, setError] = useState<string>();
	useEffect(() => setValue(member.description), [member.description]);
	const save = async () => {
		if (value.trim() === member.description) {
			setValue(member.description);
			return;
		}
		setError(undefined);
		try {
			await api('PUT', `/v1/members/${member.memberId}/description`, { description: value });
		} catch (caught) {
			setError(errorMessage(caught));
		}
	};
	return (
		<>
			<input
				aria-label="备注"
				placeholder="添加备注"
				title="一句话，最长约 30 个汉字；按 Enter 保存"
				value={value}
				onChange={event => setValue(event.target.value)}
				onBlur={() => void save()}
				onKeyDown={event => {
					if (event.key === 'Enter') event.currentTarget.blur();
					if (event.key === 'Escape') {
						setValue(member.description);
						setError(undefined);
					}
				}}
				className={NOTE_INPUT_CLASS}
			/>
			{error && <div className="text-xs text-danger">保存备注失败：{error}</div>}
		</>
	);
}

function AiPage({ member, onDirtyChange, saveBarTarget, onDone }: {
	member: IMember;
	onDirtyChange?: (dirty: boolean) => void;
	saveBarTarget?: HTMLElement | null;
	onDone: () => void;
}) {
	const folders = useMemberFolders();
	const folder = folders.data?.folders.find(item => item.memberId === member.memberId);
	const states = useMemberStates();
	const status = states.data?.get(member.memberId)?.status ?? 'idle';
	// 删除时运行时先发成员文件夹变化，这时页面还在，不能再去取已删除成员的工具。
	const [deleting, setDeleting] = useState(false);
	const created = `创建于 ${fullTime(member.createdAt).slice(0, 10)}`;

	if (member.purged) {
		return (
			<div className="flex items-center gap-4">
				<Avatar member={member} size={48} />
				<div className="min-w-0">
					<h1 className="truncate text-xl font-semibold text-fg-3">{member.name}</h1>
					<div className="text-[13px] text-fg-3">已彻底删除</div>
				</div>
			</div>
		);
	}
	if (member.deleted) return <DeletedAiPage member={member} onDone={onDone} />;
	return (
		<AiEditor
			member={member}
			deleting={deleting}
			avatar={<AiAvatar member={member} />}
			status={`${STATUS_LABELS[status]} · ${created}`}
			actions={<AiActions member={member} deleting={deleting} setDeleting={setDeleting} onDone={onDone} />}
			onDirtyChange={onDirtyChange}
			saveBarTarget={saveBarTarget}
			onClose={onDone}
			notices={(
				<>
					{folder?.status === 'error' && (
						<Issues tone="danger" title="成员文件夹有误，当前使用上次正确的配置；保存将覆盖文件。" issues={folder.issues} />
					)}
					{folder?.status === 'warning' && <Issues tone="warning" title="注意" issues={folder.issues} />}
				</>
			)}
		/>
	);
}

/** 点头像更换；删除头像在「⋯」菜单里。 */
function AiAvatar({ member }: { member: IMember }) {
	const { upload, error } = useAvatar(member);
	const fileInput = useRef<HTMLInputElement>(null);
	return (
		<div className="shrink-0">
			<button type="button" title="更换头像" aria-label="更换头像" onClick={() => fileInput.current?.click()} className="block rounded-md hover:opacity-80">
				<Avatar member={member} size={48} />
			</button>
			<input
				ref={fileInput}
				id={`avatar-${member.memberId}`}
				type="file"
				accept="image/png,image/jpeg,image/webp,image/gif"
				className="hidden"
				onChange={event => {
					const file = event.target.files?.[0];
					event.target.value = '';
					if (file) void upload(file);
				}}
			/>
			{error && <div className="mt-1 max-w-24 text-[11px] text-danger">{error}</div>}
		</div>
	);
}

function useAvatar(member: IMember) {
	const queryClient = useQueryClient();
	const [error, setError] = useState<string>();
	const send = async (method: 'PUT' | 'DELETE', body?: Blob) => {
		setError(undefined);
		try {
			await api(method, `/v1/members/${member.memberId}/avatar`, body);
			await queryClient.invalidateQueries({ queryKey: queryKeys.members });
		} catch (caught) {
			setError(`更换头像失败：${errorMessage(caught)}`);
		}
	};
	return { upload: (file: Blob) => send('PUT', file), remove: () => send('DELETE'), error };
}

function AiActions({ member, deleting, setDeleting, onDone }: { member: IMember; deleting: boolean; setDeleting: (deleting: boolean) => void; onDone: () => void }) {
	const queryClient = useQueryClient();
	const avatar = useAvatar(member);
	const [error, setError] = useState<string>();
	const [confirming, setConfirming] = useState(false);

	const act = async (path: string) => {
		setError(undefined);
		try {
			await api('POST', `/v1/members/${member.memberId}${path}`);
			await queryClient.invalidateQueries({ queryKey: queryKeys.members });
		} catch (caught) {
			setError(errorMessage(caught));
		}
	};
	const remove = async () => {
		setDeleting(true);
		setError(undefined);
		try {
			await api('DELETE', `/v1/members/${member.memberId}`);
			setConfirming(false);
			onDone();
		} catch (caught) {
			setError(errorMessage(caught));
			setDeleting(false);
		}
	};

	return (
		<>
			{member.paused
				? <Button onClick={() => void act('/resume')}><Play size={15} />恢复</Button>
				: <Button onClick={() => void act('/pause')}><Pause size={15} />暂停</Button>}
			<DropdownMenu.Root>
				<DropdownMenu.Trigger asChild>
					<IconButton label="更多操作"><Ellipsis size={18} /></IconButton>
				</DropdownMenu.Trigger>
				<MenuContent align="end">
					<MenuItem onSelect={() => document.getElementById(`avatar-${member.memberId}`)?.click()}><ImageUp size={15} />更换头像</MenuItem>
					{member.avatar && <MenuItem onSelect={() => void avatar.remove()}><ImageMinus size={15} />删除头像</MenuItem>}
					<MenuSeparator />
					<MenuItem className="text-danger" onSelect={() => setConfirming(true)}><Trash2 size={15} />删除成员</MenuItem>
				</MenuContent>
			</DropdownMenu.Root>
			{(error || avatar.error) && <div className="basis-full text-right text-[13px] text-danger">{avatar.error ?? `操作失败：${error}`}</div>}
			<ConfirmDialog
				open={confirming}
				onOpenChange={setConfirming}
				title={`删除 ${member.name}？`}
				detail={DELETE_DETAIL}
				confirmLabel="删除"
				busy={deleting}
				error={confirming ? error : undefined}
				onConfirm={() => void remove()}
			/>
		</>
	);
}

/** 已删除的 AI 成员：写明删除时做了什么（恢复时会还原的），可以恢复或彻底删除。 */
function DeletedAiPage({ member, onDone }: { member: IMember; onDone: () => void }) {
	const queryClient = useQueryClient();
	const [busy, setBusy] = useState<'restore' | 'purge'>();
	const [error, setError] = useState<string>();
	const [confirming, setConfirming] = useState(false);

	const act = async (action: 'restore' | 'purge') => {
		setBusy(action);
		setError(undefined);
		try {
			await api('POST', `/v1/members/${member.memberId}/${action}`);
			await queryClient.invalidateQueries({ queryKey: queryKeys.members });
			if (action === 'purge') onDone();
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(undefined);
		}
	};
	const deletion = member.deletion;
	const done = deletion ? [
		deletion.dissolvedGroups.length > 0 && `已解散群聊：${deletion.dissolvedGroups.map(group => group.name).join('、')}`,
		deletion.leftGroups.length > 0 && `已退出群聊：${deletion.leftGroups.map(group => group.name).join('、')}`,
		deletion.reminders > 0 && `已暂停 ${deletion.reminders} 个定时`,
	].filter(item => item !== false) : [];

	return (
		<>
			<div className="flex flex-wrap items-center gap-x-4 gap-y-3">
				<Avatar member={member} size={48} />
				<div className="min-w-0 flex-1">
					<div className="flex min-w-0 items-center gap-2"><MemberName member={member} className="text-fg-2" /></div>
					{member.description && <div className="truncate text-[13px] text-fg-2">{member.description}</div>}
					<div className="text-[13px] text-fg-3">已删除 · {dayTime(member.deletedAt ?? 0)}</div>
				</div>
				<div className="flex items-center gap-2">
					<Button disabled={busy !== undefined} onClick={() => void act('restore')}><ArchiveRestore size={15} />恢复</Button>
					<DropdownMenu.Root>
						<DropdownMenu.Trigger asChild>
							<IconButton label="更多操作"><Ellipsis size={18} /></IconButton>
						</DropdownMenu.Trigger>
						<MenuContent align="end">
							<MenuItem className="text-danger" onSelect={() => setConfirming(true)}><Trash2 size={15} />彻底删除</MenuItem>
						</MenuContent>
					</DropdownMenu.Root>
				</div>
				{error && !confirming && <div className="basis-full text-right text-[13px] text-danger">操作失败：{error}</div>}
			</div>
			{done.length > 0 && <div className="mt-6 rounded-xl border border-line bg-raised px-5 py-4 text-[13px] text-fg-2">删除时{done.join('；')}</div>}
			<ConfirmDialog
				open={confirming}
				onOpenChange={setConfirming}
				title={`彻底删除 ${member.name}？`}
				detail={PURGE_DETAIL}
				confirmLabel="彻底删除"
				busy={busy === 'purge'}
				error={confirming ? error : undefined}
				onConfirm={() => void act('purge')}
			/>
		</>
	);
}

function Issues({ tone, title, issues }: { tone: 'danger' | 'warning'; title: string; issues: readonly string[] }) {
	const Icon = tone === 'danger' ? CircleAlert : TriangleAlert;
	return (
		<div className={tone === 'danger' ? 'mt-4 rounded-xl bg-danger-soft px-4 py-3 text-[13px] text-danger' : 'mt-4 rounded-xl bg-warning/10 px-4 py-3 text-[13px] text-warning'}>
			<div className="flex items-center gap-1.5 font-medium"><Icon size={14} />{title}</div>
			<ul className="mt-1 list-disc pl-5">
				{issues.map((issue, index) => <li key={index}>{issue}</li>)}
			</ul>
		</div>
	);
}
