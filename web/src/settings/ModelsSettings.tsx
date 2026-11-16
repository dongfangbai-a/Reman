import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { CircleAlert, KeyRound, Pencil, Plus, Trash2, UserRound } from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { api } from '../api/client.ts';
import { useCustomTools, useModels } from '../api/directory.ts';
import { queryKeys } from '../api/keys.ts';
import { useMembers } from '../api/queries.ts';
import type { IModelEntry, IModelList, IModelRef, IMember, IUpstreamModel } from '../api/types.ts';
import { errorMessage } from '../lib/errors.ts';
import { BackLink } from '../ui/BackLink.tsx';
import { Button, IconButton } from '../ui/Button.tsx';
import { CheckMark } from '../ui/Checkbox.tsx';
import { ConfirmDialog, Dialog, Field, INPUT_CLASS } from '../ui/Dialog.tsx';
import { Select } from '../ui/Select.tsx';
import { Switch } from '../ui/Switch.tsx';
import { UsedBy } from '../ui/UsedBy.tsx';
import { apiEndpoint } from '../../../src/models/endpoint.ts';
import { forgetModelTests, modelKey, ModelTestButton, ModelTestStatus, useModelTestResult } from './ModelTest.tsx';
import { suggestProviderId } from './providerId.ts';
import { SettingsPage } from './SettingsPage.tsx';

type IProviderView = IModelList['providers'][number];
type IProviderInput = Omit<IProviderView, 'apiKey'> & { readonly apiKey?: string };
/** 写回 models.json 的内容。供应商不带 apiKey 时运行时沿用原来的 key。 */
interface IModelsInput {
	readonly defaultModel: IModelRef | undefined;
	readonly providers: readonly IProviderInput[];
}

const PROVIDER_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;

type DialogState =
	| { readonly kind: 'newProvider' }
	| { readonly kind: 'editProvider' | 'deleteProvider' | 'addModels'; readonly providerId: string }
	| { readonly kind: 'editModel' | 'deleteModel'; readonly providerId: string; readonly model: string }
	| { readonly kind: 'notice'; readonly text: string };

/** 模型设置：默认模型、供应商和它们的模型。每个操作立即保存。 */
export function ModelsSettings() {
	const models = useModels();
	const members = useMembers();
	const customTools = useCustomTools();
	const [dialog, setDialog] = useState<DialogState>();
	// models.json 也可能在别处改过，打开页面时重新读一次。
	const { refetch } = models;
	useEffect(() => void refetch(), [refetch]);

	const list = models.data;
	const close = () => setDialog(undefined);
	const users = (providerId: string, model?: string) => (members.data ?? []).filter(member =>
		member.type === 'ai' && !member.deleted && member.model?.provider === providerId && (model === undefined || member.model.model === model));
	/** 配置里选了这个供应商的自定义工具。 */
	const customToolsUsing = (providerId: string) => {
		const names = (customTools.data?.tools ?? []).filter(tool => Object.values(tool.values).some(value => value.type === 'service' && value.provider === providerId)).map(tool => tool.name);
		return names.length > 0 ? `自定义工具 ${names.join('、')} 的配置使用了该供应商，删除后需重新选择。` : undefined;
	};
	const dialogProvider = dialog && 'providerId' in dialog ? list?.providers.find(item => item.id === dialog.providerId) : undefined;
	const dialogModel = dialog?.kind === 'editModel' ? dialogProvider?.models.find(model => model.model === dialog.model) : undefined;
	const isDefault = (providerId: string, model?: string) =>
		list?.defaultModel?.provider === providerId && (model === undefined || list.defaultModel.model === model);

	return (
		<SettingsPage wide>
			<BackLink to="/settings" label="设置" />
			<div className="mb-4 flex items-center justify-between">
				<h1 className="text-xl font-semibold">模型</h1>
				{list && !list.error && <Button onClick={() => setDialog({ kind: 'newProvider' })}><Plus size={15} />新建供应商</Button>}
			</div>
			{models.isPending && <div className="text-center text-[13px] text-fg-3">正在加载…</div>}
			{models.isError && <div className="text-[13px] text-danger">加载失败：{models.error.message}</div>}
			{list?.error && (
				<div className="rounded-xl bg-danger-soft px-4 py-3 text-[13px] text-danger">
					<div className="flex items-center gap-1.5 font-medium"><CircleAlert size={14} />模型配置有误，请先修正数据目录中的 models.json，再在此处修改</div>
					<div className="mt-1 break-all">{list.error}</div>
					<Button className="mt-3" onClick={() => void refetch()}>重新读取</Button>
				</div>
			)}
			{list && !list.error && (
				<div className="space-y-3">
					<DefaultModel list={list} />
					{list.providers.length === 0 && (
						<div className="rounded-xl border border-line bg-raised px-4 py-6 text-center text-[13px] text-fg-3">暂无供应商。请新建供应商，填写地址和 key 后再添加模型。</div>
					)}
					{list.providers.map(item => (
						<ProviderCard
							key={item.id}
							provider={item}
							defaultModel={list.defaultModel}
							users={model => users(item.id, model)}
							onDialog={setDialog}
							onDeleteProvider={() => setDialog(isDefault(item.id)
								? { kind: 'notice', text: '默认模型属于该供应商，请先更换默认模型再删除。' }
								: { kind: 'deleteProvider', providerId: item.id })}
							onDeleteModel={model => setDialog(isDefault(item.id, model)
								? { kind: 'notice', text: '该模型为默认模型，请先更换默认模型再删除。' }
								: { kind: 'deleteModel', providerId: item.id, model })}
						/>
					))}
				</div>
			)}
			{dialog?.kind === 'newProvider' && <ProviderDialog onClose={close} />}
			{dialog?.kind === 'editProvider' && dialogProvider && <ProviderDialog provider={dialogProvider} onClose={close} />}
			{dialog?.kind === 'addModels' && dialogProvider && <AddModelsDialog provider={dialogProvider} onClose={close} />}
			{dialogProvider && dialogModel && <ModelDialog provider={dialogProvider} entry={dialogModel} onClose={close} />}
			{dialog?.kind === 'deleteProvider' && (
				<DeleteDialog
					title={`删除供应商「${dialogProvider?.name ?? dialog.providerId}」？`}
					users={users(dialog.providerId)}
					usedText="该供应商的模型将一并删除，正在使用这些模型的成员将运行失败。"
					unusedText="该供应商的模型将一并删除。"
					note={customToolsUsing(dialog.providerId)}
					change={input => ({ ...input, providers: input.providers.filter(item => item.id !== dialog.providerId) })}
					onClose={close}
				/>
			)}
			{dialog?.kind === 'deleteModel' && (
				<DeleteDialog
					title={`删除模型「${dialog.model}」？`}
					users={users(dialog.providerId, dialog.model)}
					usedText="删除后，正在使用该模型的成员将运行失败。"
					unusedText="删除后成员将无法再选用该模型。"
					change={input => updateProvider(input, dialog.providerId, item => ({ ...item, models: item.models.filter(model => model.model !== dialog.model) }))}
					onClose={close}
				/>
			)}
			{dialog?.kind === 'notice' && (
				<Dialog open onOpenChange={open => !open && close()} title="不能删除">
					<div className="text-[13px] text-fg-2">{dialog.text}</div>
					<div className="mt-5 flex justify-end"><Button onClick={close}>关闭</Button></div>
				</Dialog>
			)}
		</SettingsPage>
	);
}

/** 默认模型：一行，名字、下拉框和一句说明。 */
function DefaultModel({ list }: { list: IModelList }) {
	const save = useSaveModels();
	const [error, setError] = useState<string>();
	const [busy, setBusy] = useState(false);
	const current = list.defaultModel ? modelKey(list.defaultModel) : '';
	const options = list.providers.flatMap(provider => provider.models.map(model => ({ provider, model })));
	const choose = async (value: string) => {
		const [provider, model] = value.split('\n') as [string, string];
		setBusy(true);
		setError(undefined);
		try {
			await save(input => ({ ...input, defaultModel: { provider, model } }));
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	};
	return (
		<section className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-line bg-raised px-4 py-2.5">
			<h2 className="text-[13px] font-semibold">默认模型</h2>
			{options.length === 0
				? <span className="text-[13px] text-fg-3">请先添加模型</span>
				: (
					<Select
						label="默认模型"
						value={current}
						disabled={busy}
						onChange={value => void choose(value)}
						className="w-64 max-w-full"
						options={[
							...!current ? [{ value: '', label: '未设置' }] : [],
							...list.providers.filter(provider => provider.models.length > 0).map(provider => ({
								group: provider.name,
								options: provider.models.map(model => ({ value: modelKey({ provider: provider.id, model: model.model }), label: model.displayName })),
							})),
						]}
					/>
				)}
			<span className="text-xs text-fg-3">供未指定模型的成员使用</span>
			{options.length > 0 && !current && <div className="basis-full text-[13px] text-warning">尚未设置默认模型，未指定模型的成员将运行失败。</div>}
			{error && <div className="basis-full text-[13px] text-danger">保存失败：{error}</div>}
		</section>
	);
}

/** 一个供应商：头部一行（名字、标识、地址、key 和操作），下面每个模型一行。 */
function ProviderCard({ provider, defaultModel, users, onDialog, onDeleteProvider, onDeleteModel }: {
	provider: IProviderView;
	defaultModel: IModelRef | undefined;
	users: (model?: string) => IMember[];
	onDialog: (dialog: DialogState) => void;
	onDeleteProvider: () => void;
	onDeleteModel: (model: string) => void;
}) {
	const providerId = provider.id;
	const key = provider.apiKey;
	return (
		<section className="rounded-xl border border-line bg-raised">
			<div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-line py-1.5 pl-4 pr-1.5">
				<h2 className="truncate text-sm font-semibold">{provider.name}</h2>
				{provider.name !== providerId && (
					<span className="shrink-0 rounded bg-selected px-1.5 font-mono text-[11px] leading-4 text-fg-2" title="标识，成员通过它引用该供应商">{providerId}</span>
				)}
				<span className="min-w-32 flex-1 basis-40 truncate font-mono text-xs text-fg-3" title={provider.baseUrl}>{provider.baseUrl}</span>
				<span
					className={clsx('flex shrink-0 items-center gap-1 font-mono text-xs', key.undecryptable ? 'text-danger' : 'text-fg-3')}
					title={key.undecryptable ? 'key 已加密保存，但无法用当前数据目录的密钥解密，须重新填写' : 'key 已配置'}
				>
					<KeyRound size={12} />{key.undecryptable ? 'key 须重新填写' : key.preview || '已配置'}
				</span>
				<div className="ml-auto flex shrink-0 items-center">
					<Button className="mr-1" onClick={() => onDialog({ kind: 'addModels', providerId })}><Plus size={14} />添加模型</Button>
					<IconButton label="编辑供应商" onClick={() => onDialog({ kind: 'editProvider', providerId })}><Pencil size={15} /></IconButton>
					<IconButton label="删除供应商" className="hover:text-danger" onClick={onDeleteProvider}><Trash2 size={15} /></IconButton>
				</div>
			</div>
			<div className="divide-y divide-line">
				{provider.models.length === 0 && <div className="px-4 py-2 text-[13px] text-fg-3">暂无模型</div>}
				{provider.models.map(model => (
					<ModelRow
						key={model.model}
						providerId={providerId}
						model={model}
						isDefault={defaultModel?.provider === providerId && defaultModel.model === model.model}
						using={users(model.model)}
						onEdit={() => onDialog({ kind: 'editModel', providerId, model: model.model })}
						onDelete={() => onDeleteModel(model.model)}
					/>
				))}
			</div>
		</section>
	);
}

/** 一个模型一行：名字、测试结果、在用的成员数、视觉、上下文，最后是测试、编辑、删除；测试失败时原因写在下面一行。 */
function ModelRow({ providerId, model, isDefault, using, onEdit, onDelete }: {
	providerId: string;
	model: IModelEntry;
	isDefault: boolean;
	using: IMember[];
	onEdit: () => void;
	onDelete: () => void;
}) {
	const ref = { provider: providerId, model: model.model };
	const tested = useModelTestResult(ref);
	return (
		<div>
			<div className="flex items-center gap-3 py-0.5 pl-4 pr-1.5 text-[13px]">
				<div className="flex min-w-0 flex-1 items-center gap-2">
					<span className="truncate">{model.displayName}</span>
					{model.displayName !== model.model && <span className="hidden truncate font-mono text-xs text-fg-3 sm:inline">{model.model}</span>}
					{isDefault && <span className="shrink-0 rounded bg-accent-soft px-1.5 text-[11px] leading-4 text-accent">默认</span>}
				</div>
				{tested && <ModelTestStatus result={tested} className="hidden sm:inline" />}
				<span className="flex w-8 shrink-0 items-center justify-end gap-0.5 text-xs text-fg-2" title={using.length > 0 ? `正在使用：${using.map(member => member.name).join('、')}` : undefined}>
					{using.length > 0 && <><UserRound size={12} />{using.length}</>}
				</span>
				<span className="w-7 shrink-0 text-right text-xs text-fg-2" title={model.vision ? '图片将发送给模型' : undefined}>{model.vision ? '视觉' : ''}</span>
				<span
					className={clsx('w-10 shrink-0 text-right text-xs tabular-nums', model.contextWindow ? 'text-fg-2' : 'text-fg-3')}
					title={model.contextWindow ? `上下文 ${model.contextWindow} token` : '未填写上下文长度，按 128k 计算'}
				>
					{model.contextWindow ? contextSize(model.contextWindow) : '128k'}
				</span>
				<div className="flex shrink-0 items-center">
					<ModelTestButton model={ref} />
					<IconButton label="编辑模型" onClick={onEdit}><Pencil size={14} /></IconButton>
					<IconButton label="删除模型" className="hover:text-danger" onClick={onDelete}><Trash2 size={14} /></IconButton>
				</div>
			</div>
			{/* 不能用的原因写在下面一行；窄屏时结果也写在这里，免得挤掉模型名。 */}
			{tested && (
				<div className={clsx('flex flex-wrap gap-x-2 pb-1.5 pl-4 pr-3 text-xs', tested.ok && 'sm:hidden')}>
					<ModelTestStatus result={tested} className="sm:hidden" />
					{!tested.ok && <span className="min-w-0 break-all text-danger">{tested.error}</span>}
				</div>
			)}
		</div>
	);
}

/** 新建或编辑供应商。新建时标识按地址自动填，可以改；名字选填，不填和标识一样。编辑时 key 不填就保持原来的。 */
function ProviderDialog({ provider, onClose }: { provider?: IProviderView | undefined; onClose: () => void }) {
	const models = useModels();
	const save = useSaveModels();
	const action = useAction(onClose);
	const [name, setName] = useState(provider && provider.name !== provider.id ? provider.name : '');
	const [id, setId] = useState(provider?.id ?? '');
	const [idEdited, setIdEdited] = useState(false);
	const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? '');
	// 打开「完整地址」后，地址原样使用，不再按 OpenAI 的约定补 /v1、/responses。
	const [complete, setComplete] = useState(provider?.endpointMode === 'exact');
	const [apiKey, setApiKey] = useState('');
	const changeUrl = (value: string) => {
		setBaseUrl(value);
		if (!provider && !idEdited) setId(suggestProviderId(value, new Set(models.data?.providers.map(item => item.id) ?? [])));
	};
	/** 输入框下面显示的实际请求地址：还填得不像地址时不显示。 */
	const endpointPreview = (() => {
		const url = baseUrl.trim().replace(/\/+$/, '');
		if (!/^https?:\/\//.test(url)) return undefined;
		try {
			return apiEndpoint(url, complete ? 'exact' : 'auto');
		} catch {
			return undefined;
		}
	})();
	const submit = (event: FormEvent) => {
		event.preventDefault();
		const trimmedId = id.trim();
		const url = baseUrl.trim().replace(/\/+$/, '');
		const key = apiKey.trim();
		if (!/^https?:\/\//.test(url)) return action.fail('地址须以 http:// 或 https:// 开头');
		if (/[?#]/.test(url)) return action.fail('地址里不要带 ? 或 #，那是查询和锚点，不属于接口地址');
		if (complete && endpointPreview === undefined) return action.fail('完整地址填得不对，检查一下有没有多余的空格或路径');
		if (!provider) {
			if (!key) return action.fail('请填写 key');
			if (!PROVIDER_ID.test(trimmedId)) return action.fail('标识只能包含小写字母、数字和横杠，例如 zhipu');
			if (models.data?.providers.some(item => item.id === trimmedId)) return action.fail(`已存在标识为 ${trimmedId} 的供应商`);
		}
		const displayName = name.trim() || (provider?.id ?? trimmedId);
		const endpointMode = complete ? 'exact' as const : 'auto' as const;
		action.run(async () => {
			await save(input => provider
				? updateProvider(input, provider.id, item => ({ ...item, name: displayName, baseUrl: url, endpointMode, ...(key ? { apiKey: key } : {}) }))
				: { ...input, providers: [...input.providers, { id: trimmedId, name: displayName, baseUrl: url, endpointMode, apiKey: key, models: [] }] });
			// 地址、key 可能改了，以前的测试结果不算数。
			if (provider) forgetModelTests(provider.id);
		});
	};
	return (
		<Dialog open onOpenChange={open => !open && onClose()} title={provider ? `编辑供应商「${provider.name}」` : '新建供应商'} width="w-[480px]">
			<form onSubmit={submit} className="space-y-4">
				<Field
					label="地址"
					aside={
						<span className="-my-2 flex items-center gap-1.5 py-2">
							<span className="text-xs text-fg-3">完整地址</span>
							<Switch checked={complete} label="完整地址：原样使用，不补 /v1 和 /responses" onChange={setComplete} />
						</span>
					}
					hint={endpointPreview
						? <span className="break-all">实际请求：<span className="font-mono">{endpointPreview}</span></span>
						: complete ? '填完整的请求地址，例如 https://api.example.com/v1/responses' : '不含 /v1'}
				>
					<input
						value={baseUrl}
						onChange={event => changeUrl(event.target.value)}
						placeholder={complete ? 'https://api.example.com/v1/responses' : 'https://api.example.com'}
						className={`${INPUT_CLASS} font-mono`}
					/>
				</Field>
				<Field label={provider ? '更换 key' : 'key'} hint={provider ? '留空则保持原 key' : undefined}>
					<input type="password" autoComplete="off" value={apiKey} onChange={event => setApiKey(event.target.value)} className={`${INPUT_CLASS} font-mono`} />
				</Field>
				{!provider && (
					<Field label="标识" hint="小写字母、数字和横杠；成员通过它引用，创建后不能修改">
						<input value={id} onChange={event => { setId(event.target.value); setIdEdited(true); }} className={`${INPUT_CLASS} font-mono`} />
					</Field>
				)}
				<Field label="名字" optional>
					<input value={name} onChange={event => setName(event.target.value)} placeholder={provider?.id ?? id.trim()} className={INPUT_CLASS} />
				</Field>
				{action.error && <div className="text-[13px] text-danger">{action.error}</div>}
				<div className="flex justify-end">
					<Button type="submit" variant="primary" disabled={action.busy}>{provider ? '保存' : '新建'}</Button>
				</div>
			</form>
		</Dialog>
	);
}

/**
 * 拉取模型列表失败时给人看的话：一句说清楚发生了什么、该去检查什么，原始报错留给「详情」。
 * 状态码在服务端写的报错里（「请求 … 失败（HTTP 503）：…」），按它分类。
 */
function describeUpstreamError(message: string): string {
	const status = Number(/HTTP (\d{3})/u.exec(message)?.[1]);
	if (status === 401 || status === 403) return `HTTP ${status}：key 被拒绝`;
	if (status === 404) return 'HTTP 404：地址不通，或供应商不支持列出模型';
	if (status > 0) return `HTTP ${status}`;
	return '连不上服务';
}

/** 添加模型：拉取供应商的模型列表，搜索、多选；列表里没有的（或者拉取失败时）输入模型名手动添加。 */
function AddModelsDialog({ provider, onClose }: { provider: IProviderView; onClose: () => void }) {
	const save = useSaveModels();
	const action = useAction(onClose);
	const upstream = useQuery({
		queryKey: queryKeys.upstreamModels(provider.id),
		queryFn: async () => (await api<{ models: IUpstreamModel[] }>('GET', `/v1/providers/${provider.id}/upstream-models`)).models,
		retry: false,
		gcTime: 0,
	});
	const [filter, setFilter] = useState('');
	const [selected, setSelected] = useState<string[]>([]);
	const [manual, setManual] = useState<string[]>([]);
	const query = filter.trim();
	const listed = upstream.data ?? [];
	const shown = listed.filter(model => model.model.toLowerCase().includes(query.toLowerCase()));
	const canAddManually = query !== '' && !listed.some(model => model.model === query)
		&& !provider.models.some(model => model.model === query) && !manual.includes(query);
	const toggle = (model: string) => setSelected(selected.includes(model) ? selected.filter(item => item !== model) : [...selected, model]);
	const addManually = () => {
		setManual([...manual, query]);
		setFilter('');
	};
	const count = selected.length + manual.length;
	const add = () => {
		const entries: IModelEntry[] = [
			...listed.filter(model => selected.includes(model.model)).map(model => ({
				model: model.model, displayName: model.model, contextWindow: model.contextWindow,
				// 上游列表不带输出上限，添加后可以在编辑对话框里填。
				maxOutputTokens: undefined, vision: model.vision ?? false,
			})),
			...manual.map(model => ({ model, displayName: model, contextWindow: undefined, maxOutputTokens: undefined, vision: false })),
		];
		action.run(() => save(input => updateProvider(input, provider.id, item => ({ ...item, models: [...item.models, ...entries] }))));
	};
	return (
		<Dialog open onOpenChange={open => !open && onClose()} title={`添加模型到「${provider.name}」`} width="w-[520px]">
			<input
				autoFocus
				value={filter}
				onChange={event => setFilter(event.target.value)}
				onKeyDown={event => {
					if (event.key === 'Enter' && canAddManually) {
						event.preventDefault();
						addManually();
					}
				}}
				placeholder={upstream.data ? `搜索 ${listed.length} 个模型，或输入模型名` : upstream.isError ? '输入模型名，回车添加' : '输入模型名'}
				className={`${INPUT_CLASS} font-mono`}
			/>
			<div className="mt-1.5 max-h-80 overflow-y-auto rounded-md border border-line">
				{manual.map(model => (
					<ModelOption key={`manual:${model}`} model={model} checked note="手动添加" onClick={() => setManual(manual.filter(item => item !== model))} />
				))}
				{upstream.isPending && <div className="px-3 py-3 text-center text-[13px] text-fg-3">正在拉取模型列表…</div>}
				{upstream.isError && (
					<div className="p-2">
						<div className="rounded-md border border-line bg-raised px-3 py-2.5">
							<div className="flex items-start gap-2">
								<CircleAlert size={16} className="mt-0.5 shrink-0 text-danger" />
								<div className="min-w-0 flex-1">
									<div className="text-[13px] font-medium text-fg">拿不到模型列表</div>
									<div className="mt-0.5 text-[13px] text-fg-2">{describeUpstreamError(upstream.error.message)}</div>
									<details className="mt-1.5">
										<summary className="w-fit cursor-pointer text-xs text-fg-3 hover:text-fg-2">详情</summary>
										<div className="mt-1 max-h-28 overflow-y-auto rounded bg-code px-2 py-1.5 font-mono text-[11px] leading-relaxed break-all text-fg-3">{upstream.error.message}</div>
									</details>
								</div>
								<Button className="h-7 shrink-0 px-2.5 text-xs" disabled={upstream.isFetching} onClick={() => void upstream.refetch()}>
									{upstream.isFetching ? '重试中…' : '重试'}
								</Button>
							</div>
						</div>
					</div>
				)}
				{upstream.data && shown.length === 0 && !canAddManually && <div className="px-3 py-3 text-center text-[13px] text-fg-3">未找到模型</div>}
				{shown.map(model => (
					<ModelOption
						key={model.model}
						model={model.model}
						checked={model.added || selected.includes(model.model)}
						disabled={model.added}
						note={model.added ? '已添加' : [model.contextWindow && contextSize(model.contextWindow), model.vision && '视觉'].filter(Boolean).join(' · ')}
						onClick={() => toggle(model.model)}
					/>
				))}
				{canAddManually && (
					<button type="button" onClick={addManually} className="flex w-full items-center gap-2 border-t border-line px-2.5 py-1.5 text-left text-[13px] text-accent hover:bg-hover">
						<Plus size={14} />手动添加「<span className="font-mono text-xs">{query}</span>」
					</button>
				)}
			</div>
			<div className="mt-2 text-xs text-fg-3">添加后可再编辑显示名、上下文长度和视觉。</div>
			{action.error && <div className="mt-2 text-[13px] text-danger">{action.error}</div>}
			<div className="mt-4 flex justify-end">
				<Button variant="primary" disabled={action.busy || count === 0} onClick={add}>添加{count > 0 ? ` ${count} 个` : ''}</Button>
			</div>
		</Dialog>
	);
}

function ModelOption({ model, checked, disabled, note, onClick }: { model: string; checked: boolean; disabled?: boolean; note: string; onClick: () => void }) {
	return (
		<button
			type="button"
			role="checkbox"
			aria-checked={checked}
			disabled={disabled}
			onClick={onClick}
			className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[13px] hover:bg-hover disabled:hover:bg-transparent"
		>
			<CheckMark checked={checked} disabled={disabled} />
			<span className="min-w-0 flex-1 truncate font-mono text-xs">{model}</span>
			<span className="shrink-0 text-xs text-fg-3">{note}</span>
		</button>
	);
}

/** 上下文长度的快捷值，按十进制，和供应商标的一致。 */
const CONTEXT_PRESETS: readonly [string, number][] = [['128k', 128_000], ['256k', 256_000], ['512k', 512_000], ['1M', 1_000_000]];
const OUTPUT_PRESETS: readonly [string, number][] = [['32k', 32_768], ['64k', 65_536]];

/** 数字字段旁边的快捷填入按钮。 */
function Presets({ value, presets, onPick }: { value: string; presets: readonly [string, number][]; onPick: (size: number) => void }) {
	return (
		<>
			{presets.map(([label, size]) => (
				<button
					key={label}
					type="button"
					title={`填入 ${size}`}
					onClick={() => onPick(size)}
					className={clsx(
						'h-6 rounded-full border px-2 text-xs',
						value.trim() === String(size) ? 'border-accent bg-accent-soft text-accent' : 'border-line text-fg-2 hover:border-line-strong hover:text-fg',
					)}
				>
					{label}
				</button>
			))}
		</>
	);
}

/** 编辑模型：显示名、上下文长度、输出上限、视觉。 */
function ModelDialog({ provider, entry, onClose }: { provider: IProviderView; entry: IModelEntry; onClose: () => void }) {
	const save = useSaveModels();
	const action = useAction(onClose);
	const [displayName, setDisplayName] = useState(entry.displayName !== entry.model ? entry.displayName : '');
	const [contextWindow, setContextWindow] = useState(entry.contextWindow?.toString() ?? '');
	const [maxOutputTokens, setMaxOutputTokens] = useState(entry.maxOutputTokens?.toString() ?? '');
	const [vision, setVision] = useState(entry.vision);
	const submit = (event: FormEvent) => {
		event.preventDefault();
		const size = contextWindow.trim();
		if (size && !/^[1-9]\d*$/.test(size)) return action.fail('上下文长度须为正整数（token 数），或留空');
		const output = maxOutputTokens.trim();
		if (output && !/^[1-9]\d*$/.test(output)) return action.fail('输出上限须为正整数（token 数），或留空');
		const next: IModelEntry = {
			model: entry.model, displayName: displayName.trim() || entry.model,
			contextWindow: size ? Number(size) : undefined,
			maxOutputTokens: output ? Number(output) : undefined,
			vision,
		};
		action.run(() => save(input => updateProvider(input, provider.id, item => ({
			...item, models: item.models.map(old => old.model === entry.model ? next : old),
		}))));
	};
	return (
		<Dialog open onOpenChange={open => !open && onClose()} title={`编辑模型「${entry.model}」`} width="w-[480px]">
			<form onSubmit={submit} className="space-y-4">
				<Field label="显示名" optional>
					<input value={displayName} onChange={event => setDisplayName(event.target.value)} placeholder={entry.model} className={INPUT_CLASS} />
				</Field>
				<Field
					label="上下文长度"
					hint="供应商标注的 token 数；留空按 128k 计算。接近上限时自动压缩。"
					aside={<Presets value={contextWindow} presets={CONTEXT_PRESETS} onPick={size => setContextWindow(String(size))} />}
				>
					<input value={contextWindow} inputMode="numeric" onChange={event => setContextWindow(event.target.value)} placeholder="128000" className={INPUT_CLASS} />
				</Field>
				<Field
					label="输出上限"
					hint="供应商标注的单次输出上限；留空则不传，按模型的默认值。"
					aside={<Presets value={maxOutputTokens} presets={OUTPUT_PRESETS} onPick={size => setMaxOutputTokens(String(size))} />}
				>
					<input value={maxOutputTokens} inputMode="numeric" onChange={event => setMaxOutputTokens(event.target.value)} placeholder="留空则不传" className={INPUT_CLASS} />
				</Field>
				<div className="flex items-center gap-4">
					<div className="min-w-0 flex-1">
						<div className="text-[13px] font-medium">视觉</div>
						<div className="text-xs text-fg-3">开启后图片将发送给模型；关闭时仅告知模型存在图片。</div>
					</div>
					<Switch checked={vision} label="视觉" onChange={setVision} />
				</div>
				{action.error && <div className="text-[13px] text-danger">{action.error}</div>}
				<div className="flex justify-end">
					<Button type="submit" variant="primary" disabled={action.busy}>保存</Button>
				</div>
			</form>
		</Dialog>
	);
}

/** note：删除供应商时，选了它的自定义工具配置的说明。 */
function DeleteDialog({ title, users, usedText, unusedText, note, change, onClose }: {
	title: string;
	users: readonly IMember[];
	usedText: string;
	unusedText: string;
	note?: string | undefined;
	change: (input: IModelsInput) => IModelsInput;
	onClose: () => void;
}) {
	const save = useSaveModels();
	const action = useAction(onClose);
	const detail: ReactNode = (
		<>
			<p>{users.length > 0 ? usedText : unusedText}</p>
			{note && <p className="mt-2">{note}</p>}
			<UsedBy members={users} />
		</>
	);
	return (
		<ConfirmDialog
			open
			onOpenChange={open => !open && onClose()}
			title={title}
			detail={detail}
			confirmLabel="删除"
			busy={action.busy}
			error={action.error}
			onConfirm={() => action.run(() => save(change))}
		/>
	);
}

/** 在最新的配置上改一处，整个写回。 */
function useSaveModels(): (change: (input: IModelsInput) => IModelsInput) => Promise<void> {
	const queryClient = useQueryClient();
	return async change => {
		const current = queryClient.getQueryData<IModelList>(queryKeys.models);
		if (!current || current.error) throw new Error('模型配置尚未读取');
		const input: IModelsInput = { defaultModel: current.defaultModel, providers: current.providers.map(({ apiKey: _, ...provider }) => provider) };
		queryClient.setQueryData(queryKeys.models, await api<IModelList>('PUT', '/v1/models', change(input)));
	};
}

/** 对话框里的保存：进行中、出错，成功后关闭。 */
function useAction(onDone: () => void) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	return {
		busy,
		error,
		fail: (message: string) => setError(message),
		run: (task: () => Promise<void>) => {
			setBusy(true);
			setError(undefined);
			task().then(onDone, caught => setError(errorMessage(caught))).finally(() => setBusy(false));
		},
	};
}

function updateProvider(input: IModelsInput, providerId: string, change: (provider: IProviderInput) => IProviderInput): IModelsInput {
	return { ...input, providers: input.providers.map(provider => provider.id === providerId ? change(provider) : provider) };
}

/** 上下文长度：200000 → 200k；按 1024 算的整数（131072、1048576）显示成 128k、1M。先按 1000 算，128000 也能被 1024 整除。 */
function contextSize(count: number): string {
	if (count % 1_000_000 === 0) return `${count / 1_000_000}M`;
	if (count % 1_048_576 === 0) return `${count / 1_048_576}M`;
	if (count >= 1_000_000) return `${Number((count / 1_000_000).toFixed(1))}M`;
	if (count % 1000 === 0) return `${count / 1000}k`;
	if (count % 1024 === 0) return `${count / 1024}k`;
	return `${Number((count / 1000).toFixed(1))}k`;
}
