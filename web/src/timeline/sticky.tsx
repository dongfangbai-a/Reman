import { createContext, useContext, useRef, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { flushSync } from 'react-dom';

/** 一行标题的高度：text-xs 的一行加上下 2px。 */
const ROW_HEIGHT = '1.25rem';

/** 外面有几层停在顶部的标题。 */
const Depth = createContext(0);

/** 里面的标题停在外面这一层下面。active 为 false 时外面这一层没有停在顶部，不占位置。 */
export function StickyLevel({ active = true, children }: { active?: boolean; children: ReactNode }) {
	const depth = useContext(Depth);
	return <Depth.Provider value={active ? depth + 1 : depth}>{children}</Depth.Provider>;
}

/**
 * 过程行和其中一步的标题：展开时停在时间线顶部，滚到长内容中间也能点它收起；外层的在上面，一层一行。
 * 从停在顶部的位置收起时，这一项停在原处，接着看它后面的内容：不然内容收起后它在很上面，看到的是后面很远的地方。
 */
export function useStickyHeader<T extends HTMLElement>(open: boolean, onToggle: (() => void) | undefined): {
	ref: RefObject<T | null>;
	toggle: (() => void) | undefined;
	className: string | undefined;
	style: CSSProperties | undefined;
} {
	const depth = useContext(Depth);
	const ref = useRef<T>(null);
	const toggle = onToggle && (() => {
		const element = ref.current;
		if (!open || !element) return onToggle();
		const before = element.getBoundingClientRect().top;
		flushSync(onToggle);
		const scroller = element.closest('[data-timeline-scroller]');
		if (scroller) scroller.scrollTop += element.getBoundingClientRect().top - before;
	});
	return {
		ref,
		toggle,
		className: open ? 'sticky bg-page' : undefined,
		// 外层的盖在里层的上面：一项滚到末尾、标题被推上去时，从外层标题下面滑出去，不会盖住外层标题闪一下。
		style: open ? { top: `calc(${depth} * ${ROW_HEIGHT})`, zIndex: 20 - depth } : undefined,
	};
}
