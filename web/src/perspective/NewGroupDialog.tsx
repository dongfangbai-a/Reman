import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../api/client.ts';
import { conversationPath, queryKeys } from '../api/keys.ts';
import { useMembers } from '../api/queries.ts';
import type { IGroup } from '../api/types.ts';
import { errorMessage } from '../lib/errors.ts';
import { MemberPicker } from '../members/MemberPicker.tsx';
import { Button } from '../ui/Button.tsx';
import { Dialog, Field, INPUT_CLASS } from '../ui/Dialog.tsx';
import { SelfName } from '../ui/SelfName.tsx';
import { usePerspective } from './perspective.tsx';

/** 新建群聊：创建者是视角成员，建好后打开这个群聊。 */
export function NewGroupDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
	const perspective = usePerspective();
	const members = useMembers();
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const [name, setName] = useState('');
	const [chosen, setChosen] = useState<string[]>([]);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const candidates = (members.data ?? []).filter(member => !member.deleted && member.memberId !== perspective.memberId);
	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setError(undefined);
		try {
			const { group } = await api<{ group: IGroup }>('POST', '/v1/groups', { ownerMemberId: perspective.memberId, name: name.trim(), memberIds: chosen });
			await queryClient.invalidateQueries({ queryKey: queryKeys.conversations(perspective.memberId) });
			onOpenChange(false);
			setName('');
			setChosen([]);
			navigate(conversationPath(perspective.memberId, { kind: 'group', groupId: group.groupId }));
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	};
	return (
		<Dialog open={open} onOpenChange={onOpenChange} title="新建群聊" width="w-[460px]">
			<form onSubmit={event => void submit(event)} className="space-y-4">
				<Field label="群名">
					<input value={name} onChange={event => setName(event.target.value)} className={INPUT_CLASS} />
				</Field>
				<div>
					<div className="mb-1 text-[13px] font-medium">成员 <span className="font-normal text-fg-3">已选 {chosen.length} 人，<SelfName name={perspective.name} /> 是创建者</span></div>
					<MemberPicker candidates={candidates} selected={chosen} onChange={setChosen} />
				</div>
				{error && <div className="text-[13px] text-danger">{error}</div>}
				<div className="flex justify-end">
					<Button type="submit" variant="primary" disabled={busy || !name.trim()}>新建</Button>
				</div>
			</form>
		</Dialog>
	);
}
