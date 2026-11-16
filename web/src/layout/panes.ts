import { useSyncExternalStore } from 'react';

/** 三个页面：成员页、视角页、设置页。 */
export type Page = 'members' | 'perspective' | 'settings';

export function pageOf(pathname: string): Page {
	if (pathname === '/as' || pathname.startsWith('/as/')) return 'perspective';
	if (pathname.startsWith('/settings')) return 'settings';
	return 'members';
}

/** 图标栏的宽度，固定。 */
export const ICON_BAR_WIDTH = 56;
/** 列表栏到 320 为止：里面是一行行的成员和对话，再宽也不多显示内容。 */
export const LIST_WIDTH = { default: 288, min: 220, max: 320 } as const;
/** 中间最窄的宽度：输入框、顶部一行和气泡都还能正常显示。 */
export const CENTER_MIN_WIDTH = 440;
/**
 * 功能区宽的那一栏：终端，视角页里也放时间线。默认宽度正好放下 AI 建的终端，见 terminals/font.ts。
 * 不设固定上限，只受中间的最窄宽度限制：固定上限在大窗口里会先于中间的最窄宽度起作用，不同屏幕上中间能拖到的最窄宽度就不一样。
 */
export const WIDE_WIDTH = { min: 360 } as const;
export const OVERVIEW_WIDTH = { default: 320, min: 280, max: 480 } as const;
/** 功能区盖在中间上时最多占窗口的比例。 */
export const OVERLAY_RATIO = 0.9;

export interface IPaneLayout {
	/** 各栏实际的宽度；没打开的是 0。 */
	readonly list: number;
	readonly wide: number;
	readonly overview: number;
	/** 功能区占栏；放不下中间的最窄宽度时从右边滑出、盖在中间上。 */
	readonly docked: boolean;
}

/** 拖出来的宽度；没打开的栏给 0。 */
export interface IPaneWidths {
	readonly list: number;
	readonly wide: number;
	readonly overview: number;
}

/**
 * 按窗口宽度算各栏实际的宽度：先用拖出来的宽度；放不下中间的最窄宽度时，依次把概况栏、宽的那一栏、列表栏挤到最窄，
 * 还放不下时功能区改成盖在中间上（用拖的宽度，加起来最多占窗口的 90%）。centerMin 是中间要留的宽度，终端最大化时中间隐藏，留终端的最窄宽度。
 */
export function fitPanes(windowWidth: number, wanted: IPaneWidths, centerMin = CENTER_MIN_WIDTH): IPaneLayout {
	const room = windowWidth - ICON_BAR_WIDTH;
	const list = wanted.list > 0 ? clamp(wanted.list, LIST_WIDTH.min, LIST_WIDTH.max) : 0;
	const wide = wanted.wide > 0 ? Math.max(wanted.wide, WIDE_WIDTH.min) : 0;
	const overview = wanted.overview > 0 ? clamp(wanted.overview, OVERVIEW_WIDTH.min, OVERVIEW_WIDTH.max) : 0;
	const docked = squeeze([[overview, OVERVIEW_WIDTH.min], [wide, WIDE_WIDTH.min], [list, LIST_WIDTH.min]], room - centerMin);
	if (docked) return { list: docked[2]!, wide: docked[1]!, overview: docked[0]!, docked: true };
	// 功能区盖在中间上：列表栏按没有功能区算，功能区加起来最多占窗口的 90%，先挤概况栏。
	const [fittedList] = squeeze([[list, LIST_WIDTH.min]], room - centerMin) ?? [list > 0 ? LIST_WIDTH.min : 0];
	const overlay = Math.floor(windowWidth * OVERLAY_RATIO);
	const fitted = squeeze([[overview, OVERVIEW_WIDTH.min], [wide, WIDE_WIDTH.min]], overlay);
	if (fitted) return { list: fittedList!, wide: fitted[1]!, overview: fitted[0]!, docked: false };
	// 都挤到最窄也超过：宽的那一栏留最窄，概况栏用剩下的。
	const narrowWide = wide > 0 ? Math.min(WIDE_WIDTH.min, overlay) : 0;
	return { list: fittedList!, wide: narrowWide, overview: overview > 0 ? Math.max(0, Math.min(OVERVIEW_WIDTH.min, overlay - narrowWide)) : 0, docked: false };
}

/** 依次把各栏挤到最窄，直到加起来不超过 room；挤到最窄也放不下时返回 undefined。宽度是 0 的栏不动。 */
function squeeze(panes: readonly (readonly [number, number])[], room: number): number[] | undefined {
	const widths = panes.map(([width]) => width);
	let excess = widths.reduce((sum, width) => sum + width, 0) - room;
	for (let index = 0; index < panes.length && excess > 0; index++) {
		const [width, min] = panes[index]!;
		if (width === 0) continue;
		const cut = Math.min(excess, width - min);
		widths[index] = width - cut;
		excess -= cut;
	}
	return excess > 0 ? undefined : widths;
}

/** 拖宽时让出宽度的那一栏；没有时宽度和最窄都是 0。 */
export interface IYielding {
	readonly width: number;
	readonly min: number;
}

/**
 * 拖动一栏想要 wanted 宽时，这一栏和让出宽度的那一栏各是多宽。room 是两栏加起来最多能占的宽度
 * （占栏时是中间留够最窄宽度后剩下的，盖在中间上时是窗口的 90%）：先用 room 里空着的，不够时挤另一栏，挤到它的最窄为止。
 * yielding.width 是拖动开始时另一栏的宽度，往回拖时它跟着回来，但不会比开始时更宽。
 */
export function resizeWithin(wanted: number, own: { readonly min: number; readonly max: number }, room: number, yielding: IYielding): [number, number] {
	const width = clamp(Math.round(wanted), own.min, Math.min(own.max, room - yielding.min));
	if (yielding.width === 0) return [width, 0];
	return [width, Math.max(yielding.min, Math.min(yielding.width, room - width))];
}

export function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), Math.max(min, max));
}

export function useWindowWidth(): number {
	return useSyncExternalStore(
		onChange => {
			window.addEventListener('resize', onChange);
			return () => window.removeEventListener('resize', onChange);
		},
		() => window.innerWidth,
	);
}
