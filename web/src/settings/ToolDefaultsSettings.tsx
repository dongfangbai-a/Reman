import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api/client.ts';
import { useToolCatalog } from '../api/directory.ts';
import { queryKeys } from '../api/keys.ts';
import type { IToolInfo, ToolPolicy } from '../api/types.ts';
import { errorMessage } from '../lib/errors.ts';
import { configurableTools, customToolTitle, customTools, ToolRow } from '../members/ToolRow.tsx';
import { BackLink } from '../ui/BackLink.tsx';
import { Button } from '../ui/Button.tsx';
import { ConfirmDialog } from '../ui/Dialog.tsx';
import { SettingsPage } from './SettingsPage.tsx';

/** 工具：新建 AI 成员时工具默认是否启用、默认的审批方式。改了立即保存，已有成员不受影响。 */
export function ToolDefaultsSettings() {
	const queryClient = useQueryClient();
	const catalog = useToolCatalog();
	const [error, setError] = useState<string>();
	const [confirming, setConfirming] = useState(false);
	const [busy, setBusy] = useState(false);
	const configurable = configurableTools(catalog.data ?? []);
	// 自定义工具排在末尾，和成员设置里一样；不显示已停用、未配置，那是调用时的状态，和新成员默认开不开无关。
	const custom = customTools(catalog.data ?? []);
	const customized = [...configurable, ...custom].some(tool => tool.enabled !== tool.builtinEnabled || tool.policy !== tool.builtinPolicy);

	const send = async (method: 'PUT' | 'DELETE', path: string, body?: object) => {
		setError(undefined);
		setBusy(true);
		try {
			const result = await api<{ tools: IToolInfo[] }>(method, path, body);
			queryClient.setQueryData(queryKeys.toolCatalog, result.tools);
			return true;
		} catch (caught) {
			setError(errorMessage(caught));
			return false;
		} finally {
			setBusy(false);
		}
	};
	const change = (name: string, patch: { enabled?: boolean; policy?: ToolPolicy }) => void send('PUT', `/v1/tool-defaults/${encodeURIComponent(name)}`, patch);

	return (
		<SettingsPage>
			<BackLink to="/settings" label="设置" />
			<h1 className="mb-1 text-xl font-semibold">工具</h1>
			<div className="mb-6 text-[13px] text-fg-2">新建 AI 成员时使用以下设置，已有成员不受影响。</div>
			{catalog.isPending && <div className="text-center text-[13px] text-fg-3">正在加载…</div>}
			{catalog.isError && <div className="text-[13px] text-danger">加载失败：{catalog.error.message}</div>}
			{catalog.data && (
				<section className="rounded-xl border border-line bg-raised">
					<div className="flex h-10 items-center justify-between border-b border-line px-4 text-[13px]">
						<span className="font-medium">默认启用</span>
						<span className="text-xs text-fg-3">审批方式</span>
					</div>
					<div className="divide-y divide-line">
						{configurable.map(tool => (
							<ToolRow key={tool.name} tool={tool} enabled={tool.enabled} policy={tool.policy} disabled={busy} onChange={patch => change(tool.name, patch)} />
						))}
						{custom.map(tool => (
							<ToolRow
								key={tool.name}
								tool={tool}
								label={tool.customTool!.folder}
								tag={tool.customTool!.origin === 'builtin' ? '内置' : '自定义'}
								title={customToolTitle(tool)}
								enabled={tool.enabled}
								policy={tool.policy}
								disabled={busy}
								onChange={patch => change(tool.name, patch)}
							/>
						))}
					</div>
				</section>
			)}
			{error && <div className="mt-3 text-[13px] text-danger">保存失败：{error}</div>}
			{customized && (
				<div className="mt-4 flex justify-end">
					<Button disabled={busy} onClick={() => setConfirming(true)}>恢复内置默认</Button>
				</div>
			)}
			<ConfirmDialog
				open={confirming}
				onOpenChange={setConfirming}
				title="恢复内置默认？"
				detail="新建 AI 成员时的工具设置全部恢复内置默认，已有成员不受影响。"
				confirmLabel="恢复"
				busy={busy}
				onConfirm={() => void send('DELETE', '/v1/tool-defaults').then(ok => ok && setConfirming(false))}
			/>
		</SettingsPage>
	);
}
