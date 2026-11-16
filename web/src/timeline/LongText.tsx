import clsx from 'clsx';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/** 收起时显示的高度。 */
const CLAMPED_HEIGHT = 240;
/** 超过这个高度才收起，免得展开只多出一两行。 */
const LONG_HEIGHT = 320;

/** 长正文的折叠：标题行用它放箭头，点标题收起、展开。 */
export interface IFold {
	readonly expanded: boolean;
	readonly toggle: () => void;
}

/**
 * 时间线里的长正文：超过一定高度时收起，只显示开头，底部渐隐，下面「展开全文」；展开后可以再收起。
 * defaultExpanded 时一开始全部显示，长的底部有「收起」。展开状态只在当前页面有效。
 * heading 是放在正文上面的标题行，长的才给它 fold，标题行和底部的按钮管同一个状态；bodyClassName 加在正文上。
 */
export function LongText({ children, defaultExpanded = false, heading, bodyClassName }: {
	children: ReactNode;
	defaultExpanded?: boolean;
	heading?: (fold: IFold | undefined) => ReactNode;
	bodyClassName?: string;
}) {
	const root = useRef<HTMLDivElement>(null);
	const inner = useRef<HTMLDivElement>(null);
	const [long, setLong] = useState(false);
	const [expanded, setExpanded] = useState(defaultExpanded);

	// 按内容本身的高度判断，面板变宽变窄时重新算。
	useLayoutEffect(() => {
		const element = inner.current;
		if (!element) return;
		const measure = () => setLong(element.offsetHeight > LONG_HEIGHT);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);

	const clamped = long && !expanded;
	const toggle = () => {
		setExpanded(!expanded);
		// 从长内容的底部收起时，这一条可能已经整个跑到上面去了，滚回来。
		if (expanded) requestAnimationFrame(() => root.current?.scrollIntoView({ block: 'nearest' }));
	};

	return (
		<div ref={root}>
			{heading?.(long ? { expanded, toggle: () => setExpanded(value => !value) } : undefined)}
			<div className={bodyClassName}>
				<div className={clsx(clamped && 'relative overflow-hidden')} style={clamped ? { maxHeight: CLAMPED_HEIGHT } : undefined}>
					<div ref={inner}>{children}</div>
					{clamped && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-linear-to-b from-transparent to-page" />}
				</div>
				{long && (
					<button
						type="button"
						aria-expanded={expanded}
						onClick={toggle}
						className="mt-1 flex w-fit items-center gap-1 rounded text-[13px] text-accent hover:text-accent-hover"
					>
						{expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
						{expanded ? '收起' : '展开全文'}
					</button>
				)}
			</div>
		</div>
	);
}
