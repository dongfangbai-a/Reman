import clsx from 'clsx';
import type { ButtonHTMLAttributes, MouseEvent } from 'react';

/**
 * 文字链接样子的按钮：时间线、消息这类内容里的操作（取消、重试、放回输入框），跟在一行字后面，不用带边框的按钮，免得突兀。
 * 字号跟着所在的那行字。problem 是现在不能点的原因：变灰，悬停写原因（盖过 title），点了没反应。
 */
export function TextButton({ problem, className, onClick, title, ...props }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'disabled'> & { problem?: string | false }) {
	const blocked = !!problem;
	return (
		<button
			type="button"
			title={problem || title}
			aria-disabled={blocked || undefined}
			onClick={(event: MouseEvent<HTMLButtonElement>) => { if (!blocked) onClick?.(event); }}
			className={clsx(
				'shrink-0 rounded-sm focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-accent',
				blocked ? 'cursor-default text-fg-3 opacity-60' : 'text-accent hover:underline',
				className,
			)}
			{...props}
		/>
	);
}
