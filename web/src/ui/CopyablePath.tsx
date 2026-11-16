import clsx from 'clsx';
import { Check, Copy } from 'lucide-react';
import { useCopy } from '../lib/clipboard.ts';
import { IconButton } from './Button.tsx';

/** 只读的路径，带复制按钮。wrap 时长路径换行显示全，否则截断、悬停看全。 */
export function CopyablePath({ path, wrap = false }: { path: string; wrap?: boolean }) {
	const { state, copy } = useCopy();
	return (
		<div className={clsx('flex min-w-0 gap-1', wrap ? 'items-start' : 'items-center')}>
			{/* 窄的时候（手机）没有悬停可看：路长就折成两行、末尾省略，别只给一行省略号。 */}
			<span className={clsx('font-mono text-xs text-fg-3', wrap ? 'min-w-0 break-all pt-1' : 'min-w-0 truncate max-[26rem]:line-clamp-2 max-[26rem]:break-all max-[26rem]:whitespace-normal')} title={path}>{path}</span>
			<IconButton label={state === 'copied' ? '已复制' : state === 'failed' ? '复制失败' : '复制路径'} onClick={() => copy(path)} className="size-6 shrink-0">
				{state === 'copied' ? <Check size={13} /> : <Copy size={13} />}
			</IconButton>
		</div>
	);
}
