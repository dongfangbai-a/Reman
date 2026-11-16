import clsx from 'clsx';
import { ChevronRight } from 'lucide-react';
import { useState } from 'react';

type Meta = Readonly<Record<string, string>>;

/** 真人成员代发的外部事件：名字后面的灰色小标签。 */
export function ExternalTag({ source, className }: { source: string; className?: string }) {
	return <span className={clsx('tag', className)}>外部事件 · {source}</span>;
}

/** 事件的 meta：每项一行，等宽字。 */
export function MetaList({ meta }: { meta: Meta }) {
	return (
		<pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-code px-2 py-1.5 font-mono text-xs">
			{Object.entries(meta).map(([key, value]) => `${key}: ${value}`).join('\n')}
		</pre>
	);
}

/** 「详情」，点开看事件的 meta。没有 meta 时不显示。 */
export function MetaDetails({ meta, className }: { meta: Meta; className?: string }) {
	const [open, setOpen] = useState(false);
	if (Object.keys(meta).length === 0) return null;
	return (
		<div className={clsx('text-[13px]', className)}>
			<button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)} className="flex items-center gap-1 text-xs text-fg-3 hover:text-fg-2">
				<ChevronRight size={13} className={clsx('transition-transform', open && 'rotate-90')} />详情
			</button>
			{open && <div className="mt-1 pl-4 text-left"><MetaList meta={meta} /></div>}
		</div>
	);
}
