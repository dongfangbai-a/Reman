import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api } from '../api/client.ts';
import { queryKeys } from '../api/keys.ts';
import { errorMessage } from '../lib/errors.ts';
import { Button } from '../ui/Button.tsx';

/** 还没有任何真人成员时，先创建一个，代表使用者自己。 */
export function CreateFirstHuman() {
	const queryClient = useQueryClient();
	const [name, setName] = useState('');
	const [error, setError] = useState('');
	const [busy, setBusy] = useState(false);

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (!name.trim()) return setError('请输入名字');
		setBusy(true);
		try {
			await api('POST', '/v1/members', { type: 'human', name: name.trim() });
			await queryClient.invalidateQueries({ queryKey: queryKeys.members });
		} catch (caught) {
			setError(errorMessage(caught));
			setBusy(false);
		}
	};

	return (
		<div className="flex h-full items-center justify-center p-8">
			<form onSubmit={event => void submit(event)} className="flex w-80 flex-col gap-3">
				<div className="text-[17px] font-semibold">欢迎使用 Reman</div>
				<div className="text-fg-2">请先填写你的名字，创建一个代表你本人的真人成员，并在对话中以该成员的身份收发消息。</div>
				<input
					autoFocus
					value={name}
					onChange={event => {
						setName(event.target.value);
						setError('');
					}}
					placeholder="你的名字"
					className="h-9 rounded-md border border-line-strong bg-raised px-3 outline-none focus:border-accent"
				/>
				{error && <div className="text-[13px] text-danger">{error}</div>}
				<Button type="submit" variant="primary" disabled={busy}>开始</Button>
			</form>
		</div>
	);
}
