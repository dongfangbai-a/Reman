import type { MouseEvent } from 'react';

/**
 * 这次点击是不是拖着选文字松开的：用鼠标点、又选中了文字，就是在选文字，不当成点了这一行。
 * 键盘触发的点击（detail 是 0）总是算点击。
 */
export function isSelectingText(event: MouseEvent): boolean {
	return event.detail > 0 && !window.getSelection()?.isCollapsed;
}
