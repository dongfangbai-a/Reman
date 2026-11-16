import { useState } from 'react';
import type { IMember } from '../api/types.ts';
import { ConfirmDialog, Dialog } from '../ui/Dialog.tsx';
import { AiEditor } from './AiEditor.tsx';
import { MemberDetail } from './MemberDetail.tsx';

/**
 * 成员设置的弹窗；不给 member 时是新建 AI 成员。AI 成员的高度固定，保存栏一直在最下面一行；
 * 有没保存的修改时，关闭前先确认。
 */
export function MemberSettingsDialog({ member, open, onOpenChange }: { member?: IMember; open: boolean; onOpenChange: (open: boolean) => void }) {
	const [dirty, setDirty] = useState(false);
	const [confirming, setConfirming] = useState(false);
	const [footer, setFooter] = useState<HTMLDivElement | null>(null);
	const wide = !member || (member.type === 'ai' && !member.deleted);
	const close = () => onOpenChange(false);

	const change = (next: boolean) => {
		if (!next && dirty) setConfirming(true);
		else onOpenChange(next);
	};
	return (
		<>
			<Dialog open={open} onOpenChange={change} title={member ? '成员设置' : '新建 AI 成员'} width={wide ? 'w-[72rem]' : 'w-[42rem]'} height={wide ? 'h-[85vh]' : ''} dense focusInput={!member}
				footer={wide ? <div ref={setFooter} /> : undefined}>
				{member
					? <MemberDetail member={member} onDirtyChange={setDirty} saveBarTarget={footer} onDone={close} />
					: <AiEditor onDirtyChange={setDirty} saveBarTarget={footer} onClose={close} />}
			</Dialog>
			<ConfirmDialog
				open={confirming}
				onOpenChange={setConfirming}
				title="放弃修改？"
				detail="有未保存的修改，关闭后将会丢失。"
				confirmLabel="放弃"
				onConfirm={() => {
					setConfirming(false);
					setDirty(false);
					close();
				}}
			/>
		</>
	);
}
