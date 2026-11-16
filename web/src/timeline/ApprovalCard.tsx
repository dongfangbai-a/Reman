import clsx from 'clsx';
import { ChevronRight, FileDiff, FilePlus, Globe, Lock, Plug, SquareTerminal, Terminal, Wrench, type LucideIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { api } from '../api/client.ts';
import type { ApprovalScope, IApproval } from '../api/types.ts';
import { errorMessage } from '../lib/errors.ts';
import { useNow } from '../lib/useNow.ts';
import { Button } from '../ui/Button.tsx';
import { ToolFileLink } from '../workbench/FileLink.tsx';
import { showKeys, useToolLabel } from './approvalText.ts';
import { CallSummary, editCounts, editsOf, EditsView, FileContent, isRecord, LineCounts, lineCount, Pre, TerminalLink } from './ToolCard.tsx';

const ICONS: Record<string, LucideIcon | undefined> = { shell: Terminal, terminal: SquareTerminal, write_file: FilePlus, edit_file: FileDiff, browser: Globe };

/** 参数的值超过这么多字或这么多行时先截断。 */
const LONG_VALUE = 200;
const LONG_LINES = 4;

/**
 * 审批卡片：头部写是哪个工具，中间写要做什么，下面写为什么要你批，最后是允许、拒绝。时间线底部的浮层和概况栏共用。
 * actions 放在头部最右边（浮层的翻页和收起）。
 */
export function ApprovalCard({ approval, className, actions }: { approval: IApproval; className?: string; actions?: ReactNode }) {
	const label = useToolLabel()(approval.toolName);
	const name = approval.toolName;
	const Icon = ICONS[name] ?? (name.includes('__') ? Plug : Wrench);
	return (
		<div className={clsx('overflow-hidden rounded-lg border border-line bg-raised text-[13px]', className)}>
			<div className="flex items-center gap-2 border-b border-line px-3 py-1.5">
				<span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-attention-soft text-attention"><Icon size={13} /></span>
				<span className="shrink-0 font-medium">{label}</span>
				{label !== name && <span className="min-w-0 truncate font-mono text-xs text-fg-3">{name}</span>}
				{approval.nestedIndex !== null && <span className="shrink-0 rounded bg-hover px-1 text-[11px] leading-4 text-fg-3">脚本中</span>}
				<Remaining expiresAt={approval.expiresAt} />
				{actions}
			</div>
			<div className="space-y-2 px-3 py-2">
				<CallDetail memberId={approval.memberId} name={name} args={approval.arguments} />
				<Reasons approval={approval} />
				<Decision approval={approval} />
			</div>
		</div>
	);
}

/** 还剩多久自动拒绝，不到 1 分钟时变红。compact 只写时间（收起的细栏里），悬停看完整的说法。 */
export function Remaining({ expiresAt, compact = false }: { expiresAt: number; compact?: boolean }) {
	const now = useNow();
	const remaining = Math.max(0, expiresAt - now);
	const seconds = Math.ceil(remaining / 1000);
	const time = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
	return (
		<span title={compact ? `${time} 后自动拒绝` : undefined} className={clsx('ml-auto shrink-0 text-xs tabular-nums', remaining < 60_000 ? 'text-danger' : 'text-fg-3')}>
			{compact ? time : `${time} 后自动拒绝`}
		</span>
	);
}

/** 要做什么：按工具显示，其他工具列参数。 */
function CallDetail({ memberId, name, args }: { memberId: string; name: string; args: unknown }) {
	const record = isRecord(args) ? args : {};
	const text = (key: string) => typeof record[key] === 'string' ? record[key] : '';
	switch (name) {
		case 'shell':
			return <Pre>{`$ ${text('command')}`}</Pre>;
		case 'terminal': {
			const id = text('terminal_id');
			return (
				<>
					<div className="flex flex-wrap items-center gap-x-2 text-fg-2">
						{id ? <>终端 <span className="font-mono text-xs text-fg">{id}</span><TerminalLink terminalId={id} /></> : '新终端'}
					</div>
					<Pre>{showKeys(text('input'))}</Pre>
				</>
			);
		}
		case 'write_file': {
			const content = text('content');
			return (
				<FileRow memberId={memberId} path={text('path')} notes={<>{record['overwrite'] === true ? '覆盖' : '新建'}，{lineCount(content)} 行</>}>
					<FileContent path={text('path')} content={content} />
				</FileRow>
			);
		}
		case 'edit_file': {
			const edits = editsOf(args);
			return (
				<FileRow memberId={memberId} path={text('path')} notes={<>{edits.length} 处 <LineCounts {...editCounts(edits)} /></>}>
					<EditsView edits={edits} />
				</FileRow>
			);
		}
		case 'browser':
			return (
				<>
					<div className="break-words"><CallSummary memberId={memberId} name={name} args={args} /></div>
					{record['action'] === 'evaluate' && <Pre>{text('script')}</Pre>}
				</>
			);
		default:
			return <ArgRows args={args} />;
	}
}

/** 写文件和改文件：一行写路径和概况，点开看内容或改动。 */
function FileRow({ memberId, path, notes, children }: { memberId: string; path: string; notes: ReactNode; children: ReactNode }) {
	const [open, setOpen] = useState(false);
	return (
		<div className="overflow-hidden rounded-md border border-line">
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen(value => !value)}
				className="flex w-full items-center gap-1.5 px-2 py-1 text-left font-mono text-xs hover:bg-hover"
			>
				<ChevronRight size={12} className={clsx('shrink-0 text-fg-3 transition-transform', open && 'rotate-90')} />
				<span className="min-w-0 flex-1 break-all"><ToolFileLink memberId={memberId} path={path}>{path}</ToolFileLink></span>
				<span className="shrink-0 font-sans text-fg-3">{notes}</span>
			</button>
			{open && <div className="border-t border-line p-2">{children}</div>}
		</div>
	);
}

/** 参数一行一个：名字、值；长的值先截断，点开看全部。 */
function ArgRows({ args }: { args: unknown }) {
	const [open, setOpen] = useState(false);
	const entries = isRecord(args) ? Object.entries(args).filter(([, value]) => value !== undefined).map(([key, value]) => ({ key, ...argText(value) })) : [];
	if (entries.length === 0) return null;
	const long = entries.some(({ text }) => text.length > LONG_VALUE || text.split('\n').length > LONG_LINES);
	return (
		<div className="space-y-1 rounded-md bg-code px-2 py-1.5 font-mono text-xs">
			{entries.map(({ key, text, json }) => (
				<div key={key} className="flex gap-2">
					<span className="shrink-0 text-fg-3">{key}</span>
					<span className={clsx('min-w-0 whitespace-pre-wrap', json ? 'break-all' : 'break-words', !open && 'line-clamp-4')}>{text}</span>
				</div>
			))}
			{long && <button type="button" onClick={() => setOpen(value => !value)} className="font-sans text-accent hover:underline">{open ? '收起' : '展开'}</button>}
		</div>
	);
}

/**
 * 参数值写成的文字：字符串照原样；字符串和数字的列表一项一行，不写方括号和引号；其他写成缩进的 JSON。
 * JSON 在任意字符处换行：按词换行时，放不下的长路径会整个挪到下一行，缩进单独留成一行空白。
 */
function argText(value: unknown): { text: string; json: boolean } {
	if (typeof value === 'string') return { text: value, json: false };
	if (Array.isArray(value) && value.every(item => typeof item === 'string' || typeof item === 'number')) return { text: value.join('\n'), json: false };
	return { text: JSON.stringify(value, null, 2), json: true };
}

/** 为什么要你批：一个原因一个标签，受保护的红色带锁、排在前面；每次都审批、没有别的原因时写「每次都审批」。 */
function Reasons({ approval }: { approval: IApproval }) {
	const tags = [
		...approval.protectedReasons.map(text => ({ text, guarded: true })),
		...approval.reasons.map(text => ({ text, guarded: false })),
	];
	if (tags.length === 0) tags.push({ text: '每次审批', guarded: false });
	return (
		<div className="flex flex-wrap items-center gap-1.5">
			<span className="text-xs text-fg-3">原因</span>
			{tags.map((tag, index) => (
				<span
					key={index}
					className={clsx('inline-flex max-w-full items-center gap-1 break-all rounded px-1.5 py-0.5 text-xs', tag.guarded ? 'bg-danger-soft text-danger' : 'bg-attention-soft text-attention')}
				>
					{tag.guarded && <Lock size={11} className="shrink-0" />}{tag.text}
				</span>
			))}
		</div>
	);
}

/** 写入文件和修改文件在设置里是一项，「本次运行中允许此工具」两个都算。 */
const FILE_TOOLS: ReadonlySet<string> = new Set(['write_file', 'edit_file']);

/**
 * 允许或拒绝；另有「本次运行中允许此工具」，脚本里的调用多一个「这段脚本里都允许」，要审批的终端调用多一个「这个终端里都允许」，受保护的调用都没有。
 * 写入文件和修改文件在设置里是一项，选了「本次运行中允许此工具」两个都算，悬停时写明。
 */
function Decision({ approval }: { approval: IApproval }) {
	const [denying, setDenying] = useState(false);
	const [reason, setReason] = useState('');
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();

	const act = async (path: string, body: object) => {
		setBusy(true);
		setError(undefined);
		try {
			await api('POST', `/v1/approvals/${approval.approvalId}/${path}`, body);
		} catch (caught) {
			setError(errorMessage(caught));
			setBusy(false);
		}
	};
	const approve = (scope: ApprovalScope) => void act('approve', { scope });
	const deny = () => void act('deny', { reason: reason.trim() || null });

	return (
		<div>
			{denying
				? (
					<div className="flex gap-2">
						<input
							autoFocus
							value={reason}
							onChange={event => setReason(event.target.value)}
							onKeyDown={event => {
								if (event.key === 'Enter' && !event.nativeEvent.isComposing) deny();
								if (event.key === 'Escape') setDenying(false);
							}}
							placeholder="拒绝原因（选填）"
							className="h-7 min-w-0 flex-1 rounded-md border border-line-strong bg-raised px-2 outline-none focus:border-accent"
						/>
						<Button disabled={busy} onClick={deny}>确认拒绝</Button>
						<Button variant="ghost" disabled={busy} onClick={() => setDenying(false)}>取消</Button>
					</div>
				)
				: (
					<div className="flex flex-wrap gap-2">
						<Button variant="primary" disabled={busy} onClick={() => approve('once')}>允许</Button>
						{approval.nestedIndex !== null && approval.protectedReasons.length === 0 && <Button disabled={busy} onClick={() => approve('code')}>允许本脚本中的所有调用</Button>}
						{approval.toolName === 'terminal' && approval.reasons.length > 0 && approval.protectedReasons.length === 0 && <Button disabled={busy} onClick={() => approve('terminal')}>允许该终端中的所有输入</Button>}
						{approval.protectedReasons.length === 0 && (
							<Button disabled={busy} title={FILE_TOOLS.has(approval.toolName) ? '写入文件和修改文件均适用' : undefined} onClick={() => approve('run')}>本次运行中允许此工具</Button>
						)}
						<Button disabled={busy} onClick={() => setDenying(true)}>拒绝</Button>
					</div>
				)}
			{error && <div className="mt-1 text-xs text-danger">操作失败：{error}</div>}
		</div>
	);
}
