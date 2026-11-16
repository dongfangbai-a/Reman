import * as Popover from '@radix-ui/react-popover';
import { useQueryClient } from '@tanstack/react-query';
import { TriangleAlert } from 'lucide-react';
import qrcode from 'qrcode-generator';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client.ts';
import { queryKeys } from '../api/keys.ts';
import { useRemote } from '../api/system.ts';
import type { IRemoteStatus } from '../api/types.ts';
import { useCopy } from '../lib/clipboard.ts';
import { errorMessage } from '../lib/errors.ts';
import { BackLink } from '../ui/BackLink.tsx';
import { Button } from '../ui/Button.tsx';
import { INPUT_CLASS } from '../ui/Dialog.tsx';
import { Switch } from '../ui/Switch.tsx';
import { TextButton } from '../ui/TextButton.tsx';
import { SettingsPage } from './SettingsPage.tsx';

/** 二维码显示多久后自动收起。 */
const QR_VISIBLE_MS = 10_000;

/** 公网访问：Cloudflare 隧道，在手机和其他设备上打开网页端。 */
export function RemoteSettings() {
	const remote = useRemote();
	const queryClient = useQueryClient();
	const [pending, setPending] = useState(false);
	const [hostname, setHostname] = useState('');
	const [token, setToken] = useState('');
	const data = remote.data;

	useEffect(() => {
		if (!data) return;
		setHostname(data.hostname ?? '');
		setToken('');
	}, [data?.hostname]);

	/** 保存设置；失败时把原因交回去，由点的地方显示（域名令牌、路径各显示各的）。 */
	const save = async (body: Record<string, unknown>): Promise<string | undefined> => {
		setPending(true);
		try {
			queryClient.setQueryData(queryKeys.remote, await api<IRemoteStatus>('PUT', '/v1/remote', body));
			if ('token' in body) setToken('');
			return undefined;
		} catch (caught) {
			return errorMessage(caught);
		} finally {
			setPending(false);
		}
	};

	return (
		<SettingsPage>
			<BackLink to="/settings" label="设置" />
			<h1 className="mb-1 text-xl font-semibold">公网访问</h1>
			<div className="mb-5 text-[13px] text-fg-2">通过 Cloudflare 隧道或 Tailscale 在手机和其他设备上打开网页端，运行时仍只监听本机。</div>
			{remote.isPending && <div className="text-center text-[13px] text-fg-3">正在加载…</div>}
			{remote.isError && <div className="text-[13px] text-danger">加载失败：{remote.error.message}</div>}
			{data && (
				<div className="space-y-4">
					{data.enabled && data.lastOrigin && data.lastOrigin !== data.origin && (
						<div className="flex items-start gap-1.5 rounded-lg border border-line bg-raised px-3 py-2 text-[13px] text-warning">
							<TriangleAlert size={14} className="mt-0.5 shrink-0" />
							<span>端口已变，Cloudflare 隧道的服务地址改为 <span className="font-mono">{data.origin}</span>。</span>
						</div>
					)}
					<Tunnel data={data} pending={pending} hostname={hostname} token={token} setHostname={setHostname} setToken={setToken} save={save} />
					<div className="text-xs text-fg-3">域名要有访问验证（Access），否则任何知道域名的人都能操作运行时。</div>
					<Tailscale data={data} pending={pending} save={save} />
				</div>
			)}
		</SettingsPage>
	);
}

/** 开关旁边写缺什么；都齐了时没有。 */
function missingFor(data: IRemoteStatus, hostname: string, token: string): string | undefined {
	if (!hostname.trim()) return '先填域名';
	if (!data.tokenTail && !token.trim()) return '先填令牌';
	if (data.cloudflared.kind !== 'ready') return '先下载 cloudflared';
	return undefined;
}

const PROCESS_LABELS = { off: '未连接', starting: '正在连接', connected: '已连接', error: '失败' } as const;

/** 隧道：开关、状态、日志、域名和令牌，下面是 cloudflared 和手机上的入口。 */
function Tunnel({ data, pending, hostname, token, setHostname, setToken, save }: {
	data: IRemoteStatus;
	pending: boolean;
	hostname: string;
	token: string;
	setHostname: (value: string) => void;
	setToken: (value: string) => void;
	save: (body: Record<string, unknown>) => Promise<string | undefined>;
}) {
	const [error, setError] = useState<string>();
	const [pathRow, setPathRow] = useState(false);
	const [path, setPath] = useState(data.cloudflaredPath ?? '');
	// 令牌平时按填了值的样子显示（圆点加末四位），点进去就是一个空输入框；没输入就走了、或者保存成功，都回到显示状态。
	const [editing, setEditing] = useState(false);
	useEffect(() => {
		setEditing(false);
		setToken('');
	}, [data.tokenTail]);
	// 保存成功、或者自己把输入的内容删光了，都回到显示的样子。
	useEffect(() => {
		if (!token) setEditing(false);
	}, [token]);
	const missing = missingFor(data, hostname, token);
	const dirty = hostname.trim() !== (data.hostname ?? '') || token.trim() !== '';
	const process = data.process;

	return (
		<section className="rounded-xl border border-line bg-raised">
			<div className="flex items-center gap-3 px-4 pt-4 pb-2">
				<h2 className="flex-1 font-semibold">隧道</h2>
				{!data.enabled && missing && <span className="text-xs text-fg-3">{missing}</span>}
				{/* 已经打开的能关掉：想关的时候不该因为域名被清空了就关不掉。 */}
				<Switch checked={data.enabled} label="公网访问" disabled={pending || (!data.enabled && !!missing)} onChange={async enabled => setError(await save({ enabled }))} />
			</div>
			<div className="divide-y divide-line border-t border-line">
				<div className="flex h-10 items-center gap-3 px-4 text-[13px]">
					<span className="w-20 shrink-0 text-fg-2">状态</span>
					<span
						className={process.kind === 'error' ? 'min-w-0 flex-1 truncate text-danger' : process.kind === 'connected' ? 'min-w-0 flex-1 text-success' : 'min-w-0 flex-1 text-fg-2'}
						title={process.error ?? undefined}
					>
						{PROCESS_LABELS[process.kind]}{process.kind === 'error' && process.error ? `：${process.error}` : ''}
					</span>
				</div>
				<form onSubmit={event => {
					event.preventDefault();
					if (dirty && !pending) void save({ hostname, ...token.trim() ? { token } : {} }).then(setError);
				}}>
					<label className="flex h-10 items-center gap-3 px-4 text-[13px]">
						<span className="w-20 shrink-0 text-fg-2">域名</span>
						<input value={hostname} onChange={event => setHostname(event.target.value)} placeholder="human.example.com" aria-label="域名" className={INPUT_CLASS} />
					</label>
					<div className="flex h-10 items-center gap-3 px-4 text-[13px]">
						<span className="w-20 shrink-0 text-fg-2">令牌</span>
						<input
							type={editing ? 'password' : 'text'}
							value={editing ? token : data.tokenTail ? `${'•'.repeat(8)}${data.tokenTail}` : ''}
							onFocus={() => { if (data.tokenTail) setEditing(true); }}
							// 输入过内容就不清：点「保存」会先失焦，清了就又回到没填的样子，令牌存不上。
							onBlur={() => {
								if (!token.trim()) setEditing(false);
							}}
							onChange={event => {
								setEditing(true);
								setToken(event.target.value);
							}}
							placeholder={data.tokenTail ? '粘贴新的令牌' : '在 Cloudflare 的隧道页复制'}
							aria-label="隧道令牌"
							autoComplete="off"
							className={INPUT_CLASS}
						/>
					</div>
					<div className="flex items-center justify-end gap-2 px-4 py-2">
						{error && <span className="text-xs text-danger">{error}</span>}
						<Button type="submit" disabled={!dirty || pending}>保存</Button>
					</div>
				</form>
				<Cloudflared data={data} pending={pending} pathRow={pathRow} setPathRow={setPathRow} path={path} setPath={setPath} save={save} />
				<Phone data={data} />
			</div>
		</section>
	);
}

/**
 * Tailscale：运行时不管它的进程，只把域名放进白名单。
 * 用 tailscale serve 把本机映射成 ts.net 域名，手机在这个域名上打开就行，不用起 cloudflared。
 */
function Tailscale({ data, pending, save }: {
	data: IRemoteStatus;
	pending: boolean;
	save: (body: Record<string, unknown>) => Promise<string | undefined>;
}) {
	const saved = data.hostnames[0];
	// 端口跟着运行时走，别在说明里写死。
	const port = new URL(data.origin).port;
	const [hostname, setHostname] = useState(saved ?? '');
	const [error, setError] = useState<string>();
	useEffect(() => setHostname(saved ?? ''), [saved]);
	const dirty = hostname.trim().toLowerCase() !== (saved ?? '');
	return (
		<section className="rounded-xl border border-line bg-raised">
			<div className="px-4 pb-3 pt-4">
				<h2 className="font-semibold">Tailscale</h2>
				<div className="mt-1 text-[13px] text-fg-2">
					在电脑上运行 <span className="font-mono">tailscale serve --bg {port}</span>，本机就有了一个 ts.net 域名；把那个域名填在这里，运行时只认它，不管 Tailscale 的进程。
				</div>
			</div>
			<div className="divide-y divide-line border-t border-line">
				<form className="flex h-10 items-center gap-3 px-4 text-[13px]" onSubmit={event => {
					event.preventDefault();
					if (dirty && !pending) void save({ hostnames: hostname.trim() ? [hostname] : [] }).then(setError);
				}}>
					<span className="w-20 shrink-0 text-fg-2">域名</span>
					<input value={hostname} onChange={event => setHostname(event.target.value)} placeholder="human.tail1234.ts.net" aria-label="Tailscale 域名" className={INPUT_CLASS} />
					<Button type="submit" className="shrink-0" disabled={!dirty || pending}>保存</Button>
				</form>
				{error && <div className="px-4 py-2 text-xs text-danger">{error}</div>}
				{saved && <Phone data={data} host={saved} />}
			</div>
		</section>
	);
}

/** cloudflared：装好的写版本，没装给下载；也能换成本机已有的。 */
function Cloudflared({ data, pending, pathRow, setPathRow, path, setPath, save }: {
	data: IRemoteStatus;
	pending: boolean;
	pathRow: boolean;
	setPathRow: (value: boolean) => void;
	path: string;
	setPath: (value: string) => void;
	save: (body: Record<string, unknown>) => Promise<string | undefined>;
}) {
	const [installing, setInstalling] = useState(false);
	const [error, setError] = useState<string>();
	const state = data.cloudflared;
	const downloading = state.kind === 'downloading' || installing;
	return (
		<>
			<div className="flex h-10 items-center gap-3 px-4 text-[13px]">
				<span className="w-20 shrink-0 text-fg-2">cloudflared</span>
				{state.kind === 'ready' && <span className="min-w-0 flex-1 truncate text-fg-2" title={state.path}>{state.version}</span>}
				{state.kind === 'missing' && <span className="min-w-0 flex-1 text-fg-2">{installing ? '正在下载' : '未下载'}</span>}
				{state.kind === 'downloading' && <span className="min-w-0 flex-1 text-fg-2" title={`${state.receivedBytes} / ${state.totalBytes} 字节`}>正在下载 {Math.round((state.receivedBytes / state.totalBytes) * 100)}%</span>}
				{(state.kind === 'failed' || state.kind === 'unsupported') && <span className="min-w-0 flex-1 truncate text-danger" title={state.reason}>{state.reason}</span>}
				{state.kind === 'missing' && (
					<Button disabled={pending || installing} onClick={() => {
						setError(undefined);
						setInstalling(true);
						void api('POST', '/v1/remote/install').catch(caught => setError(errorMessage(caught))).finally(() => setInstalling(false));
					}}>下载</Button>
				)}
				{!downloading && <TextButton onClick={() => setPathRow(!pathRow)} title={pathRow ? undefined : '使用本机已安装的 cloudflared'}>{pathRow ? '收起' : '指定路径'}</TextButton>}
			</div>
			{pathRow && (
				<form className="flex items-center gap-2 px-4 py-2" onSubmit={event => {
					event.preventDefault();
					void save({ cloudflaredPath: path.trim() || null }).then(setError);
				}}>
					<span className="w-20 shrink-0 text-[13px] text-fg-2">路径</span>
					<div className="min-w-0 flex-1"><input value={path} onChange={event => setPath(event.target.value)} placeholder="cloudflared 的绝对路径" aria-label="cloudflared 的路径" className={INPUT_CLASS} /></div>
					<Button type="submit" className="shrink-0" disabled={pending}>保存</Button>
					{data.cloudflaredPath && <TextButton onClick={() => {
						setPath('');
						void save({ cloudflaredPath: null }).then(setError);
					}}>清除</TextButton>}
				</form>
			)}
			{error && <div className="px-4 pb-2 text-xs text-danger">{error}</div>}
		</>
	);
}

/** 手机上打开：链接不显示，复制或出二维码时向运行时要一次。host 是「公网访问」里配的额外域名（Tailscale），不给时用隧道域名。 */
function Phone({ data, host }: { data: IRemoteStatus; host?: string }) {
	const { state: copied, copy } = useCopy();
	// 带令牌的链接点了按钮才要，只在这一个组件里放一会儿，关掉二维码就丢掉。
	const [link, setLink] = useState<string>();
	const [open, setOpen] = useState(false);
	const [left, setLeft] = useState(0);
	const [error, setError] = useState<string>();
	const [pending, setPending] = useState(false);

	const request = async (): Promise<string | undefined> => {
		setError(undefined);
		setPending(true);
		try {
			return (await api<{ url: string }>('POST', '/v1/remote/link', host ? { host } : {})).url;
		} catch (caught) {
			setError(errorMessage(caught));
			return undefined;
		} finally {
			setPending(false);
		}
	};

	// 二维码出现 10 秒后自动关掉，期间倒数。
	useEffect(() => {
		if (!open) return;
		const startedAt = Date.now();
		setLeft(Math.ceil(QR_VISIBLE_MS / 1000));
		const timer = window.setInterval(() => {
			const remaining = QR_VISIBLE_MS - (Date.now() - startedAt);
			setLeft(Math.max(0, Math.ceil(remaining / 1000)));
			if (remaining <= 0) {
				setOpen(false);
				window.clearInterval(timer);
			}
		}, 200);
		return () => window.clearInterval(timer);
	}, [open]);

	const usable = (host !== undefined || data.enabled) && !pending;
	const label = copied === 'copied' ? '已复制' : copied === 'failed' ? '复制失败' : '复制链接';
	return (
		<>
			<div className="flex h-10 items-center gap-3 px-4 text-[13px]">
				<span className="w-20 shrink-0 text-fg-2">手机上打开</span>
				<span className="ml-auto flex items-center gap-1.5">
					<Button disabled={!usable} title={usable ? undefined : '打开公网访问后才能用'} onClick={async () => {
						const url = await request();
						if (url) copy(url);
					}}>{label}</Button>
					<Popover.Root open={open} onOpenChange={next => {
						setOpen(next);
						if (!next) setLink(undefined);
					}}>
						<Popover.Trigger asChild>
							<Button disabled={!usable} onClick={async () => {
								const url = await request();
								if (!url) return;
								setLink(url);
								// 先写好倒数，免得弹出的一瞬间显示「0 秒后关闭」。
								setLeft(Math.ceil(QR_VISIBLE_MS / 1000));
								setOpen(true);
							}}>二维码</Button>
						</Popover.Trigger>
						<Popover.Portal>
							<Popover.Content align="end" sideOffset={6} collisionPadding={12} className="z-50 rounded-lg border border-line bg-raised p-3 shadow-lg">
								{link && <QrCode text={link} />}
								<div className="mt-2 text-center text-xs text-fg-3">{left} 秒后关闭</div>
							</Popover.Content>
						</Popover.Portal>
					</Popover.Root>
				</span>
			</div>
			{error && <div className="px-4 pb-2 text-xs text-danger">{error}</div>}
		</>
	);
}

/** 二维码：用 SVG 画，一张 path，四周的留白由白底给。 */
function QrCode({ text }: { text: string }) {
	const code = useMemo(() => {
		const qr = qrcode(0, 'M');
		qr.addData(text);
		qr.make();
		const count = qr.getModuleCount();
		let d = '';
		for (let row = 0; row < count; row += 1) {
			for (let column = 0; column < count; column += 1) {
				if (qr.isDark(row, column)) d += `M${column} ${row}h1v1h-1z`;
			}
		}
		return { d, count };
	}, [text]);
	const size = code.count + 8;
	return (
		<svg viewBox={`0 0 ${size} ${size}`} className="size-40 shrink-0 rounded-lg bg-white p-1" role="img" aria-label="手机上打开的链接的二维码">
			<rect width={size} height={size} fill="#ffffff" />
			<path d={code.d} fill="#000000" transform="translate(4 4)" shapeRendering="crispEdges" />
		</svg>
	);
}
