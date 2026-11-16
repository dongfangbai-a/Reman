import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import clsx from 'clsx';
import type { ComponentProps, ReactNode } from 'react';

export function MenuContent({ className, children, ...props }: ComponentProps<typeof DropdownMenu.Content>) {
	return (
		<DropdownMenu.Portal>
			<DropdownMenu.Content
				sideOffset={6}
				className={clsx('menu-panel', className)}
				{...props}
			>
				{children}
			</DropdownMenu.Content>
		</DropdownMenu.Portal>
	);
}

/** 菜单项的样子：MenuItem 和子菜单、勾选项共用。 */
export const MENU_ITEM_CLASS = 'flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-[13px] outline-none data-[highlighted]:bg-hover';

export function MenuItem({ className, ...props }: ComponentProps<typeof DropdownMenu.Item>) {
	return (
		<DropdownMenu.Item
			className={clsx(MENU_ITEM_CLASS, className)}
			{...props}
		/>
	);
}

export function MenuLabel({ children }: { children: ReactNode }) {
	return <DropdownMenu.Label className="px-2 pb-1 pt-2 text-xs text-fg-3">{children}</DropdownMenu.Label>;
}

export function MenuSeparator() {
	return <DropdownMenu.Separator className="my-1 h-px bg-line" />;
}
