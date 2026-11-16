import clsx from 'clsx';
import type { ReactNode } from 'react';

/** 设置页的外框：可以滚动，内容居中。wide：列多的页面（模型）宽一档。 */
export function SettingsPage({ wide = false, children }: { wide?: boolean; children: ReactNode }) {
	return (
		<div className="h-full overflow-y-auto">
			<div className={clsx('mx-auto px-3 py-4 md:px-8 md:py-8', wide ? 'max-w-3xl' : 'max-w-2xl')}>{children}</div>
		</div>
	);
}
