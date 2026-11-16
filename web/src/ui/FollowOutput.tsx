import { ArrowDown } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import { CodeScroll } from './CopyButton.tsx';

/**
 * 等宽字的输出，最高约大半屏（className 可以换掉高度），再多在里面滚动；右上角复制。live 时跟着新输出滚到最新一行，
 * 往上翻了就停住，显示「回到底部」。
 */
export function FollowOutput({ text, live, className }: { text: string; live: boolean; className?: string }) {
	const box = useRef<HTMLDivElement>(null);
	const [stuck, setStuck] = useState(true);
	useLayoutEffect(() => {
		const element = box.current;
		if (live && stuck && element) element.scrollTop = element.scrollHeight;
	}, [text, live, stuck]);
	const onScroll = () => {
		const element = box.current;
		if (element) setStuck(element.scrollHeight - element.scrollTop - element.clientHeight < 4);
	};
	return (
		<div className="relative">
			<CodeScroll ref={box} onScroll={onScroll} text={text} className={className ?? 'max-h-[60vh]'} />
			{live && !stuck && (
				<button
					type="button"
					onClick={() => setStuck(true)}
					className="absolute bottom-2 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-line bg-raised px-2 py-0.5 text-xs text-fg-2 shadow-sm hover:text-fg"
				>
					<ArrowDown size={12} />回到底部
				</button>
			)}
		</div>
	);
}
