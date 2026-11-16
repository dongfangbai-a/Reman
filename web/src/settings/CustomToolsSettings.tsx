import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ChevronRight, UsersRound } from 'lucide-react';
import { useState } from 'react';
import { api } from '../api/client.ts';
import { useCustomTools, useModels } from '../api/directory.ts';
import { queryKeys } from '../api/keys.ts';
import { useMembers } from '../api/queries.ts';
import type { CustomToolOrigin, IConfigField, ICustomToolInfo, ICustomToolsSnapshot, IKeyState, IMember, PublicValue } from '../api/types.ts';
import { errorMessage } from '../lib/errors.ts';
import { POLICY_LABELS } from '../members/aiForm.ts';
import { BackLink } from '../ui/BackLink.tsx';
import { Button } from '../ui/Button.tsx';
import { CopyablePath } from '../ui/CopyablePath.tsx';
import { ConfirmDialog, Dialog, Field, INPUT_CLASS } from '../ui/Dialog.tsx';
import { Select } from '../ui/Select.tsx';
import { Switch } from '../ui/Switch.tsx';
import { UsedBy } from '../ui/UsedBy.tsx';
import { SettingsPage } from './SettingsPage.tsx';

/** 设置页上的一项：读出来的工具，或者读不出来的文件夹。 */
interface IItem {
	readonly name: string;
	readonly origin: CustomToolOrigin;
	readonly directory: string;
	readonly tool: ICustomToolInfo | undefined;
	/** 读不出来的原因。 */
	readonly issue: string | undefined;
}

/** 内置的在前，然后是自己的，两组各按名字排。 */
function items(data: ICustomToolsSnapshot): IItem[] {
	return [
		...data.tools.map(tool => ({ name: tool.name, origin: tool.origin, directory: tool.directory, tool, issue: undefined })),
		...data.issues.map(issue => ({ name: issue.name, origin: issue.origin, directory: issue.directory, tool: undefined, issue: issue.message })),
	].sort((left, right) => (left.origin === right.origin ? 0 : left.origin === 'builtin' ? -1 : 1) || left.name.localeCompare(right.name));
}

/** 打开了这项自定义工具的 AI 成员。 */
export function customToolUsers(members: readonly IMember[] | undefined, name: string): IMember[] {
	return (members ?? []).filter(member => member.type === 'ai' && !member.deleted && !!member.tools?.includes(`custom:${name}`));
}

/** 自定义工具：一个文件夹一项，填配置、复制内置的、删除自己的。不在这里写代码：让成员写，或者直接改文件。 */
export function CustomToolsSettings() {
	const snapshot = useCustomTools();
	const members = useMembers();
	const [configuring, setConfiguring] = useState<ICustomToolInfo>();
	const data = snapshot.data;
	return (
		<SettingsPage>
			<BackLink to="/settings" label="设置" />
			<h1 className="mb-1 text-xl font-semibold">自定义工具</h1>
			<div className="text-[13px] text-fg-2">每个文件夹对应一项工具。配置了「创建自定义工具」技能的成员可自行编写工具。工具需在成员设置中启用。</div>
			{data?.directory && <div className="mb-5"><CopyablePath path={data.directory} /></div>}
			{snapshot.isPending && <div className="text-center text-[13px] text-fg-3">正在加载…</div>}
			{snapshot.isError && <div className="text-[13px] text-danger">加载失败：{snapshot.error.message}</div>}
			{data?.configError && (
				<div className="mb-4 rounded-xl border border-danger/40 bg-raised px-4 py-3">
					<div className="whitespace-pre-wrap text-[13px] text-danger">{data.configError}</div>
					<div className="mt-1 text-xs text-fg-3">custom-tools.json 修复前无法修改配置。</div>
					<Button className="mt-2 h-7 px-2.5" disabled={snapshot.isFetching} onClick={() => void snapshot.refetch()}>重新读取</Button>
				</div>
			)}
			{data && (
				<div className="flex flex-col gap-3">
					{data.tools.length === 0 && data.issues.length === 0 && (
						<div className="rounded-xl border border-line bg-raised px-4 py-3 text-[13px] text-fg-3">暂无自定义工具</div>
					)}
					{items(data).map(item => (
						<ToolCard
							key={`${item.origin}/${item.name}`}
							item={item}
							users={customToolUsers(members.data, item.name)}
							configLocked={!!data.configError}
							onConfigure={item.tool ? () => setConfiguring(item.tool) : undefined}
						/>
					))}
				</div>
			)}
			{configuring && <ConfigDialog tool={configuring} onClose={() => setConfiguring(undefined)} />}
		</SettingsPage>
	);
}

function ToolCard({ item, users, configLocked, onConfigure }: { item: IItem; users: readonly IMember[]; configLocked: boolean; onConfigure: (() => void) | undefined }) {
	const queryClient = useQueryClient();
	const [expanded, setExpanded] = useState(false);
	const [confirming, setConfirming] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const { tool } = item;

	const send = async (method: 'PUT' | 'DELETE', path: string, body?: unknown) => {
		setError(undefined);
		setBusy(true);
		try {
			queryClient.setQueryData(queryKeys.customTools, await api<ICustomToolsSnapshot>(method, path, body));
			return true;
		} catch (caught) {
			setError(errorMessage(caught));
			return false;
		} finally {
			setBusy(false);
		}
	};
	const base = `/v1/custom-tools/${encodeURIComponent(item.name)}`;
	const canConfigure = !!tool && tool.config.length > 0 && !configLocked && !!onConfigure;
	const tag = item.origin === 'builtin' ? '内置' : tool?.overridesBuiltin ? '覆盖内置' : undefined;
	const summary = tool && [tool.label, tool.description].filter(Boolean).join('：');

	return (
		<section className="rounded-xl border border-line bg-raised">
			<div className="flex items-start gap-3 px-4 py-3">
				{tool && (
					<span className="pt-0.5">
						<Switch checked={!tool.disabled} label={`启用 ${item.name}`} disabled={busy || configLocked} onChange={enabled => void send('PUT', `${base}/disabled`, { disabled: !enabled })} />
					</span>
				)}
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
						<span className="break-all font-mono text-[13px] font-medium">{item.name}</span>
						{tag && <span className="tag">{tag}</span>}
						<Status item={item} onConfigure={canConfigure ? onConfigure : undefined} />
						{users.length > 0 && (
							<span className="flex shrink-0 items-center gap-0.5 text-xs text-fg-3" title={`正在使用的成员：${users.map(member => member.name).join('、')}`}>
								<UsersRound size={13} />{users.length}
							</span>
						)}
					</div>
					{summary && <div className="mt-0.5 text-xs text-fg-3">{summary}</div>}
				</div>
				<div className="flex shrink-0 gap-1.5">
					{canConfigure && <Button className="h-7 px-2.5" disabled={busy} onClick={onConfigure}>配置</Button>}
					{item.origin === 'own' && <Button className="h-7 px-2.5" disabled={busy} onClick={() => setConfirming(true)}>删除</Button>}
				</div>
			</div>
			{item.issue && <div className="mx-4 mb-3"><CopyablePath path={item.directory} /></div>}
			{error && !confirming && <div className="mx-4 mb-3 text-[13px] text-danger">{error}</div>}
			{tool && (
				<div className="border-t border-line">
					<button type="button" onClick={() => setExpanded(value => !value)} className="flex w-full items-center gap-1 px-4 py-2 text-xs text-fg-3 hover:text-fg-2">
						<ChevronRight size={13} className={clsx('transition-transform', expanded && 'rotate-90')} />
						共 {tool.tools.length} 个工具，默认{POLICY_LABELS[tool.defaultPolicy]}
					</button>
					{expanded && (
						<div className="divide-y divide-line border-t border-line">
							{tool.tools.map(entry => (
								<div key={entry.name} className="px-4 py-2">
									<div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
										<span className="break-all font-mono text-xs">{entry.name}</span>
										<span className="text-xs text-fg-2">{entry.label}</span>
										{entry.progressive && <span className="tag" title="不直接提供给模型，需通过 more_tools 查看和调用">渐进式</span>}
									</div>
									<div className="mt-0.5 whitespace-pre-line break-words text-xs text-fg-3">{entry.description}</div>
								</div>
							))}
						</div>
					)}
				</div>
			)}
			<ConfirmDialog
				open={confirming}
				onOpenChange={setConfirming}
				title={`删除自定义工具 ${item.name}？`}
				detail={(
					<>
						<p>
							将从自定义工具目录中删除该文件夹。
							{tool?.overridesBuiltin ? '删除后恢复使用内置版本。' : users.length > 0 ? '正在使用的成员将无法使用这些工具，其设置保持不变，成员设置中会提示工具不存在。' : ''}
							已填写的配置会保留，重新创建同名工具后继续生效。
						</p>
						{!tool?.overridesBuiltin && <UsedBy members={users} />}
					</>
				)}
				confirmLabel="删除"
				busy={busy}
				error={confirming ? error : undefined}
				onConfirm={() => void send('DELETE', base).then(ok => ok && setConfirming(false))}
			/>
		</section>
	);
}

/** 可用；停用的灰字；未配置时橙字写原因，点击打开配置；key 无法解密、读不出来的红字。 */
function Status({ item, onConfigure }: { item: IItem; onConfigure: (() => void) | undefined }) {
	if (item.issue) return <span className="min-w-0 break-words text-xs text-danger">{item.issue}</span>;
	const tool = item.tool!;
	if (tool.disabled) return <span className="flex shrink-0 items-center gap-1 text-xs text-fg-3"><span className="size-2 rounded-full bg-fg-3" />已停用</span>;
	if (!tool.problem) return <span className="flex shrink-0 items-center gap-1 text-xs text-fg-2"><span className="size-2 rounded-full bg-success" />可用</span>;
	const className = clsx('min-w-0 break-words text-left text-xs', tool.undecryptable ? 'text-danger' : 'text-warning');
	const text = tool.undecryptable ? 'key 无法解密' : tool.problem;
	return onConfigure
		? <button type="button" className={clsx(className, 'hover:underline')} title={tool.problem} onClick={onConfigure}>{text}</button>
		: <span className={className} title={tool.problem}>{text}</span>;
}

/** 供应商下拉框里「单独填写地址和 key」和「不配置」的值；供应商 ID 只有小写字母、数字和横杠，不会和它们重。 */
const CUSTOM_SERVICE = '*';
const NO_SERVICE = '-';

/** 表单里一项的值。service 的 choice：空是没选，NO_SERVICE 是不配置，CUSTOM_SERVICE 是单独填写，其他是供应商 ID；切换时单独填的地址和 key 不丢。 */
type FormValue =
	| { readonly type: 'text' | 'secret'; readonly value: string }
	| { readonly type: 'service'; readonly choice: string; readonly baseUrl: string; readonly apiKey: string };
type ServiceValue = Extract<FormValue, { type: 'service' }>;

function initialValue(field: IConfigField, value: PublicValue | undefined, hasProviders: boolean): FormValue {
	if (field.type === 'service') {
		const service = value?.type === 'service' ? value : undefined;
		// 模型设置里没有供应商时只能单独填写，默认选它。
		const choice = service?.baseUrl ? CUSTOM_SERVICE : service?.provider ?? (hasProviders ? '' : CUSTOM_SERVICE);
		return { type: 'service', choice, baseUrl: service?.baseUrl ?? '', apiKey: '' };
	}
	if (field.type === 'secret') return { type: 'secret', value: '' };
	return { type: 'text', value: (value?.type === 'text' ? value.value : null) ?? field.default ?? '' };
}

/** 交给运行时的值：密钥留空时传 null，沿用原来的。 */
function requestValue(form: FormValue): unknown {
	if (form.type !== 'service') return form.type === 'secret' ? form.value || null : form.value;
	if (form.choice === '' || form.choice === NO_SERVICE) return null;
	if (form.choice !== CUSTOM_SERVICE) return { provider: form.choice };
	return form.baseUrl.trim() || form.apiKey ? { baseUrl: form.baseUrl.trim(), apiKey: form.apiKey || null } : null;
}

const UNDECRYPTABLE = '原值为加密保存，无法使用当前数据目录的密钥解密';

/** 密钥输入框的灰字：已有的不回显，留空不改；无法解密的要重新填写。 */
function keyPlaceholder(key: IKeyState | undefined): string | undefined {
	if (key?.undecryptable) return '无法解密，需重新填写';
	return key?.set ? '已保存，留空则保持不变' : undefined;
}

/** 按 tool.json 的 config 画的表单，确认后立即保存。 */
function ConfigDialog({ tool, onClose }: { tool: ICustomToolInfo; onClose: () => void }) {
	const queryClient = useQueryClient();
	const models = useModels();
	const providers = models.data?.providers ?? [];
	const [form, setForm] = useState<Record<string, FormValue>>(() => Object.fromEntries(tool.config.map(field => [field.name, initialValue(field, tool.values[field.name], providers.length > 0)])));
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const set = (name: string, value: FormValue) => setForm(current => ({ ...current, [name]: value }));

	const save = async () => {
		setError(undefined);
		setBusy(true);
		try {
			const values = Object.fromEntries(tool.config.map(field => [field.name, requestValue(form[field.name]!)]));
			queryClient.setQueryData(queryKeys.customTools, await api<ICustomToolsSnapshot>('PUT', `/v1/custom-tools/${encodeURIComponent(tool.name)}/config`, { values }));
			onClose();
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	};
	const footer = (
		<div className="flex items-start gap-2 border-t border-line px-5 py-3">
			<div className="min-w-0 flex-1 whitespace-pre-wrap text-[13px] text-danger">{error}</div>
			<Button disabled={busy} onClick={onClose}>取消</Button>
			<Button variant="primary" disabled={busy} onClick={() => void save()}>保存</Button>
		</div>
	);
	return (
		<Dialog open onOpenChange={open => !open && onClose()} title={`配置「${tool.label}」`} width="w-[520px]" footer={footer}>
			<div className="mb-4 break-words text-xs leading-relaxed text-fg-3">
				<span className="font-mono">{tool.name}</span>{tool.description && ` · ${tool.description}`}
			</div>
			<div className="flex flex-col gap-4">
				{tool.config.map(field => {
					const value = form[field.name]!;
					const stored = tool.values[field.name];
					const key = stored && stored.type !== 'text' ? stored.key : undefined;
					if (value.type === 'service') {
						return <ServiceField key={field.name} field={field} value={value} providers={providers} storedKey={key} onChange={next => set(field.name, next)} />;
					}
					return (
						<Field key={field.name} label={field.label} optional={!field.required} hint={field.description ?? undefined}>
							<input
								value={value.value}
								onChange={event => set(field.name, { ...value, value: event.target.value })}
								type={value.type === 'secret' ? 'password' : 'text'}
								autoComplete="off"
								spellCheck={false}
								placeholder={value.type === 'secret' ? keyPlaceholder(key) : undefined}
								title={key?.undecryptable ? UNDECRYPTABLE : undefined}
								className={clsx(INPUT_CLASS, 'font-mono', key?.undecryptable && !value.value && 'border-danger placeholder:text-danger')}
							/>
						</Field>
					);
				})}
			</div>
		</Dialog>
	);
}

/** 供应商：一个下拉框，选模型设置里的供应商，或者单独填写，单独填写时下面展开地址和 key。 */
function ServiceField({ field, value, providers, storedKey, onChange }: {
	field: IConfigField;
	value: ServiceValue;
	providers: readonly { readonly id: string; readonly name: string; readonly baseUrl: string }[];
	/** 存着的单独填写的 key。 */
	storedKey: IKeyState | undefined;
	onChange: (value: ServiceValue) => void;
}) {
	const custom = value.choice === CUSTOM_SERVICE;
	// 选的供应商已经删了时也列出来，写明已删除。
	const missing = !custom && value.choice !== '' && value.choice !== NO_SERVICE && !providers.some(provider => provider.id === value.choice);
	const options = [
		...providers.length > 0 || missing
			? [{
				group: '模型设置中的供应商',
				options: [
					...providers.map(provider => ({ value: provider.id, label: provider.name, description: provider.baseUrl })),
					...missing ? [{ value: value.choice, label: `${value.choice}（已删除）` }] : [],
				],
			}]
			: [],
		{ value: CUSTOM_SERVICE, label: '单独填写地址和 key' },
		{ value: NO_SERVICE, label: '不配置' },
	];
	const hint = [field.description, custom && '地址不含 /v1'].filter(Boolean).join('；');
	return (
		<div>
			<div className="mb-1 flex items-center gap-2">
				<span className="text-[13px] font-medium">{field.label}</span>
				{!field.required && <span className="text-xs text-fg-3">选填</span>}
			</div>
			<Select
				value={value.choice}
				onChange={choice => onChange({ ...value, choice })}
				options={options}
				label={field.label}
				placeholder="选择供应商"
				className={clsx('w-full', missing && 'text-danger')}
			/>
			{custom && (
				<div className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5">
					<span className="text-xs text-fg-2">地址</span>
					<input
						value={value.baseUrl}
						onChange={event => onChange({ ...value, baseUrl: event.target.value })}
						placeholder="https://api.example.com"
						aria-label={`${field.label}的地址`}
						spellCheck={false}
						className={`${INPUT_CLASS} font-mono`}
					/>
					<span className="text-xs text-fg-2">API key</span>
					<input
						value={value.apiKey}
						onChange={event => onChange({ ...value, apiKey: event.target.value })}
						placeholder={keyPlaceholder(storedKey)}
						aria-label={`${field.label}的 API key`}
						title={storedKey?.undecryptable ? UNDECRYPTABLE : undefined}
						type="password"
						autoComplete="off"
						className={clsx(INPUT_CLASS, 'font-mono', storedKey?.undecryptable && !value.apiKey && 'border-danger placeholder:text-danger')}
					/>
				</div>
			)}
			{hint && <div className="mt-1 text-xs text-fg-3">{hint}</div>}
		</div>
	);
}
