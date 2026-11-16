import * as Popover from '@radix-ui/react-popover';
import { CircleQuestionMark } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';

const OPEN_DELAY_MS = 150;
const CLOSE_DELAY_MS = 120;

/**
 * 标签后面的问号图标：设置项短的补充说明放在这里，不单独占一行灰字。
 * 鼠标悬停、键盘聚焦时弹出小卡片；触屏没有悬停，点一下打开。点别处或按 Esc 关掉。
 */
export function HelpTip({ label, children }: { label: string; children: ReactNode }) {
	const [open, setOpen] = useState(false);
	const timer = useRef<number | undefined>(undefined);
	const pointer = useRef('mouse');
	useEffect(() => () => window.clearTimeout(timer.current), []);

	const change = (next: boolean, delay = 0) => {
		window.clearTimeout(timer.current);
		if (delay === 0) setOpen(next);
		else timer.current = window.setTimeout(() => setOpen(next), delay);
	};
	const hoverHandlers = {
		onPointerEnter: (event: { pointerType: string }) => event.pointerType === 'mouse' && change(true, OPEN_DELAY_MS),
		onPointerLeave: (event: { pointerType: string }) => event.pointerType === 'mouse' && change(false, CLOSE_DELAY_MS),
	};

	return (
		<Popover.Root open={open} onOpenChange={next => change(next)}>
			<Popover.Trigger asChild>
				<button
					type="button"
					aria-label={`${label}的说明`}
					{...hoverHandlers}
					onPointerDown={event => { pointer.current = event.pointerType; }}
					// 鼠标靠悬停打开和关闭，点击不再切换；触屏和键盘照常点开。
					onClick={event => { if (pointer.current === 'mouse' && event.detail > 0) event.preventDefault(); }}
					onFocus={event => { if (event.currentTarget.matches(':focus-visible')) change(true); }}
					onBlur={() => change(false)}
					className="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-fg-3 hover:text-fg-2 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-accent"
				>
					<CircleQuestionMark size={14} aria-hidden />
				</button>
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content
					side="top"
					align="start"
					sideOffset={6}
					onOpenAutoFocus={event => event.preventDefault()}
					{...hoverHandlers}
					className="z-50 max-w-72 rounded-lg border border-line bg-raised px-3 py-2 text-xs leading-5 text-fg-2 shadow-lg"
				>
					{children}
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}
