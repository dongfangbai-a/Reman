import { ChevronsLeft } from 'lucide-react';
import { usePreferences } from '../stores.ts';
import { IconButton } from '../ui/Button.tsx';

/** 列表顶部的「«」：收起列表栏，点当前页面的图标再展开。手机上没有。 */
export function CollapseListButton() {
	const set = usePreferences(state => state.set);
	return <IconButton label="收起列表" className="max-md:hidden" onClick={() => set({ listCollapsed: true })}><ChevronsLeft size={17} /></IconButton>;
}
