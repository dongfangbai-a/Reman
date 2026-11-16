import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Bot, FolderPlus, Hand, SquareTerminal } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../api/client.ts';
import { queryKeys } from '../api/keys.ts';
import { useDirectories } from '../api/system.ts';
import type { IMember, ITerminalInfo } from '../api/types.ts';
import { errorMessage } from '../lib/errors.ts';
import { Avatar } from '../ui/Avatar.tsx';
import { Button } from '../ui/Button.tsx';
import { ConfirmDialog, Dialog } from '../ui/Dialog.tsx';
import { DirectoryInput } from '../ui/DirectoryInput.tsx';
import { TerminalView } from './TerminalView.tsx';

/** 标签上写谁建的（成员的小头像，你建的不带）和终端 ID。时间线里用 ID 指终端，标签也写 ID，两边对得上；你起了名字时写名字。 */
export function TerminalTabLabel({ terminal, creator, name }: { terminal: ITerminalInfo; creator: IMember | undefined; name: string | undefined }) {
	return (
		<>
			{terminal.createdBy && <Avatar member={creator} size={14} className={clsx(terminal.status === 'exited' && 'opacity-60')} />}
			{name ? <span className="max-w-40 truncate">{name}</span> : <span className="shrink-0 font-mono text-xs">{terminal.terminalId}</span>}
		</>
	);
}

export function TerminalDetail({ terminal, memberById }: { terminal: ITerminalInfo; memberById: Map<string, IMember> }) {
	const creator = terminal.createdBy ? memberById.get(terminal.createdBy) : undefined;
	const queryClient = useQueryClient();
	const [error, setError] = useState<string>();
	const [busy, setBusy] = useState(false);
	const running = terminal.status === 'running';
	const mine = running && terminal.controller === 'user';

	const act = async (action: 'takeover' | 'release') => {
		setBusy(true);
		setError(undefined);
		try {
			const result = await api<{ terminal?: ITerminalInfo }>('POST', `/v1/terminals/${terminal.terminalId}/${action}`);
			// 接管后马上可以输入，不等列表刷新。
			const updated = result.terminal;
			if (updated) queryClient.setQueryData<ITerminalInfo[]>(queryKeys.terminals, list => list?.map(item => item.terminalId === updated.terminalId ? updated : item));
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	};

	return (
		<>
			{/* 在用的不写谁在用：标签的颜色和右边的按钮已经表示了。 */}
			<div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-line bg-pane px-3 py-1.5 text-xs">
				{/* 留够最窄宽度：放不下时右边的按钮换到下一行，不和左边的信息叠在一起。 */}
				<div className="flex min-w-48 flex-1 items-center gap-1.5 text-fg-2">
					<SquareTerminal size={14} className="shrink-0 text-fg-3" />
					<span className="min-w-0 truncate font-mono text-[11px]" title={terminal.cwd}>{terminal.cwd}</span>
					{/* 你建的不写。 */}
					{terminal.createdBy && (
						<>
							<span className="text-fg-3">·</span>
							<span className="max-w-32 shrink-0 truncate">{creator?.name ?? '未知成员'} 创建</span>
						</>
					)}
					{!running && (
						<>
							<span className="text-fg-3">·</span>
							<span className="shrink-0 text-fg-3">{terminalStatus(terminal)}</span>
						</>
					)}
				</div>
				<div className="flex shrink-0 items-center gap-1.5">
					{running && !mine && <Button title="接管后才能输入" disabled={busy} onClick={() => void act('takeover')}><Hand size={13} />接管</Button>}
					{mine && <Button disabled={busy} onClick={() => void act('release')}><Bot size={13} />交给 AI</Button>}
				</div>
				{/* 成员请你接管时写明要你做什么，交出去后消失。 */}
				{running && terminal.takeoverRequests.map(item => (
					<div key={item.memberId} className="basis-full text-accent">{memberById.get(item.memberId)?.name ?? '未知成员'} 请你接管：{item.request}</div>
				))}
				{error && <div className="basis-full text-danger">操作失败：{error}</div>}
			</div>
			<TerminalView terminal={terminal} interactive={mine} />
		</>
	);
}

export function terminalStatus(terminal: ITerminalInfo): string {
	if (terminal.status === 'exited') return `已退出（退出码 ${terminal.exitCode ?? '未知'}）`;
	return terminal.controller === 'user' ? '由你操作' : 'AI 正在使用';
}

/** 关闭还在运行的终端前确认：里面的程序会结束。 */
export function CloseTerminal({ terminal, onDone }: { terminal: ITerminalInfo; onDone: () => void }) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const close = async () => {
		setBusy(true);
		setError(undefined);
		try {
			await api('POST', `/v1/terminals/${terminal.terminalId}/close`);
			onDone();
		} catch (caught) {
			setError(errorMessage(caught));
			setBusy(false);
		}
	};
	return (
		<ConfirmDialog
			open
			onOpenChange={open => !open && onDone()}
			title="关闭该终端？"
			detail="其中的程序仍在运行，关闭将终止该程序。"
			confirmLabel="关闭"
			busy={busy}
			error={error}
			onConfirm={() => void close()}
		/>
	);
}

export function NewTerminalDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (terminalId: string) => void }) {
	const queryClient = useQueryClient();
	// 默认路径是运行时给的用户目录，和选目录弹窗共用一次查询。没改过时显示它；删空时运行时也用它。
	const home = useDirectories(null).data?.home;
	const [edited, setEdited] = useState<string>();
	const cwd = edited ?? home ?? '';
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	// 只差最后一级不存在时记下这个路径：提示会新建，按钮变成「新建目录并打开」，再点一次才建（打错字也会建出目录）。改了路径就作废。
	const [missing, setMissing] = useState<string>();
	const createDirectory = missing !== undefined;
	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setError(undefined);
		try {
			const { terminal } = await api<{ terminal: ITerminalInfo }>('POST', '/v1/terminals', { ...cwd.trim() && { cwd: cwd.trim() }, ...createDirectory && { createDirectory } });
			await queryClient.invalidateQueries({ queryKey: queryKeys.terminals });
			onCreated(terminal.terminalId);
			onClose();
		} catch (caught) {
			if (caught instanceof ApiError && caught.code === 'directory_missing') setMissing(cwd.trim());
			else setError(errorMessage(caught));
			setBusy(false);
		}
	};
	return (
		<Dialog open onOpenChange={open => !open && onClose()} title="新建终端" width="w-[480px]">
			<form onSubmit={event => void submit(event)} className="space-y-4">
				<DirectoryInput label="起始目录" placeholder={home ?? ''} pickerTitle="选择起始目录" value={cwd} onChange={value => {
					setEdited(value);
					setMissing(undefined);
				}} className="font-mono" />
				{error && <div className="text-[13px] text-danger">{error}</div>}
				{!error && createDirectory && (
					<div className="flex items-center gap-1.5 text-[13px] text-fg-2">
						<FolderPlus size={14} className="shrink-0 text-fg-3" />
						<span className="min-w-0 break-all">{missing} 尚不存在，将新建该目录</span>
					</div>
				)}
				<div className="flex justify-end">
					<Button type="submit" variant="primary" disabled={busy}>{createDirectory ? '新建目录并打开' : '新建'}</Button>
				</div>
			</form>
		</Dialog>
	);
}
