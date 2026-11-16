import clsx from 'clsx';
import { CircleAlert, FileText, Paperclip, SendHorizontal, X } from 'lucide-react';
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type DragEvent, type KeyboardEvent, type Ref } from 'react';
import type { IMember } from '../api/types.ts';
import { errorMessage } from '../lib/errors.ts';
import { formatSize } from '../lib/format.ts';
import { usePreferences } from '../stores.ts';
import { Avatar } from '../ui/Avatar.tsx';
import { IconButton } from '../ui/Button.tsx';
import { AiTag, MemberNote } from '../ui/MemberNote.tsx';
import { checkFile, draftAttachment, uploadAttachment, type IDraftAttachment } from './attachments.ts';
import { FileName, ImageViewer } from './MessageItem.tsx';

/** 发出去的内容。附件都是已经上传完成的。 */
export interface IOutgoing {
	readonly text: string;
	readonly mentions: readonly string[] | 'all';
	readonly attachments: readonly IDraftAttachment[];
}

export interface IComposerHandle {
	addFiles(files: readonly File[]): void;
	/** 发送失败后把内容放回输入框。 */
	restore(outgoing: IOutgoing): void;
}

const ALL = 'all';

/**
 * 输入框：Enter 发送，Shift+Enter 换行；群聊里输入 @ 选人点名（点名是参数，不进正文）；附件加入时就上传。
 * 文字和点名按 draftKey 存成草稿。换对话时要换 key，重新载入草稿。对话和时间线底部都用它。
 */
export function Composer({ ref, draftKey, placeholder, mentionCandidates, autoFocus = true, className = 'px-5 pb-4 pt-1', onSend }: {
	ref: Ref<IComposerHandle>;
	draftKey: string;
	placeholder: string;
	/** 群聊里可以点名的成员；私聊和时间线为 undefined。 */
	mentionCandidates: readonly IMember[] | undefined;
	/** 打开时把光标放进输入框。 */
	autoFocus?: boolean;
	/** 四周的留白。 */
	className?: string;
	onSend: (outgoing: IOutgoing) => void;
}) {
	const setDraft = usePreferences(state => state.setDraft);
	// 每个对话一个输入框（用 key 区分），打开时载入这个对话的草稿。
	const [text, setText] = useState(() => usePreferences.getState().drafts[draftKey]?.text ?? '');
	const [mentions, setMentions] = useState<readonly string[] | 'all'>(() => usePreferences.getState().drafts[draftKey]?.mentions ?? []);
	const [attachments, setAttachments] = useState<readonly IDraftAttachment[]>([]);
	const [notice, setNotice] = useState('');
	const [mention, setMention] = useState<{ query: string; index: number } | undefined>();
	const textarea = useRef<HTMLTextAreaElement>(null);
	const uploads = useRef(new Map<string, AbortController>());

	useEffect(() => {
		if (autoFocus) textarea.current?.focus();
	}, [autoFocus]);
	useEffect(() => setDraft(draftKey, { text, mentions }), [draftKey, text, mentions, setDraft]);
	useEffect(() => () => uploads.current.forEach(controller => controller.abort()), []);

	// 输入框随内容长高，最多 200px。
	useLayoutEffect(() => {
		const element = textarea.current;
		if (!element) return;
		element.style.height = 'auto';
		element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
	}, [text]);

	const update = (id: string, change: Partial<IDraftAttachment>) =>
		setAttachments(list => list.map(item => item.localId === id ? { ...item, ...change } : item));

	const addFiles = (files: readonly File[]) => {
		let count = attachments.length;
		const added: IDraftAttachment[] = [];
		for (const file of files) {
			const problem = checkFile(file, count);
			if (problem) {
				setNotice(problem);
				continue;
			}
			const item = draftAttachment(file);
			added.push(item);
			count++;
			const controller = new AbortController();
			uploads.current.set(item.localId, controller);
			uploadAttachment(file, item.name, progress => update(item.localId, { progress }), controller.signal)
				.then(attachment => update(item.localId, { status: 'done', progress: 1, attachmentId: attachment.attachmentId }))
				.catch(error => !controller.signal.aborted && update(item.localId, { status: 'failed', error: errorMessage(error) }))
				.finally(() => uploads.current.delete(item.localId));
		}
		if (added.length > 0) setAttachments(list => [...list, ...added]);
	};

	const remove = (item: IDraftAttachment) => {
		uploads.current.get(item.localId)?.abort();
		setAttachments(list => list.filter(other => other.localId !== item.localId));
	};

	useImperativeHandle(ref, () => ({
		addFiles,
		restore: outgoing => {
			setText(outgoing.text);
			setMentions(outgoing.mentions);
			setAttachments(outgoing.attachments);
			textarea.current?.focus();
		},
	}));

	const uploading = attachments.some(item => item.status === 'uploading');
	const ready = attachments.filter(item => item.status === 'done');
	const canSend = !uploading && (text.trim().length > 0 || ready.length > 0);

	const send = () => {
		if (uploading) return setNotice('附件正在上传');
		if (!canSend) return;
		onSend({ text: text.trim(), mentions, attachments: ready });
		setText('');
		setMentions([]);
		setAttachments([]);
		setNotice('');
		setMention(undefined);
	};

	// 光标前是「@关键字」时弹出选人列表。
	const options = mention && mentionCandidates ? mentionOptions(mentionCandidates, mention.query) : [];
	const detectMention = (value: string, caret: number) => {
		if (!mentionCandidates) return;
		const match = /(?:^|\s)@([^\s@]*)$/.exec(value.slice(0, caret));
		setMention(match ? { query: match[1]!, index: 0 } : undefined);
	};
	const pick = (memberId: string) => {
		const element = textarea.current!;
		const caret = element.selectionStart;
		const before = text.slice(0, caret).replace(/@[^\s@]*$/, '');
		setText(before + text.slice(caret));
		setMentions(current => memberId === ALL ? ALL : current === ALL ? current : current.includes(memberId) ? current : [...current, memberId]);
		setMention(undefined);
		requestAnimationFrame(() => {
			element.focus();
			element.setSelectionRange(before.length, before.length);
		});
	};

	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.nativeEvent.isComposing || event.keyCode === 229) return;
		if (mention && options.length > 0) {
			if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
				event.preventDefault();
				const step = event.key === 'ArrowDown' ? 1 : -1;
				setMention({ ...mention, index: (mention.index + step + options.length) % options.length });
				return;
			}
			if (event.key === 'Enter' || event.key === 'Tab') {
				event.preventDefault();
				pick(options[mention.index]!.id);
				return;
			}
			if (event.key === 'Escape') {
				event.preventDefault();
				setMention(undefined);
				return;
			}
		}
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			send();
		}
	};

	const mentionNames = mentions === ALL ? [{ id: ALL, name: '所有人' }] : mentions.map(id => ({ id, name: mentionCandidates?.find(member => member.memberId === id)?.name ?? '未知成员' }));

	return (
		<div className={clsx('relative', className)}>
			{options.length > 0 && mention && (
				<div className="absolute bottom-full left-5 z-10 mb-1 w-64 overflow-hidden rounded-lg border border-line bg-raised p-1 shadow-lg" role="listbox">
					{options.map((option, index) => (
						<button
							key={option.id}
							type="button"
							role="option"
							aria-selected={index === mention.index}
							onMouseDown={event => {
								event.preventDefault();
								pick(option.id);
							}}
							className={clsx('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px]', index === mention.index && 'bg-hover')}
						>
							{option.member ? <Avatar member={option.member} size={20} /> : <span className="flex size-5 items-center justify-center rounded bg-accent-soft text-accent">@</span>}
							<AiTag member={option.member} />
							<span className="shrink-0 truncate">{option.name}</span>
							<MemberNote member={option.member} />
						</button>
					))}
				</div>
			)}
			<div className="rounded-xl border border-line-strong bg-raised focus-within:border-accent">
				{(mentionNames.length > 0 || attachments.length > 0) && (
					<div className="flex flex-wrap items-start gap-2 px-3 pt-2.5">
						{mentionNames.map(item => (
							<span key={item.id} className="flex items-center gap-0.5 rounded bg-accent-soft py-0.5 pl-1.5 pr-0.5 text-[13px] text-accent">
								@{item.name}
								<button type="button" aria-label={`取消点名 ${item.name}`} onClick={() => setMentions(current => current === ALL ? [] : current.filter(id => id !== item.id))} className="rounded p-0.5 hover:bg-accent-soft">
									<X size={12} />
								</button>
							</span>
						))}
						{attachments.map(item => <AttachmentChip key={item.localId} item={item} onRemove={() => remove(item)} />)}
					</div>
				)}
				<textarea
					ref={textarea}
					rows={1}
					value={text}
					placeholder={placeholder}
					onChange={event => {
						setText(event.target.value);
						setNotice('');
						detectMention(event.target.value, event.target.selectionStart);
					}}
					onKeyDown={onKeyDown}
					onBlur={() => setMention(undefined)}
					onPaste={event => {
						const files = [...event.clipboardData.files];
						if (files.length > 0) {
							event.preventDefault();
							addFiles(files);
						}
					}}
					className="block max-h-[200px] w-full resize-none bg-transparent px-3.5 py-2.5 outline-none placeholder:text-fg-3"
				/>
				<div className="flex items-center gap-1 px-2 pb-2">
					<label className="inline-flex size-8 cursor-pointer items-center justify-center rounded-md text-fg-2 hover:bg-hover hover:text-fg" title="添加附件" aria-label="添加附件">
						<Paperclip size={17} />
						<input type="file" multiple className="hidden" onChange={event => {
							addFiles([...(event.target.files ?? [])]);
							event.target.value = '';
						}} />
					</label>
					<span className="flex-1 truncate text-xs text-danger">{notice}</span>
					<span className="hidden text-xs text-fg-3 sm:inline">{mentionCandidates ? '@ 点名，' : ''}Shift+Enter 换行</span>
					{/* 可以发送时悬停稍微放大：按钮平时小一点，放大了也不显得笨重。 */}
					<IconButton
						label={uploading ? '附件正在上传' : '发送'}
						disabled={!canSend}
						onClick={send}
						className={clsx('size-7 transition', canSend && 'bg-accent text-on-accent hover:scale-110 hover:bg-accent-hover hover:text-on-accent active:scale-100')}
					>
						<SendHorizontal size={15} />
					</IconButton>
				</div>
			</div>
		</div>
	);
}

/** 把文件拖进一块区域时加入附件：返回这块区域要接的事件，以及是否正拖着文件经过。 */
export function useFileDrop(onFiles: (files: File[]) => void, enabled = true) {
	const [dragging, setDragging] = useState(false);
	return {
		dragging,
		handlers: {
			onDragOver: (event: DragEvent) => {
				if (!enabled || !event.dataTransfer.types.includes('Files')) return;
				event.preventDefault();
				setDragging(true);
			},
			onDragLeave: (event: DragEvent) => {
				if (event.currentTarget === event.target) setDragging(false);
			},
			onDrop: (event: DragEvent) => {
				event.preventDefault();
				setDragging(false);
				if (enabled) onFiles([...event.dataTransfer.files]);
			},
		},
	};
}

/** 拖着文件经过时盖在区域上的提示。区域要是 relative。 */
export function DropHint() {
	return (
		<div className="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-xl border-2 border-dashed border-accent bg-accent-soft text-accent">
			松开鼠标添加附件
		</div>
	);
}

/** 输入框里的附件：图片只显示缩略图，点击看大图；其他文件是显示文件名和大小的窄卡片。 */
function AttachmentChip({ item, onRemove }: { item: IDraftAttachment; onRemove: () => void }) {
	const failed = item.status === 'failed';
	const uploading = item.status === 'uploading';
	const percent = `${Math.round(item.progress * 100)}%`;
	if (item.previewUrl) {
		return (
			<div className="group/attachment relative size-14 shrink-0" title={failed ? `${item.name}\n上传失败：${item.error}` : `${item.name}\n${formatSize(item.size)}`}>
				<ImageViewer url={item.previewUrl} name={item.name} download={false}>
					<button type="button" aria-label={`查看 ${item.name}`} className={clsx('block size-full overflow-hidden rounded-lg border', failed ? 'border-danger' : 'border-line')}>
						<img src={item.previewUrl} alt="" className="size-full object-cover" />
					</button>
				</ImageViewer>
				{uploading && <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg bg-black/45 text-[11px] font-medium text-white">{percent}</div>}
				{failed && <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg bg-danger/20"><CircleAlert size={18} className="text-danger" /></div>}
				<RemoveButton name={item.name} onClick={onRemove} />
			</div>
		);
	}
	return (
		<div title={failed ? `上传失败：${item.error}` : undefined} className={clsx('group/attachment relative flex h-14 w-44 shrink-0 items-center gap-2 rounded-lg border pl-2.5 pr-3', failed ? 'border-danger' : 'border-line')}>
			<FileText size={20} className="shrink-0 text-fg-2" />
			<div className="min-w-0 flex-1">
				<FileName name={item.name} className="text-xs" />
				<div className={clsx('truncate text-[11px]', failed ? 'text-danger' : 'text-fg-3')}>
					{failed ? '上传失败' : uploading ? `上传中 ${percent}` : formatSize(item.size)}
				</div>
			</div>
			{uploading && <div className="absolute bottom-0 left-0 h-0.5 rounded-bl-lg bg-accent" style={{ width: percent }} />}
			<RemoveButton name={item.name} onClick={onRemove} />
		</div>
	);
}

/** 附件右上角的移除按钮：悬停时出现，没有悬停的设备上一直显示。 */
function RemoveButton({ name, onClick }: { name: string; onClick: () => void }) {
	return (
		<button
			type="button"
			aria-label={`移除 ${name}`}
			title="移除"
			onClick={onClick}
			className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full bg-fg text-page opacity-0 shadow-sm transition-opacity hover:bg-fg-2 focus-visible:opacity-100 group-hover/attachment:opacity-100 [@media(hover:none)]:opacity-100"
		>
			<X size={12} strokeWidth={2.5} />
		</button>
	);
}

function mentionOptions(candidates: readonly IMember[], query: string): { id: string; name: string; member?: IMember }[] {
	const lowered = query.toLowerCase();
	const people = candidates.filter(member => member.name.toLowerCase().includes(lowered) || member.description.toLowerCase().includes(lowered)).map(member => ({ id: member.memberId, name: member.name, member }));
	const all = '所有人'.includes(query) || 'all'.startsWith(lowered) ? [{ id: ALL, name: '所有人' }] : [];
	return [...people, ...all].slice(0, 8);
}
