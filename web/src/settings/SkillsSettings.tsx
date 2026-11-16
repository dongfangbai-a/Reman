import { useQueryClient } from '@tanstack/react-query';
import { ChevronRight, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api } from '../api/client.ts';
import { useSkillsSnapshot, type SkillList } from '../api/directory.ts';
import { queryKeys } from '../api/keys.ts';
import { useMembers } from '../api/queries.ts';
import type { IMember, ISkill } from '../api/types.ts';
import { errorMessage } from '../lib/errors.ts';
import { BackLink } from '../ui/BackLink.tsx';
import { Button } from '../ui/Button.tsx';
import { CopyablePath } from '../ui/CopyablePath.tsx';
import { Switch } from '../ui/Switch.tsx';
import { SettingsPage } from './SettingsPage.tsx';

/** 技能：列出全部技能，可以新建、导入，点一行看详情。左边的开关是新成员默认启用，改了立即保存。 */
export function SkillsSettings() {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const snapshot = useSkillsSnapshot();
	const members = useMembers();
	const [error, setError] = useState<string>();
	const [busy, setBusy] = useState(false);
	const data = snapshot.data;
	const setDefault = async (name: string, enabled: boolean) => {
		setError(undefined);
		setBusy(true);
		try {
			queryClient.setQueryData(queryKeys.skills, await api<SkillList>('PUT', `/v1/skill-defaults/${encodeURIComponent(name)}`, { enabled }));
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	};
	return (
		<SettingsPage>
			<BackLink to="/settings" label="设置" />
			<div className="mb-1 flex items-center gap-2">
				<h1 className="flex-1 text-xl font-semibold">技能</h1>
				<Button onClick={() => navigate('/settings/skills/import')}>导入</Button>
				<Button variant="primary" onClick={() => navigate('/settings/skills/new')}>新建</Button>
			</div>
			<div className="text-[13px] text-fg-2">技能是完成某类工作的详细做法，可在成员页为 AI 成员选用，成员在需要时读取。开启的技能会在新建 AI 成员时默认启用，已有成员不受影响。</div>
			{data && <div className="mb-5"><CopyablePath path={data.directory} /></div>}
			{snapshot.isPending && <div className="text-center text-[13px] text-fg-3">正在加载…</div>}
			{snapshot.isError && <div className="text-[13px] text-danger">加载失败：{snapshot.error.message}</div>}
			{data && (
				<section className="divide-y divide-line rounded-xl border border-line bg-raised">
					{data.skills.length === 0 && <div className="px-4 py-3 text-[13px] text-fg-3">暂无技能</div>}
					{data.skills.map(skill => {
						const users = skillUsers(members.data, skill.name).length;
						return (
							<div key={skill.name} className="flex items-center gap-3 pl-4 first:rounded-t-xl last:rounded-b-xl hover:bg-hover">
								<Switch checked={skill.defaultEnabled} label={`新成员默认启用 ${skill.name}`} disabled={busy} onChange={enabled => void setDefault(skill.name, enabled)} />
								<Link to={`/settings/skills/${skill.name}`} className="flex min-w-0 flex-1 items-center gap-3 py-2.5 pr-4">
									<div className="min-w-0 flex-1">
										<div className="flex items-center gap-2">
											<span className="truncate font-mono text-[13px]">{skill.name}</span>
											<SkillTag skill={skill} />
										</div>
										<div className="truncate text-xs text-fg-3" title={skill.description}>{skill.description || '无说明'}</div>
									</div>
									{users > 0 && <span className="shrink-0 text-xs text-fg-3">{users} 个成员正在使用</span>}
									<ChevronRight size={15} className="shrink-0 text-fg-3" />
								</Link>
							</div>
						);
					})}
				</section>
			)}
			{error && <div className="mt-3 text-[13px] text-danger">保存失败：{error}</div>}
			{data && data.issues.length > 0 && (
				<section className="mt-4 rounded-xl border border-line bg-raised">
					<div className="flex h-10 items-center gap-1.5 border-b border-line px-4 text-[13px] font-medium text-warning">
						<TriangleAlert size={14} />无法读取的技能文件夹
					</div>
					<div className="divide-y divide-line">
						{data.issues.map(issue => (
							<div key={issue.directory} className="px-4 py-2.5">
								<div className="font-mono text-[13px]">{issue.name}</div>
								<div className="text-xs text-danger">{issue.message}</div>
								<CopyablePath path={issue.directory} />
							</div>
						))}
					</div>
				</section>
			)}
		</SettingsPage>
	);
}

/** 内置技能标「内置」，技能目录里和内置技能同名的标「覆盖内置」。 */
export function SkillTag({ skill }: { skill: Pick<ISkill, 'source' | 'overridesBuiltin'> }) {
	const label = skill.source === 'builtin' ? '内置' : skill.overridesBuiltin ? '覆盖内置' : undefined;
	return label ? <span className="tag">{label}</span> : null;
}

/** 选用了这个技能的 AI 成员。 */
export function skillUsers(members: readonly IMember[] | undefined, name: string): IMember[] {
	return (members ?? []).filter(member => member.type === 'ai' && !member.deleted && member.skills.includes(name));
}
