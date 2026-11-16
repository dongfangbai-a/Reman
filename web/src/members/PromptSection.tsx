import * as RadixDialog from '@radix-ui/react-dialog';
import clsx from 'clsx';
import { Maximize2, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useCopy } from '../lib/clipboard.ts';
import { Button, IconButton } from '../ui/Button.tsx';

const PLACEHOLDER = '可选，长期稳定的内容';

/**
 * 页面里的提示词：高度固定，两栏时撑满左栏剩下的空间，内容多时在框里滚动，不把页面撑长。
 * 长内容在「展开」打开的大窗口里读和改。path 是 prompt.md 的路径，新建时没有。
 * 技能的正文也用它：label、placeholder、title（大窗口的标题）和 className（框的高度）可以换。
 * 记忆也用它：heading 换掉标题（提示词和记忆两个标签），aside 放在展开按钮前面，footer 放在框的底部，missingNote 是文件不存在时的说明。
 * hint 是有改动时的一行灰字提醒，在大窗口底部；没有 footer 时也在框的底部。
 */
export function PromptSection({
	value, onChange, path, memberName, label = '提示词', placeholder = PLACEHOLDER, title, className = 'h-72 lg:h-auto lg:min-h-48 lg:flex-1',
	heading, aside, footer, hint, missingNote = '未填写提示词时该文件不存在',
}: {
	value: string;
	onChange: (value: string) => void;
	path?: string;
	memberName?: string;
	label?: string;
	placeholder?: string;
	title?: string;
	className?: string;
	heading?: ReactNode;
	aside?: ReactNode;
	footer?: ReactNode;
	hint?: string;
	missingNote?: string;
}) {
	const bottom = footer ?? (hint && <div className="shrink-0 rounded-b-xl border-t border-line px-4 py-2 text-xs text-fg-3">{hint}</div>);
	const [expanded, setExpanded] = useState(false);
	return (
		<section className={clsx('flex flex-col rounded-xl border border-line bg-raised focus-within:border-accent', className)}>
			<div className="flex h-10 shrink-0 items-center gap-3 border-b border-line pl-4 pr-1.5">
				{heading ?? <span className="shrink-0 text-[13px] font-medium">{label}</span>}
				{path && <CopyPath path={path} exists={value.trim().length > 0} missingNote={missingNote} className="flex-1" />}
				<div className="ml-auto flex shrink-0 items-center gap-2">
					{aside}
					<IconButton label="展开编辑" onClick={() => setExpanded(true)}><Maximize2 size={15} /></IconButton>
				</div>
			</div>
			<textarea
				aria-label={label}
				value={value}
				onChange={event => onChange(event.target.value)}
				placeholder={placeholder}
				className={clsx('block min-h-0 w-full flex-1 resize-none overflow-y-auto bg-transparent px-4 py-3 text-[13px] leading-relaxed outline-none', !bottom && 'rounded-b-xl')}
			/>
			{bottom}
			{expanded && (
				<PromptDialog
					value={value}
					onChange={onChange}
					path={path}
					missingNote={missingNote}
					title={title ?? (memberName ? `${memberName} 的${label}` : label)}
					label={label}
					placeholder={placeholder}
					hint={hint}
					onClose={() => setExpanded(false)}
				/>
			)}
		</section>
	);
}

/**
 * 读和改长提示词的大窗口：电脑上居中、宽约 900px，手机上铺满屏幕。编辑的是页面上同一份内容。
 * 不放「保存」，免得把页面上其他没打算保存的修改一起存掉；关闭的各种方式都不丢改动。
 */
function PromptDialog({ value, onChange, path, missingNote, title, label, placeholder, hint, onClose }: {
	value: string;
	onChange: (value: string) => void;
	path?: string;
	missingNote: string;
	title: string;
	label: string;
	placeholder: string;
	hint?: string;
	onClose: () => void;
}) {
	return (
		<RadixDialog.Root open onOpenChange={open => !open && onClose()}>
			<RadixDialog.Portal>
				<RadixDialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
				<RadixDialog.Content
					aria-describedby={undefined}
					className="fixed inset-0 z-50 flex flex-col bg-raised outline-none md:inset-auto md:left-1/2 md:top-1/2 md:h-[85vh] md:w-[min(900px,calc(100vw-4rem))] md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-xl md:border md:border-line md:shadow-xl"
				>
					<div className="flex shrink-0 items-start gap-3 border-b border-line py-3 pl-5 pr-3">
						<div className="min-w-0 flex-1">
							<RadixDialog.Title className="font-semibold">{title}</RadixDialog.Title>
							{path && <CopyPath path={path} exists={value.trim().length > 0} missingNote={missingNote} className="mt-0.5" />}
						</div>
						<RadixDialog.Close asChild><IconButton label="关闭"><X size={16} /></IconButton></RadixDialog.Close>
					</div>
					<textarea
						autoFocus
						aria-label={label}
						value={value}
						onChange={event => onChange(event.target.value)}
						placeholder={placeholder}
						className="block min-h-0 w-full flex-1 resize-none overflow-y-auto bg-transparent px-5 py-4 text-sm leading-7 outline-none"
					/>
					<div className="flex shrink-0 items-center gap-3 border-t border-line px-5 py-3">
						<span className="min-w-0 flex-1 text-xs text-fg-3">关闭后请在页面中保存{hint && `，${hint}`}</span>
						<RadixDialog.Close asChild><Button variant="primary">完成</Button></RadixDialog.Close>
					</div>
				</RadixDialog.Content>
			</RadixDialog.Portal>
		</RadixDialog.Root>
	);
}

/** 文件路径：灰色小字，点击复制；放不下时截掉前面，保留结尾的文件名。 */
function CopyPath({ path, exists, missingNote, className }: { path: string; exists: boolean; missingNote: string; className?: string }) {
	const { state, copy } = useCopy();
	return (
		<button
			type="button"
			title={exists ? `${path}\n点击复制路径` : `${path}\n${missingNote}；点击复制路径`}
			onClick={() => copy(path)}
			className={clsx('flex min-w-0 max-w-full items-center text-left font-mono text-xs text-fg-3 hover:text-fg-2', className)}
		>
			{state !== 'idle'
				? <span className={clsx('font-sans', state === 'copied' ? 'text-accent' : 'text-danger')}>{state === 'copied' ? '已复制' : '复制失败'}</span>
				: <span className="min-w-0 truncate [direction:rtl]"><bdi>{path}</bdi></span>}
		</button>
	);
}

