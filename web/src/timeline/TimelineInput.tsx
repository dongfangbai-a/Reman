import { useState, type RefObject } from 'react';
import { api } from '../api/client.ts';
import type { IMember } from '../api/types.ts';
import { Composer, type IComposerHandle, type IOutgoing } from '../chat/Composer.tsx';
import { errorMessage } from '../lib/errors.ts';

/**
 * 直接对成员说话：不属于任何对话，进它的时间线并唤醒它。输入框和对话里的一样，可以带附件，没有点名。
 * 草稿按成员保存；打开时不抢输入焦点，和对话并排时光标留在对话的输入框。
 */
export function TimelineInput({ member, composer }: { member: IMember; composer: RefObject<IComposerHandle | null> }) {
	const [error, setError] = useState<string>();

	const send = async (outgoing: IOutgoing) => {
		setError(undefined);
		try {
			await api('POST', `/v1/members/${member.memberId}/timeline`, {
				text: outgoing.text,
				attachments: outgoing.attachments.map(item => item.attachmentId),
			});
		} catch (caught) {
			setError(errorMessage(caught));
			composer.current?.restore(outgoing);
		}
	};

	return (
		<div className="shrink-0">
			{error && <div className="center-column px-4 pb-1 text-xs text-danger">发送失败：{error}</div>}
			<Composer
				ref={composer}
				draftKey={`timeline|${member.memberId}`}
				placeholder={`对 ${member.name} 说…`}
				mentionCandidates={undefined}
				autoFocus={false}
				className="center-column px-4 pb-4 pt-1"
				onSend={outgoing => void send(outgoing)}
			/>
		</div>
	);
}
