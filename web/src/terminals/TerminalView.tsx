import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client.ts';
import { useConnection } from '../api/events.ts';
import { onTerminalOutput } from '../api/system.ts';
import type { ITerminalInfo, ITerminalOutputEvent, ITerminalScreen } from '../api/types.ts';
import { copyText } from '../lib/clipboard.ts';
import { errorMessage } from '../lib/errors.ts';
import { TERMINAL_FONT } from './font.ts';

/** 运行时允许的终端大小。 */
const COLS = [20, 500] as const;
const ROWS = [5, 200] as const;
/** 窗口大小停下来这么久才改大小：拖动窗口时不用每一步都改，一闪而过的大小也不会发给终端。 */
const RESIZE_DELAY_MS = 150;
/**
 * 输出攒一下再画：Windows 上程序打印一行，常常先到文字、约 15 毫秒后才到换行，分开画会看到这一行先出现在最底下、再跳到上一行。
 * 停下来 QUIET_MS 没有新输出时画；一直有输出时最多攒 MAX_HOLD_MS。
 */
const QUIET_MS = 25;
const MAX_HOLD_MS = 50;
/** 打字后这么久里光标动了，就滚过去：命令的回显、按方向键移动光标都在这段时间里。 */
const FOLLOW_MS = 1000;
/** 滚过去时光标离边留几列，看得到光标前后的字。 */
const FOLLOW_MARGIN_COLS = 4;
/**
 * 会让 xterm.js 自动回复的终端查询。运行时的屏幕已经统一回复了（见运行时 terminals.ts 里的 screen.onData），这里拦下，
 * 免得程序收到两份回复、多出来的一份被当成键盘输入。颜色查询不拦：运行时不知道配色，由这里回复。
 */
const QUERIES = [
	{ final: 'c' }, { prefix: '>', final: 'c' }, // 设备属性
	{ final: 'n' }, { prefix: '?', final: 'n' }, // 状态、光标位置
	{ intermediates: '$', final: 'p' }, { prefix: '?', intermediates: '$', final: 'p' }, // 模式
];
// 终端总是深色，和外观设置无关。
const THEME = { background: '#1e1e1e', foreground: '#d4d4d4', cursor: '#d4d4d4', selectionBackground: '#264f78' };

/**
 * 终端画面：先取屏幕快照，再接上事件流里的输出。interactive 时可以输入。你在操作自己建的终端时，画面适应窗口、改终端的尺寸；
 * 其他时候按终端的尺寸显示，不改它（AI 建的终端尺寸固定，见设计文档的终端尺寸），你在操作时打字让光标跑出看得见的范围，就滚过去。
 */
export function TerminalView({ terminal, interactive }: { terminal: ITerminalInfo; interactive: boolean }) {
	const host = useRef<HTMLDivElement>(null);
	const [xterm, setXterm] = useState<{ term: Terminal; fit: FitAddon; resize: (cols: number, rows: number) => void }>();
	const interactiveRef = useRef(interactive);
	interactiveRef.current = interactive;
	const fitWindow = interactive && terminal.createdBy === null;
	const followRef = useRef(false);
	followRef.current = interactive && !fitWindow;
	const connected = useConnection(state => state.connected);
	const [error, setError] = useState<string>();
	const { terminalId } = terminal;

	// 断线期间的输出补不回来，重连后重新取快照。
	useEffect(() => {
		if (!connected || !host.current) return;
		const term = new Terminal({
			scrollback: 5000, fontSize: TERMINAL_FONT.size, fontFamily: TERMINAL_FONT.family, theme: THEME, disableStdin: true,
		});
		const fit = new FitAddon();
		term.loadAddon(fit);
		for (const query of QUERIES) term.parser.registerCsiHandler(query, () => true);
		// 设置查询（DECRQSS）。
		term.parser.registerDcsHandler({ intermediates: '$', final: 'q' }, () => true);
		term.open(host.current);
		let seq: number | undefined;
		const early: ITerminalOutputEvent[] = [];
		let pending = '';
		let holdSince = 0;
		let flushTimer: number | undefined;
		const flush = () => {
			term.write(pending);
			pending = '';
		};
		const write = (event: ITerminalOutputEvent) => {
			if (event.seq <= seq!) return;
			seq = event.seq;
			if (!pending) holdSince = performance.now();
			pending += event.data;
			window.clearTimeout(flushTimer);
			flushTimer = window.setTimeout(flush, Math.max(0, Math.min(QUIET_MS, holdSince + MAX_HOLD_MS - performance.now())));
		};
		// 改大小也排在输出后面：已经收到、还攒着没画的输出是按原来的大小输出的，先画完再改，不然会按新的大小画旧的输出。
		const resize = (cols: number, rows: number) => {
			window.clearTimeout(flushTimer);
			if (pending) flush();
			term.write('', () => {
				const narrower = cols < term.cols;
				term.resize(cols, rows);
				// 和运行时的屏幕一样截掉行尾，见 trimLines。
				if (term.options.windowsPty?.backend && narrower) trimLines(term, cols);
			});
		};
		const stopListening = onTerminalOutput(terminalId, event => seq === undefined ? early.push(event) : write(event));
		let disposed = false;
		api<{ screen: ITerminalScreen }>('GET', `/v1/terminals/${terminalId}/screen`).then(({ screen }) => {
			if (disposed) return;
			// 和运行时的屏幕用同样的 ConPTY 设置，改大小时两边的处理才一致。为什么故意写旧版本，见运行时 terminals.ts 的 WINDOWS_PTY。
			if (screen.windowsPty) {
				term.options.windowsPty = screen.windowsPty;
				disableWrapGuess(term);
			}
			term.resize(screen.cols, screen.rows);
			term.write(screen.data);
			seq = screen.seq;
			early.forEach(write);
			setXterm({ term, fit, resize });
		}, caught => !disposed && setError(errorMessage(caught)));

		const send = inputSender(terminalId, setError);
		// 只在你刚打过字时跟着光标：程序自己输出、重画界面时光标到处跳，跟着滚会让你看不了别处。
		let typedAt = -Infinity;
		const input = term.onData(data => {
			if (!interactiveRef.current) return;
			send(data);
			typedAt = performance.now();
		});
		const cursor = term.onCursorMove(() => {
			if (followRef.current && performance.now() - typedAt < FOLLOW_MS) followCursor(term, host.current);
		});
		term.attachCustomKeyEventHandler(event => {
			if (event.type !== 'keydown' || !event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) return true;
			// 有选中文字时 Ctrl+C 是复制，没有时发给终端。
			if (event.key === 'c' && term.hasSelection()) {
				void copyText(term.getSelection());
				term.clearSelection();
				return false;
			}
			// Ctrl+V 交给浏览器粘贴，xterm 收到粘贴内容后当作输入。
			return event.key !== 'v';
		});
		return () => {
			disposed = true;
			window.clearTimeout(flushTimer);
			stopListening();
			input.dispose();
			cursor.dispose();
			term.dispose();
			setXterm(undefined);
		};
	}, [terminalId, connected]);

	useEffect(() => {
		if (!xterm) return;
		xterm.term.options.disableStdin = !interactive;
		if (!interactive) return;
		xterm.term.focus();
		// 接管后马上要输入，先滚到光标那里；等已经收到的输出画完，光标才在最终的位置。
		if (!fitWindow) xterm.term.write('', () => followCursor(xterm.term, host.current));
	}, [xterm, interactive, fitWindow]);

	// 你在操作自己建的终端时适应窗口并改终端尺寸，否则跟着终端的尺寸。
	const { cols, rows } = terminal;
	useEffect(() => {
		if (!xterm || !host.current) return;
		const { term, fit, resize } = xterm;
		if (!fitWindow) {
			if (term.cols !== cols || term.rows !== rows) resize(cols, rows);
			return;
		}
		// 窗口大小停下来 RESIZE_DELAY_MS 后，画面和终端一起改：
		// - 画面和终端要一起改。只改画面、终端晚一点才改的话，中间程序还按原来的大小输出，画面会乱。
		// - 把浏览器拖到另一块显示器、缩放页面时，窗口大小会一闪而过地变一下又变回来。所以每次先取消计时器，
		//   大小没变就什么都不改，闪过的大小不发给终端，免得程序按它重画一遍。
		// - 终端的大小（cols、rows）来自事件，可能还没更新，所以画面和终端的大小都对上才算没变，有一个对不上就发。
		// 回滚区里堆叠旧画面是另一个原因，不在这里，见运行时 terminals.ts 的 WINDOWS_PTY。
		let timer: number | undefined;
		const apply = () => {
			const proposed = fit.proposeDimensions();
			if (!proposed || !Number.isFinite(proposed.cols) || !Number.isFinite(proposed.rows)) return;
			const next = { cols: clamp(proposed.cols, COLS), rows: clamp(proposed.rows, ROWS) };
			window.clearTimeout(timer);
			if (term.cols === next.cols && term.rows === next.rows && cols === next.cols && rows === next.rows) return;
			timer = window.setTimeout(() => {
				resize(next.cols, next.rows);
				api('POST', `/v1/terminals/${terminalId}/resize`, next).catch(caught => setError(errorMessage(caught)));
			}, RESIZE_DELAY_MS);
		};
		apply();
		const observer = new ResizeObserver(apply);
		observer.observe(host.current);
		return () => {
			observer.disconnect();
			window.clearTimeout(timer);
		};
	}, [xterm, fitWindow, terminalId, cols, rows]);

	return (
		<div className="relative min-h-0 flex-1 bg-[#1e1e1e]">
			{/*
			  适应窗口时画面正好放下；其他时候按终端的尺寸，放不下就滚动。这一层铺满，滚动条贴着边；留白放在 xterm 自己的元素上，
			  适应窗口时会扣掉。右边不留：xterm 自己的滚动条在那里，留了它就离边一截。滚动条的样式见 index.css 的 terminal-scroll。
			  xterm 的 viewport 连留白一起盖住，它的样式表把它涂成黑色、带一条浏览器自带的滚动条（平时被 xterm 自己的滚动条盖着，
			  有了留白就露出一截），所以改成透明、去掉这条滚动条。
			*/}
			<div
				ref={host}
				className={clsx(
					'terminal-scroll absolute inset-0 [&>.xterm]:py-2 [&>.xterm]:pl-2 [&_.xterm-viewport]:bg-transparent! [&_.xterm-viewport]:[scrollbar-width:none]',
					// 不适应窗口时 xterm 的元素按内容的宽度排，它自己的滚动条才紧跟在最后一列后面，不停在画面中间；
					// 滚动条要的 14px（适应窗口时 FitAddon 也留了这么多）放在内容右边。
					fitWindow ? 'overflow-hidden' : 'overflow-auto [&>.xterm]:w-max [&_.xterm-scrollable-element]:pr-3.5',
				)}
			/>
			{error && <div className="absolute bottom-2 right-2 rounded-md bg-danger px-2 py-1 text-xs text-white">{error}</div>}
		</div>
	);
}

/** 光标在 container 里看不见时，滚动 container 让它露出来。 */
function followCursor(term: Terminal, container: HTMLElement | null): void {
	const screen = term.element?.querySelector('.xterm-screen');
	if (!container || !screen) return;
	const box = screen.getBoundingClientRect();
	const view = container.getBoundingClientRect();
	const width = box.width / term.cols;
	const height = box.height / term.rows;
	const buffer = term.buffer.active;
	// 光标在 container 内容里的位置；xterm 自己的回滚区往上翻过时，光标所在的行跟着往下。
	const left = box.left - view.left + container.scrollLeft + buffer.cursorX * width;
	const top = box.top - view.top + container.scrollTop + (buffer.baseY + buffer.cursorY - buffer.viewportY) * height;
	const margin = FOLLOW_MARGIN_COLS * width;
	if (left - margin < container.scrollLeft) container.scrollLeft = left - margin;
	else if (left + width + margin > container.scrollLeft + container.clientWidth) container.scrollLeft = left + width + margin - container.clientWidth;
	if (top < container.scrollTop) container.scrollTop = top;
	else if (top + height > container.scrollTop + container.clientHeight) container.scrollTop = top + height - container.clientHeight;
}

/** 按顺序发送输入：上一次还没发完时，新的输入攒着一起发。 */
function inputSender(terminalId: string, onError: (message: string) => void): (data: string) => void {
	let buffer = '';
	let sending = false;
	const flush = async () => {
		if (sending || !buffer) return;
		sending = true;
		const data = buffer;
		buffer = '';
		try {
			await api('POST', `/v1/terminals/${terminalId}/input`, { data });
		} catch (caught) {
			onError(errorMessage(caught));
		} finally {
			sending = false;
			void flush();
		}
	};
	return data => {
		buffer += data;
		void flush();
	};
}

/** xterm.js 内部的终端，下面两处用到的部分。 */
interface ITerminalCore {
	readonly buffers: { readonly normal: ITerminalBuffer; readonly alt: ITerminalBuffer };
	readonly _windowsWrappingHeuristics: { clear(): void };
}

interface ITerminalBuffer {
	readonly lines: { readonly length: number; get(index: number): { resize(cols: number, fill: unknown): unknown } | undefined };
	getNullCell(): unknown;
}

function terminalCore(term: Terminal): ITerminalCore {
	return (term as unknown as { _core: ITerminalCore })._core;
}

/**
 * 关掉 xterm.js 不重排时自带的折行猜测，和运行时的屏幕一致（原因见运行时 terminals.ts 的 disableWrapGuess）。
 * 不关的话，选中复制时 Claude Code 的分隔线会和下一行连成一行。xterm.js 没有公开开关，用的是内部的字段。
 */
function disableWrapGuess(term: Terminal): void {
	terminalCore(term)._windowsWrappingHeuristics.clear();
}

/**
 * 变窄时把每一行截到 cols 列，和运行时的屏幕一致（原因见运行时 terminals.ts 的 trimLines）。xterm.js 不重排时不截，
 * 程序重画只清到新的列数，看不到的地方留着旧内容，再变宽时又露出来。xterm.js 没有公开截断的接口，用的是内部的缓冲区。
 */
function trimLines(term: Terminal, cols: number): void {
	const { normal, alt } = terminalCore(term).buffers;
	for (const buffer of [normal, alt]) {
		for (let index = 0; index < buffer.lines.length; index++) buffer.lines.get(index)?.resize(cols, buffer.getNullCell());
	}
}

function clamp(value: number, [min, max]: readonly [number, number]): number {
	return Math.max(min, Math.min(max, Math.floor(value)));
}
