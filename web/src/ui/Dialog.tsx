import * as RadixDialog from '@radix-ui/react-dialog';
import clsx from 'clsx';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button, IconButton } from './Button.tsx';

/** 居中的对话框：标题一行固定，下面的内容区域自己滚动；footer 固定在最下面，不随内容滚动。 */
export function Dialog({ open, onOpenChange, title, children, footer, width = 'w-[420px]', height = '', dense = false, focusInput = true }: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	children: ReactNode;
	footer?: ReactNode;
	width?: string;
	/** 固定高度，内容变化时对话框不跟着伸缩、不上下移动。 */
	height?: string;
	/** 标题一行收紧，给内容多留地方。 */
	dense?: boolean;
	/** 打开时先聚焦第一个输入框；设置页这类内容不需要。 */
	focusInput?: boolean;
}) {
	return (
		<RadixDialog.Root open={open} onOpenChange={onOpenChange}>
			<RadixDialog.Portal>
				<RadixDialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
				<RadixDialog.Content
					aria-describedby={undefined}
					onOpenAutoFocus={event => {
						// 有输入框时先聚焦输入框，而不是右上角的关闭按钮。
						const input = focusInput && (event.currentTarget as HTMLElement).querySelector<HTMLElement>('input:not([type=hidden]), textarea');
						if (input) {
							event.preventDefault();
							input.focus();
						}
					}}
					className={`fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-line bg-raised shadow-xl outline-none ${width} ${height}`}
				>
					<div className={clsx('flex shrink-0 items-center justify-between px-5', dense ? 'pb-1 pt-3' : 'pb-4 pt-5')}>
						<RadixDialog.Title className="font-semibold">{title}</RadixDialog.Title>
						<RadixDialog.Close asChild><IconButton label="关闭"><X size={16} /></IconButton></RadixDialog.Close>
					</div>
					<div className={clsx('min-h-0 flex-1 overflow-y-auto px-5', footer ? 'pb-4' : 'pb-5')}>{children}</div>
					{footer && <div className="shrink-0">{footer}</div>}
				</RadixDialog.Content>
			</RadixDialog.Portal>
		</RadixDialog.Root>
	);
}

/** 确认对话框：危险操作前用。 */
export function ConfirmDialog({ open, onOpenChange, title, detail, confirmLabel, cancelLabel = '取消', onConfirm, busy, error }: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	detail: ReactNode;
	confirmLabel: string;
	/** 关闭按钮的文字，和确认按钮的意思容易混时换掉。 */
	cancelLabel?: string;
	onConfirm: () => void;
	busy?: boolean;
	error?: string;
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange} title={title}>
			<div className="text-[13px] text-fg-2">{detail}</div>
			{error && <div className="mt-3 text-[13px] text-danger">{error}</div>}
			<div className="mt-5 flex justify-end gap-2">
				<RadixDialog.Close asChild><Button variant="ghost">{cancelLabel}</Button></RadixDialog.Close>
				<Button variant="danger" disabled={busy} onClick={onConfirm}>{confirmLabel}</Button>
			</div>
		</Dialog>
	);
}

/** 对话框里的一项：标题、输入框、说明。aside 放在标题那一行的右边；optional 时标题旁标「选填」。 */
export function Field({ label, hint, aside, optional, children }: { label: string; hint?: ReactNode; aside?: ReactNode; optional?: boolean; children: ReactNode }) {
	return (
		<label className="block">
			<div className="mb-1 flex items-center gap-2">
				<span className="text-[13px] font-medium">{label}</span>
				{optional && <span className="text-xs text-fg-3">选填</span>}
				{aside && <span className="ml-auto flex items-center gap-1">{aside}</span>}
			</div>
			{children}
			{hint && <div className="mt-1 text-xs text-fg-3">{hint}</div>}
		</label>
	);
}

/** 输入框的类，默认样式在 index.css 的 .field-input，和它一起传的类能直接盖过它（如 h-9）。 */
export const INPUT_CLASS = 'field-input';
