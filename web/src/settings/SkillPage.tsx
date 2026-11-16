import { useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router';
import { api } from '../api/client.ts';
import { useSkillDetail } from '../api/directory.ts';
import { queryKeys } from '../api/keys.ts';
import { useMembers } from '../api/queries.ts';
import type { ISkillDetail } from '../api/types.ts';
import { Markdown } from '../chat/Markdown.tsx';
import { openMemberDialog } from '../layout/uiState.ts';
import { errorMessage } from '../lib/errors.ts';
import { BackLink } from '../ui/BackLink.tsx';
import { Button } from '../ui/Button.tsx';
import { CopyablePath } from '../ui/CopyablePath.tsx';
import { ConfirmDialog } from '../ui/Dialog.tsx';
import { UsedBy } from '../ui/UsedBy.tsx';
import { SettingsPage } from './SettingsPage.tsx';
import { SkillTag, skillUsers } from './SkillsSettings.tsx';

/** 一个技能的详情。技能目录里的技能可以编辑、删除；内置技能只读，可以复制为自己的。 */
export function SkillPage() {
	const { name = '' } = useParams();
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const detail = useSkillDetail(name);
	const members = useMembers();
	const [confirming, setConfirming] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const users = skillUsers(members.data, name);

	const copy = async (directory: string) => {
		setError(undefined);
		setBusy(true);
		try {
			queryClient.setQueryData(queryKeys.skill(name), await api<ISkillDetail>('POST', '/v1/skills/import', { directory }));
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	};
	const remove = async () => {
		setError(undefined);
		setBusy(true);
		try {
			await api('DELETE', `/v1/skills/${encodeURIComponent(name)}`);
			setConfirming(false);
			navigate('/settings/skills');
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	};

	if (detail.isPending) return <SettingsPage><div className="text-center text-[13px] text-fg-3">正在加载…</div></SettingsPage>;
	if (detail.isError) {
		return (
			<SettingsPage>
				<BackLink to="/settings/skills" label="技能" />
				<div className="text-[13px] text-danger">{detail.error.message}</div>
				</SettingsPage>
		);
	}
	const { skill, body, files, moreFiles } = detail.data;
	const builtin = skill.source === 'builtin';
	return (
		<SettingsPage>
			<BackLink to="/settings/skills" label="技能" />
			<div className="mb-1 flex items-center gap-2">
				<h1 className="min-w-0 truncate font-mono text-xl font-semibold">{skill.name}</h1>
				<SkillTag skill={skill} />
				<div className="ml-auto flex shrink-0 gap-2">
					{builtin
						? <Button disabled={busy} onClick={() => void copy(skill.directory)}>复制为自定义技能</Button>
						: (
							<>
								<Button disabled={busy} onClick={() => setConfirming(true)}>删除</Button>
								<Button variant="primary" disabled={busy} onClick={() => navigate(`/settings/skills/${skill.name}/edit`)}>编辑</Button>
							</>
						)}
				</div>
			</div>
			<div className="text-[13px] text-fg-2">{skill.description || '无说明'}</div>
			{builtin && <div className="mt-1 text-xs text-fg-3">内置技能不能修改。复制为自定义技能后，将使用复制的版本，且可以修改。</div>}
			{error && !confirming && <div className="mt-2 text-[13px] text-danger">{error}</div>}

			<Section title="文件夹"><CopyablePath path={skill.directory} /></Section>
			<Section title="正在使用的成员">
				{users.length === 0
					? <span className="text-[13px] text-fg-3">暂无成员选用</span>
					: (
						<div className="flex flex-wrap gap-x-3 gap-y-1 text-[13px]">
							{users.map(member => <button key={member.memberId} type="button" onClick={() => openMemberDialog({ kind: 'settings', memberId: member.memberId })} className="text-accent hover:underline">{member.name}</button>)}
						</div>
					)}
			</Section>
			{files.length > 0 && (
				<Section title="其他文件">
					<div className="font-mono text-xs leading-5 text-fg-2">
						{files.map(file => <div key={file} className="truncate" title={file}>{file}</div>)}
						{moreFiles && <div className="font-sans text-fg-3">另有更多文件未列出</div>}
					</div>
				</Section>
			)}
			<Section title="正文">
				<div className="rounded-xl border border-line bg-raised px-5 py-4 text-[13px]"><Markdown text={body} /></div>
			</Section>

			<ConfirmDialog
				open={confirming}
				onOpenChange={setConfirming}
				title={`删除技能 ${skill.name}？`}
				detail={(
					<>
						<p>将删除整个技能文件夹{skill.overridesBuiltin ? '，之后恢复使用内置的同名技能' : ''}。</p>
						{users.length > 0 && <p className="mt-2">正在使用的成员配置保持不变，读取该技能时会提示已删除。</p>}
						<UsedBy members={users} />
					</>
				)}
				confirmLabel="删除"
				busy={busy}
				error={confirming ? error : undefined}
				onConfirm={() => void remove()}
			/>
		</SettingsPage>
	);
}

function Section({ title, children }: { title: string; children: ReactNode }) {
	return (
		<section className="mt-5">
			<h2 className="mb-1.5 text-[13px] font-medium">{title}</h2>
			{children}
		</section>
	);
}
