import clsx from 'clsx';
import { useCopy } from '../lib/clipboard.ts';
import { memberReference } from './CopyMenuItems.tsx';

/**
 * 成员设置顶部的名字和 ID：名字带虚线下划线，点击复制名字和 ID（沈安(M_xxx)）；ID 灰色等宽小字写在后面，点击只复制 ID。
 * 复制后在原处短暂写「已复制」。名字太长时先截断名字。
 */
export function MemberName({ member, className }: { member: { readonly name: string; readonly memberId: string }; className?: string }) {
	const name = useCopy();
	const id = useCopy();
	return (
		<>
			<h1 className={clsx('min-w-0 truncate text-xl font-semibold', className)}>
				<button
					type="button"
					title="点击复制名字和 ID"
					onClick={() => name.copy(memberReference(member))}
					className="cursor-pointer underline decoration-fg-3 decoration-dotted decoration-1 underline-offset-4 hover:decoration-fg-2"
				>
					{member.name}
				</button>
			</h1>
			{name.state !== 'idle' && <Feedback state={name.state} />}
			<button type="button" title="点击复制 ID" onClick={() => id.copy(member.memberId)} className="shrink-0 cursor-pointer font-mono text-xs text-fg-3 hover:text-fg-2">
				{id.state === 'idle' ? member.memberId : <Feedback state={id.state} />}
			</button>
		</>
	);
}

function Feedback({ state }: { state: 'copied' | 'failed' }) {
	return <span className={clsx('shrink-0 font-sans text-xs', state === 'copied' ? 'text-accent' : 'text-danger')}>{state === 'copied' ? '已复制' : '复制失败'}</span>;
}
