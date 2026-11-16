import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api/client.ts';
import { useBrowserBlocklist } from '../api/directory.ts';
import { queryKeys } from '../api/keys.ts';
import type { IBrowserBlocklist } from '../api/types.ts';
import { errorMessage } from '../lib/errors.ts';
import { BackLink } from '../ui/BackLink.tsx';
import { Button } from '../ui/Button.tsx';
import { INPUT_CLASS } from '../ui/Dialog.tsx';
import { SettingsPage } from './SettingsPage.tsx';

/** 浏览器：成员的浏览器禁止访问的网址。运行时的网页端总是禁止，用户加的立即保存。 */
export function BrowserSettings() {
	const queryClient = useQueryClient();
	const blocklist = useBrowserBlocklist();
	const [input, setInput] = useState('');
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const data = blocklist.data;

	const save = async (hosts: readonly string[]): Promise<IBrowserBlocklist | undefined> => {
		setError(undefined);
		setBusy(true);
		try {
			const result = await api<IBrowserBlocklist>('PUT', '/v1/browser-blocklist', { hosts });
			queryClient.setQueryData(queryKeys.browserBlocklist, result);
			return result;
		} catch (caught) {
			setError(errorMessage(caught));
			return undefined;
		} finally {
			setBusy(false);
		}
	};
	const add = async () => {
		if (!data || !input.trim()) return;
		const result = await save([...data.hosts, input]);
		if (!result) return;
		setInput('');
		if (result.hosts.length === data.hosts.length) setError('已存在');
	};

	return (
		<SettingsPage>
			<BackLink to="/settings" label="设置" />
			<h1 className="mb-1 text-xl font-semibold">浏览器</h1>
			<div className="mb-5 text-[13px] text-fg-2">成员的浏览器无法打开这些网址，页面中也无法请求这些网址。</div>
			{blocklist.isPending && <div className="text-center text-[13px] text-fg-3">正在加载…</div>}
			{blocklist.isError && <div className="text-[13px] text-danger">加载失败：{blocklist.error.message}</div>}
			{data && (
				<section className="rounded-xl border border-line bg-raised">
					<h2 className="px-4 pt-4 pb-2 font-semibold">禁止访问的网址</h2>
					<div className="divide-y divide-line border-t border-line">
						<div className="flex h-10 items-center gap-3 px-4 text-[13px]">
							<span>运行时的网页端</span>
							{data.runtime && <span className="min-w-0 truncate font-mono text-fg-2">{data.runtime}</span>}
							<span className="ml-auto shrink-0 text-xs text-fg-3">始终禁止</span>
						</div>
						{data.hosts.map(host => (
							<div key={host} className="flex h-10 items-center gap-3 pr-2 pl-4 text-[13px]">
								<span className="min-w-0 flex-1 truncate font-mono">{host}</span>
								<Button variant="ghost" className="shrink-0 text-fg-2" disabled={busy} onClick={() => void save(data.hosts.filter(item => item !== host))}>删除</Button>
							</div>
						))}
					</div>
					<div className="border-t border-line p-4">
						<form className="flex gap-2" onSubmit={event => {
							event.preventDefault();
							void add();
						}}>
							<input
								value={input}
								onChange={event => {
									setInput(event.target.value);
									setError(undefined);
								}}
								placeholder="域名或地址，如 example.com、localhost:8888"
								aria-label="要禁止的网址"
								className={INPUT_CLASS}
								spellCheck={false}
							/>
							<Button type="submit" className="shrink-0" disabled={busy || !input.trim()}>添加</Button>
						</form>
						{error && <div className="mt-2 text-[13px] text-danger">{error}</div>}
						<div className="mt-3 text-xs text-fg-3">
							域名包含其子域名；未指定端口时禁止所有端口；localhost 与 127.0.0.1 视为同一地址。仅作用于成员的浏览器，命令行中的 curl 和 MCP 服务器不受影响。
						</div>
					</div>
				</section>
			)}
		</SettingsPage>
	);
}
