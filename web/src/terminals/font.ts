import { WIDE_WIDTH } from '../layout/panes.ts';

/** 网页终端的字体。工作台的默认宽度也按它算。 */
export const TERMINAL_FONT = { size: 13, family: 'ui-monospace, "Cascadia Mono", Consolas, "SF Mono", monospace' } as const;

/** AI 成员建的终端的列数（运行时的 DEFAULT_COLS），工作台默认正好放下。 */
const AI_TERMINAL_COLS = 100;
/** 终端左边的留白、xterm 自己的滚动条（FitAddon 也按 14 算），再多留一点：xterm 量出的字宽按屏幕像素取整，可能和这里差一点。 */
const EXTRA_PX = 8 + 14 + 4;

let measured: number | undefined;

/** 工作台的默认宽度：按实际用到的字体量字宽，不同机器上字体不一样，宽度也不一样。量一次就记下。 */
export function defaultTerminalPanelWidth(): number {
	measured ??= measure();
	return measured;
}

function measure(): number {
	const context = document.createElement('canvas').getContext('2d');
	let cell = TERMINAL_FONT.size * 0.6;
	if (context) {
		context.font = `${TERMINAL_FONT.size}px ${TERMINAL_FONT.family}`;
		cell = context.measureText('W'.repeat(AI_TERMINAL_COLS)).width / AI_TERMINAL_COLS;
	}
	return Math.max(WIDE_WIDTH.min, Math.ceil(cell * AI_TERMINAL_COLS + EXTRA_PX));
}
