import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api/client.ts';
import { queryKeys } from '../api/keys.ts';
import { errorMessage } from '../lib/errors.ts';
import { Button } from '../ui/Button.tsx';
import { Dialog, Field, INPUT_CLASS } from '../ui/Dialog.tsx';

/** 新建真人：只填名字，建好后出现在成员列表里。 */
export function NewHumanDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
	const queryClient = useQueryClient();
	return (
		<NameDialog
			open={open}
			onOpenChange={onOpenChange}
			title="新建真人"
			label="名字"
			submitLabel="新建"
			onSubmit={async name => {
				await api('POST', '/v1/members', { type: 'human', name });
				await queryClient.invalidateQueries({ queryKey: queryKeys.members });
			}}
		/>
	);
}

/** 新建分组或给分组改名：名字不能为空、最多 20 个字、不能和已有的重复，由运行时检查。 */
export function SectionNameDialog({ open, onOpenChange, title, initial = '', submitLabel, onSubmit }: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	initial?: string;
	submitLabel: string;
	onSubmit: (name: string) => Promise<void>;
}) {
	return <NameDialog open={open} onOpenChange={onOpenChange} title={title} label="分组名" hint="最多 20 个字" initial={initial} submitLabel={submitLabel} onSubmit={onSubmit} />;
}

function NameDialog({ open, onOpenChange, title, label, hint, initial = '', submitLabel, onSubmit }: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	label: string;
	hint?: string;
	initial?: string;
	submitLabel: string;
	onSubmit: (name: string) => Promise<void>;
}) {
	const [name, setName] = useState(initial);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	useEffect(() => {
		if (!open) return;
		setName(initial);
		setError(undefined);
	}, [open, initial]);
	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setError(undefined);
		try {
			await onSubmit(name.trim());
			onOpenChange(false);
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	};
	return (
		<Dialog open={open} onOpenChange={onOpenChange} title={title}>
			<form onSubmit={event => void submit(event)} className="space-y-4">
				<Field label={label} hint={hint}>
					<input value={name} onChange={event => setName(event.target.value)} className={INPUT_CLASS} />
				</Field>
				{error && <div className="text-[13px] text-danger">{error}</div>}
				<div className="flex justify-end">
					<Button type="submit" variant="primary" disabled={busy || !name.trim()}>{submitLabel}</Button>
				</div>
			</form>
		</Dialog>
	);
}
