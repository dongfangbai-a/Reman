import clsx from 'clsx';
import type { ButtonHTMLAttributes } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

const VARIANT_CLASS: Record<Variant, string> = { primary: 'button-primary', secondary: 'button-secondary', ghost: 'button-ghost', danger: 'button-danger' };

/** 文字按钮。默认样式在 index.css 的 .button、.button-*，传进来的类能直接盖过它（如 h-7）。 */
export function Button({ variant = 'secondary', className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
	return <button type="button" className={clsx('button', VARIANT_CLASS[variant], className)} {...props} />;
}

/** 只有图标的按钮，label 用作无障碍名称和悬停提示。默认样式在 index.css 的 .icon-button，传进来的类能直接盖过它（如 size-6）。 */
export function IconButton({ label, className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
	return (
		<button
			type="button"
			aria-label={label}
			title={label}
			className={clsx('icon-button', className)}
			{...props}
		/>
	);
}
