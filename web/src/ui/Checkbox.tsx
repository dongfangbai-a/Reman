import clsx from 'clsx';
import { Check } from 'lucide-react';

/** 勾选框的方块，放在可点的行里用。 */
export function CheckMark({ checked, disabled }: { checked: boolean; disabled?: boolean }) {
	return (
		<span className={clsx(
			'flex size-4 shrink-0 items-center justify-center rounded border',
			checked ? 'border-accent bg-accent text-on-accent' : 'border-line-strong',
			disabled && 'opacity-50',
		)}>
			{checked && <Check size={12} />}
		</span>
	);
}
