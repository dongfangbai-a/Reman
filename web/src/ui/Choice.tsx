import clsx from 'clsx';

/** 一排单选按钮里的一个：方框按钮，选中的用强调色。外面包一层 role="radiogroup"。 */
export function Choice({ checked, disabled, onClick, children }: { checked: boolean; disabled?: boolean; onClick: () => void; children: string }) {
	return (
		<button
			type="button"
			role="radio"
			aria-checked={checked}
			disabled={disabled}
			onClick={onClick}
			className={clsx('h-8 rounded-md border px-2.5 text-xs', checked ? 'border-accent bg-accent-soft text-accent' : 'border-line hover:bg-hover')}
		>
			{children}
		</button>
	);
}
