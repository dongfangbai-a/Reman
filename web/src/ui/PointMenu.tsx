import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useRef, type MouseEvent, type ReactNode, type TouchEvent } from 'react';
import { MenuContent } from './Menu.tsx';

/** 手指按住这么久算长按。 */
const LONG_PRESS_MS = 500;
/** 按住时移动超过这么远算滚动，不弹菜单。 */
const MOVE_SLACK = 10;

export interface IPoint {
	readonly x: number;
	readonly y: number;
}

/**
 * 在某个位置弹出的菜单：右键和长按共用。
 * 只在成员、对话列表的每一项、分组标题、工作台的标签和 Git 面板的文件、提交上用，别处保留浏览器自己的右键菜单（复制、粘贴、在新标签页打开链接都要用）。
 */
export function PointMenu({ point, onClose, children }: { point: IPoint | undefined; onClose: () => void; children: ReactNode }) {
	return (
		<DropdownMenu.Root open={!!point} onOpenChange={open => !open && onClose()} modal={false}>
			<DropdownMenu.Trigger asChild>
				<span aria-hidden className="pointer-events-none fixed size-0" style={{ left: point?.x ?? 0, top: point?.y ?? 0 }} />
			</DropdownMenu.Trigger>
			{/* 手机上长按松手时，焦点可能被系统抢走（华为的浏览器甚至会先取消这次触摸）：不因为失焦就关掉菜单，点外面仍然会关。 */}
			<MenuContent align="start" sideOffset={2} onCloseAutoFocus={event => event.preventDefault()} onFocusOutside={event => event.preventDefault()}>
				{children}
			</MenuContent>
		</DropdownMenu.Root>
	);
}

/** 右键和长按都打开菜单；长按弹出后松手不算点击。 */
export function useMenuTrigger(open: (point: IPoint) => void) {
	const timer = useRef<number | undefined>(undefined);
	const start = useRef<IPoint | undefined>(undefined);
	const fired = useRef(false);
	const settle = useRef<number | undefined>(undefined);
	const cancel = () => {
		window.clearTimeout(timer.current);
		timer.current = undefined;
	};
	/** 这次算长按的标记晚一点再清：有的浏览器松手后才补发 click，清早了那一行就会被点开。 */
	const quiet = () => {
		window.clearTimeout(settle.current);
		settle.current = window.setTimeout(() => { fired.current = false; }, 700);
	};
	return {
		onContextMenu: (event: MouseEvent) => {
			// 手机上长按也会触发浏览器的菜单：由长按打开我们的，浏览器的不弹。
			const touch = start.current !== undefined;
			event.preventDefault();
			if (touch) return;
			cancel();
			open({ x: event.clientX, y: event.clientY });
		},
		onTouchStart: (event: TouchEvent) => {
			const touch = event.touches[0];
			cancel();
			window.clearTimeout(settle.current);
			fired.current = false;
			if (!touch || event.touches.length > 1) return;
			start.current = { x: touch.clientX, y: touch.clientY };
			timer.current = window.setTimeout(() => {
				timer.current = undefined;
				fired.current = true;
				open(start.current!);
			}, LONG_PRESS_MS);
		},
		onTouchMove: (event: TouchEvent) => {
			const touch = event.touches[0];
			if (touch && start.current && Math.hypot(touch.clientX - start.current.x, touch.clientY - start.current.y) > MOVE_SLACK) cancel();
		},
		onTouchEnd: (event: TouchEvent) => {
			cancel();
			start.current = undefined;
			if (!fired.current) return;
			// 长按弹出菜单后松手：挡住浏览器补发的 mousedown 和 click。不然焦点会回到这一行，菜单立刻因为失焦关掉。
			event.preventDefault();
			quiet();
		},
		onTouchCancel: () => {
			cancel();
			start.current = undefined;
			// 系统打断（比如弹出了自己的长按菜单）之后可能还补一个 click，标记不能立刻清。
			if (fired.current) quiet();
		},
		onClickCapture: (event: MouseEvent) => {
			if (!fired.current) return;
			fired.current = false;
			window.clearTimeout(settle.current);
			event.preventDefault();
			event.stopPropagation();
		},
	};
}
