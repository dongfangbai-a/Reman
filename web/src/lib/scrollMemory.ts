/** 列表里看到的位置：视口顶部那一项，和它的上边离视口顶部的距离。 */
export interface IScrollPosition {
	readonly id: string;
	readonly offset: number;
}

/** 列表项在 JSX 里直接写 data-scroll-id={id} 标出自己（MessageList、TimelineView），值是位置里的 id。 */
const SCROLL_ID_ATTRIBUTE = 'data-scroll-id';

/** 只记在内存里：刷新页面后回到最新。 */
const positions = new Map<string, IScrollPosition>();

export function recallScroll(key: string): IScrollPosition | undefined {
	return positions.get(key);
}

export function forgetScroll(key: string): void {
	positions.delete(key);
}

/** 记下视口顶部那一项。列表项按从上到下排列，二分找第一个下边在视口顶部以下的。 */
export function rememberScroll(key: string, scroller: HTMLElement): void {
	const items = scroller.querySelectorAll<HTMLElement>(`[${SCROLL_ID_ATTRIBUTE}]`);
	if (items.length === 0) return;
	const top = scroller.getBoundingClientRect().top;
	let low = 0;
	let high = items.length - 1;
	while (low < high) {
		const middle = (low + high) >> 1;
		if (items[middle]!.getBoundingClientRect().bottom > top) high = middle;
		else low = middle + 1;
	}
	const item = items[low]!;
	positions.set(key, { id: item.getAttribute(SCROLL_ID_ATTRIBUTE)!, offset: item.getBoundingClientRect().top - top });
}

/** 滚到记下的位置；那一项不在列表里时返回 false。 */
export function restoreScroll(scroller: HTMLElement, position: IScrollPosition): boolean {
	const item = scroller.querySelector(`[${SCROLL_ID_ATTRIBUTE}="${CSS.escape(position.id)}"]`);
	if (!item) return false;
	scroller.scrollTop += item.getBoundingClientRect().top - scroller.getBoundingClientRect().top - position.offset;
	return true;
}
