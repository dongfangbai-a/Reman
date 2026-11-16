import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ChevronRight, Plus, X } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api/client.ts';
import { useMcp } from '../api/directory.ts';
import { queryKeys } from '../api/keys.ts';
import { useMembers } from '../api/queries.ts';
import type { BuiltinSource, IMcpServerInfo, IMcpSnapshot, IMember } from '../api/types.ts';
import { errorMessage } from '../lib/errors.ts';
import { BackLink } from '../ui/BackLink.tsx';
import { Button, IconButton } from '../ui/Button.tsx';
import { Choice } from '../ui/Choice.tsx';
import { CopyablePath } from '../ui/CopyablePath.tsx';
import { ConfirmDialog, Dialog, Field, INPUT_CLASS } from '../ui/Dialog.tsx';
import { Switch } from '../ui/Switch.tsx';
import { UsedBy } from '../ui/UsedBy.tsx';
import { SettingsPage } from './SettingsPage.tsx';

/** 内置事件来源：名字、要填的环境变量和说明。 */
const BUILTINS: Record<BuiltinSource, { readonly label: string; readonly env: readonly string[]; readonly hint: string }> = {
	github: { label: 'GitHub', env: ['GITHUB_TOKEN'], hint: '经典令牌，须具有 notifications 权限' },
	feishu: { label: '飞书', env: ['FEISHU_APP_ID', 'FEISHU_APP_SECRET'], hint: '飞书开放平台上企业自建应用的凭证' },
};

/** MCP：配置 MCP 服务器，看连接状态和工具。成员在成员页按服务器开关。 */
export function McpSettings() {
	const mcp = useMcp();
	const members = useMembers();
	const [editing, setEditing] = useState<IMcpServerInfo | 'new'>();
	const data = mcp.data;
	return (
		<SettingsPage>
			<BackLink to="/settings" label="设置" />
			<div className="mb-1 flex items-center gap-2">
				<h1 className="flex-1 text-xl font-semibold">MCP</h1>
				{data?.path && <Button variant="primary" onClick={() => setEditing('new')}><Plus size={14} />添加</Button>}
			</div>
			<div className="text-[13px] text-fg-2">MCP 服务器提供更多工具，可在成员页按服务器为 AI 成员开启或关闭。</div>
			{data?.path && <div className="mb-5"><CopyablePath path={data.path} /></div>}
			{mcp.isPending && <div className="text-center text-[13px] text-fg-3">正在加载…</div>}
			{mcp.isError && <div className="text-[13px] text-danger">加载失败：{mcp.error.message}</div>}
			{data?.error && <div className="mb-4 rounded-xl border border-danger/40 bg-raised px-4 py-3 text-[13px] text-danger">{data.error}</div>}
			{data && (
				<div className="flex flex-col gap-3">
					{data.servers.length === 0 && !data.error && (
						<div className="rounded-xl border border-line bg-raised px-4 py-3 text-[13px] text-fg-3">暂无 MCP 服务器</div>
					)}
					{data.servers.map(server => <ServerCard key={server.name} server={server} members={members.data} onEdit={() => setEditing(server)} />)}
				</div>
			)}
			{editing && data && <ServerDialog server={editing === 'new' ? undefined : editing} existing={data.servers.map(server => server.name)} onClose={() => setEditing(undefined)} />}
		</SettingsPage>
	);
}

/** 选用了这个服务器的 AI 成员。 */
function serverUsers(members: readonly IMember[] | undefined, name: string): IMember[] {
	return (members ?? []).filter(member => member.type === 'ai' && !member.deleted && !!member.tools?.includes(`mcp:${name}`));
}

function ServerCard({ server, members, onEdit }: { server: IMcpServerInfo; members: readonly IMember[] | undefined; onEdit: () => void }) {
	const queryClient = useQueryClient();
	const [expanded, setExpanded] = useState(false);
	const [confirming, setConfirming] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const users = serverUsers(members, server.name);

	const send = async (method: 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown) => {
		setError(undefined);
		setBusy(true);
		try {
			queryClient.setQueryData(queryKeys.mcp, await api<IMcpSnapshot>(method, path, body));
			return true;
		} catch (caught) {
			setError(errorMessage(caught));
			return false;
		} finally {
			setBusy(false);
		}
	};
	const base = `/v1/mcp/servers/${encodeURIComponent(server.name)}`;
	const target = server.builtin ? BUILTINS[server.builtin].label : server.transport === 'stdio' ? [server.command, ...server.args].join(' ') : server.url;

	return (
		<section className="@container rounded-xl border border-line bg-raised">
			{/* 窄的时候名称和按钮各占一行：名称那行自己会换行，按钮组整组掉到下一行、靠右。 */}
			<div className="flex flex-wrap items-start gap-x-3 gap-y-2 px-4 py-3">
				{server.transport && (
					<span className="pt-0.5">
						<Switch checked={server.status !== 'disabled'} label={`启用 ${server.name}`} disabled={busy} onChange={enabled => void send('PUT', `${base}/disabled`, { disabled: !enabled })} />
					</span>
				)}
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
						<span className="min-w-0 truncate font-mono text-[13px] font-medium">{server.name}</span>
						{server.builtin && <span className="tag">内置</span>}
						{server.channel && <Link to="/settings/external" className="tag whitespace-nowrap hover:border-accent hover:text-accent" title="推送外部事件，可在设置的「事件」中查看">事件来源</Link>}
						<Status server={server} />
					</div>
					{target && <div className="truncate font-mono text-xs text-fg-3" title={target}>{target}</div>}
				</div>
				<div className="flex shrink-0 gap-1.5 @max-[28rem]:w-full @max-[28rem]:justify-end">
					{server.transport && <Button className="h-8 px-2.5" disabled={busy} onClick={onEdit}>编辑</Button>}
					{server.transport && <Button className="h-8 px-2.5" disabled={busy || server.status === 'connecting' || server.status === 'disabled'} onClick={() => void send('POST', `${base}/reconnect`)}>重新连接</Button>}
					<Button className="h-8 px-2.5" disabled={busy} onClick={() => setConfirming(true)}>删除</Button>
				</div>
			</div>
			{server.status === 'failed' && server.error && (
				<pre className="mx-4 mb-3 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md bg-page px-3 py-2 font-mono text-xs text-danger">{server.error}</pre>
			)}
			{error && !confirming && <div className="mx-4 mb-3 text-[13px] text-danger">{error}</div>}
			{server.tools.length > 0 && (
				<div className="border-t border-line">
					<button type="button" onClick={() => setExpanded(value => !value)} className="flex w-full items-center gap-1 px-4 py-2 text-xs text-fg-3 hover:text-fg-2">
						<ChevronRight size={13} className={clsx('transition-transform', expanded && 'rotate-90')} />工具 {server.tools.length} 个
					</button>
					{expanded && (
						<div className="divide-y divide-line border-t border-line">
							{server.tools.map(tool => (
								<div key={tool.name} className="flex items-center gap-2 px-4 py-1.5">
									<span className="shrink-0 font-mono text-xs" title={tool.toolName}>{tool.name}</span>
									{tool.readOnly && <span className="tag">只读</span>}
									<span className="min-w-0 flex-1 truncate text-xs text-fg-3" title={tool.description}>{tool.description}</span>
								</div>
							))}
						</div>
					)}
				</div>
			)}
			<ConfirmDialog
				open={confirming}
				onOpenChange={setConfirming}
				title={`删除 MCP 服务器 ${server.name}？`}
				detail={users.length > 0
					? (
						<>
							<p>删除后，正在使用的成员将失去该服务器的工具。成员配置保持不变，成员页会提示服务器不存在。</p>
							<UsedBy members={users} />
						</>
					)
					: '没有成员使用该服务器。'}
				confirmLabel="删除"
				busy={busy}
				error={confirming ? error : undefined}
				onConfirm={() => void send('DELETE', base).then(ok => ok && setConfirming(false))}
			/>
		</section>
	);
}

function Status({ server }: { server: IMcpServerInfo }) {
	if (server.status === 'connected') {
		// 只推事件的来源没有工具，不写「0 个工具」。
		const tools = server.channel && server.tools.length === 0 ? '' : `，${server.tools.length} 个工具`;
		return <span className="flex shrink-0 items-center gap-1 text-xs text-fg-2"><span className="size-2 rounded-full bg-success" />已连接{tools}</span>;
	}
	if (server.status === 'connecting') return <span className="flex shrink-0 items-center gap-1 text-xs text-fg-3"><span className="size-2 rounded-full bg-warning" />正在连接</span>;
	if (server.status === 'disabled') return <span className="flex shrink-0 items-center gap-1 text-xs text-fg-3"><span className="size-2 rounded-full bg-fg-3" />已停用</span>;
	return <span className="flex shrink-0 items-center gap-1 text-xs text-danger"><span className="size-2 rounded-full bg-danger" />连接失败</span>;
}

/** 环境变量或请求头的一行。existing：已有的项，值不显示，留空表示不改；undecryptable：已有的值解不开，要重新填。 */
interface IPair {
	readonly key: number;
	readonly name: string;
	readonly value: string;
	readonly existing: boolean;
	readonly undecryptable: boolean;
}

let nextKey = 0;

function pairs(names: readonly string[], undecryptable: readonly string[]): IPair[] {
	return names.map(name => ({ key: nextKey++, name, value: '', existing: true, undecryptable: undecryptable.includes(name) }));
}

/** 补上还没有的项，值留空。 */
function withNames(rows: readonly IPair[], names: readonly string[]): IPair[] {
	return [...rows, ...names.filter(name => !rows.some(row => row.name.trim() === name)).map(name => ({ key: nextKey++, name, value: '', existing: false, undecryptable: false }))];
}

/** 写进配置的对象：已有的项留空时传 null，沿用原来的值。 */
function pairsValue(rows: readonly IPair[]): Record<string, string | null> {
	return Object.fromEntries(rows.filter(row => row.name.trim()).map(row => [row.name.trim(), row.existing && !row.value ? null : row.value]));
}

/** 添加或编辑一个服务器。添加时也可以粘贴常见客户端的 JSON 配置，一次加好多个。 */
function ServerDialog({ server, existing, onClose }: { server: IMcpServerInfo | undefined; existing: readonly string[]; onClose: () => void }) {
	const queryClient = useQueryClient();
	const [pasting, setPasting] = useState(false);
	const [name, setName] = useState('');
	const [kind, setKind] = useState<'stdio' | 'http' | 'builtin'>(server?.builtin ? 'builtin' : server?.transport ?? 'stdio');
	const [builtin, setBuiltin] = useState<BuiltinSource>(server?.builtin ?? 'github');
	const [command, setCommand] = useState(server?.command ?? '');
	const [args, setArgs] = useState(server?.args.join('\n') ?? '');
	const [cwd, setCwd] = useState(server?.cwd ?? '');
	const [env, setEnv] = useState(() => pairs(server?.envNames ?? [], server?.undecryptableNames ?? []));
	const [url, setUrl] = useState(server?.url ?? '');
	const [headers, setHeaders] = useState(() => pairs(server?.headerNames ?? [], server?.undecryptableNames ?? []));
	const [json, setJson] = useState('');
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();

	const put = async (serverName: string, body: object) => {
		queryClient.setQueryData(queryKeys.mcp, await api<IMcpSnapshot>('PUT', `/v1/mcp/servers/${encodeURIComponent(serverName)}`, body));
	};
	const save = async () => {
		setError(undefined);
		setBusy(true);
		try {
			const serverName = server?.name ?? name.trim();
			if (!serverName) throw new Error('请填写名字');
			if (!server && existing.includes(serverName)) throw new Error(`已存在服务器 ${serverName}`);
			await put(serverName, kind === 'builtin' ? { builtin, env: pairsValue(env) } : kind === 'stdio'
				? { command: command.trim(), args: args.split('\n').map(line => line.trim()).filter(Boolean), env: pairsValue(env), cwd: cwd.trim() || null }
				: { url: url.trim(), headers: pairsValue(headers) });
			onClose();
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	};
	const savePasted = async () => {
		setError(undefined);
		let servers: Record<string, unknown>;
		try {
			const parsed: unknown = JSON.parse(json);
			const value = isRecord(parsed) && isRecord(parsed['mcpServers']) ? parsed['mcpServers'] : parsed;
			if (!isRecord(value) || 'command' in value || 'url' in value || 'builtin' in value) throw new Error();
			servers = value;
		} catch {
			setError('粘贴的内容须为 JSON，包含 mcpServers 或「名称: 配置」');
			return;
		}
		if (Object.keys(servers).length === 0) {
			setError('其中没有服务器');
			return;
		}
		setBusy(true);
		const added: string[] = [];
		const failed: string[] = [];
		for (const [serverName, config] of Object.entries(servers)) {
			if (existing.includes(serverName)) {
				failed.push(`${serverName}：已存在同名服务器，未添加`);
				continue;
			}
			try {
				await put(serverName, isRecord(config) ? config : {});
				added.push(serverName);
			} catch (caught) {
				failed.push(`${serverName}：${errorMessage(caught)}`);
			}
		}
		setBusy(false);
		if (failed.length === 0) onClose();
		else setError([...added.length > 0 ? [`已添加：${added.join('、')}`] : [], ...failed].join('\n'));
	};

	/** 名字是不是按内置来源预先填的。 */
	const isBuiltinName = (value: string) => (Object.keys(BUILTINS) as string[]).includes(value.trim());
	const chooseBuiltin = (item: BuiltinSource) => {
		// 换来源时去掉上一个来源要填、还没填的项。
		setEnv(rows => withNames(kind === 'builtin' ? rows.filter(row => row.existing || row.value || !BUILTINS[builtin].env.includes(row.name.trim())) : rows, BUILTINS[item].env));
		setBuiltin(item);
		setKind('builtin');
		if (!server && (!name.trim() || isBuiltinName(name))) setName(existing.includes(item) ? '' : item);
	};
	const chooseServer = () => {
		if (kind !== 'builtin') return;
		setEnv(rows => rows.filter(row => row.existing || row.value || !BUILTINS[builtin].env.includes(row.name.trim())));
		setKind('stdio');
		if (isBuiltinName(name)) setName('');
	};
	const nameInput = (
		<div>
			<div className="mb-1 flex items-center">
				<label htmlFor="mcp-server-name" className="flex-1 text-[13px] font-medium">名字</label>
				{kind !== 'builtin' && <button type="button" className="text-xs text-accent hover:underline" onClick={() => setPasting(true)}>粘贴 JSON</button>}
			</div>
			<input id="mcp-server-name" value={name} onChange={event => setName(event.target.value)} className={`${INPUT_CLASS} font-mono`} spellCheck={false} />
			<div className="mt-1 text-xs text-fg-3">英文字母、数字、横杠和下划线，将写入工具名。创建后不能修改。</div>
		</div>
	);
	const pasted = kind !== 'builtin' && pasting;

	const footer = (
		<div className="flex items-start gap-2 border-t border-line px-5 py-3">
			<div className="min-w-0 flex-1 whitespace-pre-wrap text-[13px] text-danger">{error}</div>
			<Button disabled={busy} onClick={onClose}>取消</Button>
			<Button variant="primary" disabled={busy} onClick={() => void (pasted ? savePasted() : save())}>{server ? '保存' : '添加'}</Button>
		</div>
	);
	return (
		<Dialog open onOpenChange={open => !open && onClose()} title={server ? `编辑 ${server.name}` : '添加 MCP 服务器'} width="w-[520px]" footer={footer}>
			{!server && (
				<div className="mb-4 flex gap-1.5" role="radiogroup" aria-label="添加类型">
					<Choice checked={kind !== 'builtin'} onClick={() => chooseServer()}>MCP 服务器</Choice>
					<Choice checked={kind === 'builtin'} onClick={() => chooseBuiltin(builtin)}>内置事件来源</Choice>
				</div>
			)}
			{kind === 'builtin' && (
				<div className="flex flex-col gap-4">
					<div>
						<div className="mb-1 text-[13px] font-medium">来源</div>
						<div className="flex gap-1.5" role="radiogroup" aria-label="来源">
							{(Object.keys(BUILTINS) as BuiltinSource[]).map(item => (
								<Choice key={item} checked={builtin === item} onClick={() => chooseBuiltin(item)}>{BUILTINS[item].label}</Choice>
							))}
						</div>
					</div>
					{!server && nameInput}
					<div>
						<Pairs label="环境变量" rows={env} onChange={setEnv} />
						<div className="mt-1 text-xs text-fg-3">{BUILTINS[builtin].hint}</div>
					</div>
				</div>
			)}
			{pasted && (
				<div>
					<div className="mb-1 flex items-center">
						<span className="flex-1 text-[13px] font-medium">配置</span>
						<button type="button" className="text-xs text-accent hover:underline" onClick={() => setPasting(false)}>改为填写</button>
					</div>
					<textarea
						value={json}
						onChange={event => setJson(event.target.value)}
						rows={12}
						spellCheck={false}
						aria-label="配置"
						placeholder={'{\n  "mcpServers": {\n    "名字": { "command": "npx", "args": ["-y", "..."] }\n  }\n}'}
						className="field-textarea font-mono text-xs"
					/>
					<div className="mt-1 text-xs text-fg-3">粘贴其他客户端的配置，mcpServers 中的服务器将全部添加。</div>
				</div>
			)}
			{kind !== 'builtin' && !pasted && (
				<div className="flex flex-col gap-4">
					{!server && nameInput}
					<div className="flex gap-1.5" role="radiogroup" aria-label="类型">
						<Choice checked={kind === 'stdio'} onClick={() => setKind('stdio')}>本地命令</Choice>
						<Choice checked={kind === 'http'} onClick={() => setKind('http')}>远程地址</Choice>
					</div>
					{kind === 'stdio'
						? (
							<>
								<Field label="命令">
									<input value={command} onChange={event => setCommand(event.target.value)} placeholder="npx" className={`${INPUT_CLASS} font-mono`} spellCheck={false} />
								</Field>
								<Field label="参数" hint="每行一个">
									<textarea
										value={args}
										onChange={event => setArgs(event.target.value)}
										rows={3}
										spellCheck={false}
										className="field-textarea font-mono"
									/>
								</Field>
								<Field label="工作目录" hint="可选">
									<input value={cwd} onChange={event => setCwd(event.target.value)} className={`${INPUT_CLASS} font-mono`} spellCheck={false} />
								</Field>
								<Pairs label="环境变量" rows={env} onChange={setEnv} />
							</>
						)
						: (
							<>
								<Field label="地址">
									<input value={url} onChange={event => setUrl(event.target.value)} placeholder="https://" className={`${INPUT_CLASS} font-mono`} spellCheck={false} />
								</Field>
								<Pairs label="请求头" rows={headers} onChange={setHeaders} />
							</>
						)}
				</div>
			)}
		</Dialog>
	);
}

/** 环境变量或请求头：每项一行，名字加值。已有的值不显示，留空表示不改；解不开的标红。 */
function Pairs({ label, rows, onChange }: { label: string; rows: readonly IPair[]; onChange: (rows: IPair[]) => void }) {
	const set = (key: number, patch: Partial<IPair>) => onChange(rows.map(row => row.key === key ? { ...row, ...patch } : row));
	return (
		<div>
			<div className="mb-1 flex items-center">
				<span className="text-[13px] font-medium">{label}</span>
				<button type="button" onClick={() => onChange([...rows, { key: nextKey++, name: '', value: '', existing: false, undecryptable: false }])} className="ml-auto text-xs text-accent hover:underline">添加</button>
			</div>
			{rows.length === 0 && <div className="text-xs text-fg-3">无</div>}
			<div className="flex flex-col gap-1.5">
				{rows.map(row => (
					<div key={row.key} className="flex items-center gap-1.5">
						<input
							value={row.name}
							onChange={event => set(row.key, { name: event.target.value })}
							disabled={row.existing}
							placeholder="名字"
							aria-label={`${label}名字`}
							className={`${INPUT_CLASS} w-2/5 font-mono`}
							spellCheck={false}
						/>
						<input
							value={row.value}
							onChange={event => set(row.key, { value: event.target.value })}
							placeholder={row.undecryptable ? '须重新填写' : row.existing ? '保持不变' : '值'}
							aria-label={`${label}的值`}
							title={row.undecryptable ? '原值已加密保存，但无法用当前数据目录的密钥解密' : undefined}
							type="password"
							autoComplete="off"
							className={clsx(INPUT_CLASS, 'min-w-0 flex-1 font-mono', row.undecryptable && !row.value && 'border-danger placeholder:text-danger')}
						/>
						<IconButton label="删除" onClick={() => onChange(rows.filter(item => item.key !== row.key))}><X size={14} /></IconButton>
					</div>
				))}
			</div>
		</div>
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
