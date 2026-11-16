import { ChevronLeft } from 'lucide-react';
import { Link } from 'react-router';

/** 手机上内容页回到列表：页面顶部一行。 */
export function BackLink({ to, label }: { to: string; label: string }) {
	return (
		<Link to={to} className="-ml-1 mb-3 flex w-fit items-center text-[13px] text-fg-2 hover:text-fg md:hidden">
			<ChevronLeft size={18} />{label}
		</Link>
	);
}

/** 手机上内容页回到列表：放在顶栏最左边的按钮。 */
export function BackButton({ to }: { to: string }) {
	return (
		<Link to={to} aria-label="返回" title="返回" className="-ml-2 flex size-8 shrink-0 items-center justify-center rounded-md text-fg-2 hover:bg-hover hover:text-fg md:hidden">
			<ChevronLeft size={20} />
		</Link>
	);
}
