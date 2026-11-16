import clsx from 'clsx';
import { useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import { type IYielding, resizeWithin } from './panes.ts';

/** 方向键每次调整的宽度。 */
const KEY_STEP = 16;

interface IDrag {
	readonly startX: number;
	readonly startWidth: number;
	width: number;
	/** 让出宽度的那一栏现在的宽度。 */
	yielded: number;
	collapsed: boolean;
}

/** 拖宽时让出宽度的那一栏：分隔线移过去那一边的栏，现在只有拉宽概况栏时的工作台。 */
export interface IYieldingPane extends IYielding {
	readonly pane: RefObject<HTMLElement | null>;
}

/**
 * 两栏之间的分隔线，拖动调整一栏的宽度。放在两栏之间，自己不占宽度。
 * 拖动时直接改 pane 的样式，页面不跟着反复渲染；松手后用 onResize 记下宽度。双击恢复默认宽度，方向键微调。
 * grow 是往哪边拖面板变宽：列表栏往右，功能区往左。
 * 给了 onCollapse 时可以收起：拖到最窄后再往里拖超过最窄宽度的一半，面板就藏起来（手拖不精准，太近容易误收起），同一次拖动往回拖又会出来，松手时还藏着就收起。
 * room 是这一栏和 yielding 加起来最多能占的宽度：空着的用完后挤 yielding，挤到它的最窄为止（见 resizeWithin）；拖动时一起改它的样式，
 * 松手后 onResize 的第二个参数是它的新宽度，没变时不给。方向键、双击也一样。
 */
export function ResizeHandle({ pane, width, min, max, room = Infinity, yielding, defaultWidth, grow, label, onResize, onCollapse }: {
	pane: RefObject<HTMLElement | null>;
	width: number;
	min: number;
	/** 这一栏自己的最宽。 */
	max: number;
	room?: number;
	yielding?: IYieldingPane;
	defaultWidth: number;
	grow: 'left' | 'right';
	label: string;
	onResize: (width: number, yielded?: number) => void;
	onCollapse?: () => void;
}) {
	const [state, setState] = useState<'idle' | 'dragging' | 'collapsing'>('idle');
	const drag = useRef<IDrag | undefined>(undefined);
	const direction = grow === 'right' ? 1 : -1;
	const fit = (wanted: number) => resizeWithin(wanted, { min, max }, room, yielding ?? { width: 0, min: 0 });
	const resize = (wanted: number) => {
		const [next, yielded] = fit(wanted);
		if (yielding && yielded !== yielding.width) onResize(next, yielded);
		else if (next !== width) onResize(next);
	};

	const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
		if (event.button !== 0) return;
		event.preventDefault();
		event.currentTarget.setPointerCapture(event.pointerId);
		drag.current = { startX: event.clientX, startWidth: width, width, yielded: yielding?.width ?? 0, collapsed: false };
		document.body.classList.add('resizing');
		setState('dragging');
	};

	const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
		const current = drag.current;
		const element = pane.current;
		if (!current || !element) return;
		const wanted = current.startWidth + direction * (event.clientX - current.startX);
		current.collapsed = !!onCollapse && wanted < min / 2;
		[current.width, current.yielded] = fit(wanted);
		element.style.display = current.collapsed ? 'none' : '';
		element.style.width = `${current.width}px`;
		const other = yielding?.pane.current;
		if (other) other.style.width = `${current.yielded}px`;
		setState(onCollapse && wanted < min ? 'collapsing' : 'dragging');
	};

	const onPointerEnd = () => {
		const current = drag.current;
		if (!current) return;
		drag.current = undefined;
		document.body.classList.remove('resizing');
		setState('idle');
		const element = pane.current;
		if (current.collapsed && onCollapse) {
			if (element) {
				element.style.display = '';
				element.style.width = `${width}px`;
			}
			// 收起时这一栏在最窄以下，另一栏没被挤，宽度本来就没变。
			onCollapse();
		} else if (yielding && current.yielded !== yielding.width) {
			onResize(current.width, current.yielded);
		} else if (current.width !== current.startWidth) {
			onResize(current.width);
		}
	};

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
		event.preventDefault();
		const step = (event.key === 'ArrowRight' ? 1 : -1) * direction * KEY_STEP;
		resize(width + step);
	};

	return (
		<div className="relative z-20 w-0 shrink-0">
			<div
				role="separator"
				aria-orientation="vertical"
				aria-label={label}
				aria-valuenow={width}
				aria-valuemin={min}
				aria-valuemax={Math.min(max, room - (yielding?.min ?? 0))}
				tabIndex={0}
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={onPointerEnd}
				onPointerCancel={onPointerEnd}
				onLostPointerCapture={onPointerEnd}
				onDoubleClick={() => resize(defaultWidth)}
				onKeyDown={onKeyDown}
				className="group/resize absolute inset-y-0 -left-1 w-2 cursor-col-resize touch-none outline-none"
			>
				<div
					className={clsx(
						'absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 transition-colors',
						state === 'collapsing' ? 'bg-warning' : state === 'dragging' ? 'bg-accent' : 'delay-150 group-hover/resize:bg-accent group-focus-visible/resize:bg-accent',
					)}
				/>
			</div>
		</div>
	);
}
