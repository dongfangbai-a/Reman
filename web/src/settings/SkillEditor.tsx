import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { api } from '../api/client.ts';
import { useSkillDetail } from '../api/directory.ts';
import { queryKeys } from '../api/keys.ts';
import type { ISkillDetail } from '../api/types.ts';
import { errorMessage } from '../lib/errors.ts';
import { PromptSection } from '../members/PromptSection.tsx';
import { BackLink } from '../ui/BackLink.tsx';
import { Button } from '../ui/Button.tsx';
import { Field, INPUT_CLASS } from '../ui/Dialog.tsx';
import { SettingsPage } from './SettingsPage.tsx';

/** 新建或编辑技能目录里的技能：技能名（只在新建时填）、说明、正文。 */
export function SkillEditor() {
	const { name: editing } = useParams();
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const detail = useSkillDetail(editing);
	const [name, setName] = useState('');
	const [description, setDescription] = useState('');
	const [body, setBody] = useState('');
	const [loaded, setLoaded] = useState(!editing);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string>();

	// 编辑时用取到的内容填表单，只填一次，之后别处改了也不覆盖正在改的内容。
	useEffect(() => {
		if (loaded || !detail.data) return;
		setDescription(detail.data.skill.description);
		setBody(detail.data.body);
		setLoaded(true);
	}, [loaded, detail.data]);

	const back = editing ? `/settings/skills/${editing}` : '/settings/skills';
	const save = async () => {
		setError(undefined);
		setSaving(true);
		try {
			const saved = editing
				? await api<ISkillDetail>('PUT', `/v1/skills/${encodeURIComponent(editing)}`, { description, body })
				: await api<ISkillDetail>('POST', '/v1/skills', { name: name.trim(), description, body });
			queryClient.setQueryData(queryKeys.skill(saved.skill.name), saved);
			navigate(`/settings/skills/${saved.skill.name}`, { replace: true });
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setSaving(false);
		}
	};

	if (editing && detail.isError) {
		return (
			<SettingsPage>
				<BackLink to="/settings/skills" label="技能" />
				<div className="text-[13px] text-danger">{detail.error.message}</div>
			</SettingsPage>
		);
	}
	if (editing && detail.data?.skill.source === 'builtin') {
		return (
			<SettingsPage>
				<BackLink to={back} label={editing} />
				<div className="text-[13px] text-fg-2">内置技能不能修改，可先复制为自定义技能。</div>
			</SettingsPage>
		);
	}
	return (
		<SettingsPage>
			<BackLink to={back} label={editing ?? '技能'} />
			<h1 className="mb-5 text-xl font-semibold">{editing ? <>编辑 <span className="font-mono">{editing}</span></> : '新建技能'}</h1>
			{!loaded
				? <div className="text-center text-[13px] text-fg-3">正在加载…</div>
				: (
					<div className="flex flex-col gap-4">
						{!editing && (
							<Field label="技能名" hint="小写英文字母、数字和横杠，例如 code-review。创建后不能修改。">
								<input autoFocus value={name} onChange={event => setName(event.target.value)} className={`${INPUT_CLASS} font-mono`} spellCheck={false} />
							</Field>
						)}
						<Field label="说明" hint="写明适用场景，成员据此判断是否读取该技能；成员看到的列表中仅显示前 160 个字。">
							<textarea
								value={description}
								onChange={event => setDescription(event.target.value)}
								rows={3}
								className="field-textarea"
							/>
						</Field>
						<PromptSection
							value={body}
							onChange={setBody}
							label="正文"
							placeholder="具体做法：步骤、规则、格式要求和易错之处"
							title={editing ? `${editing} 的正文` : '技能正文'}
							className="h-96"
						/>
						<div className="flex items-center gap-2">
							<div className="min-w-0 flex-1 text-[13px] text-danger">{error && `保存失败：${error}`}</div>
							<Button disabled={saving} onClick={() => navigate(back)}>取消</Button>
							<Button variant="primary" disabled={saving} onClick={() => void save()}>{editing ? '保存' : '新建'}</Button>
						</div>
					</div>
				)}
		</SettingsPage>
	);
}
