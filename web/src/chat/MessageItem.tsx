import * as Dialog from '@radix-ui/react-dialog';
import clsx from 'clsx';
import { FileText, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { IAttachment, IMessage, IMember } from '../api/types.ts';
import { clockTime, formatSize, fullTime, shortTime } from '../lib/format.ts';
import { Avatar } from '../ui/Avatar.tsx';
import { CopyButton } from '../ui/CopyButton.tsx';
import { ExternalTag, MetaDetails } from '../ui/ExternalMeta.tsx';
import { AiTag, MemberNote } from '../ui/MemberNote.tsx';
import { Markdown } from './Markdown.tsx';

type MessageView = Pick<IMessage, 'text' | 'mentionAll' | 'mentionedMemberIds' | 'sentAt'> & { messageId?: number; external?: IMessage['external']; attachments: readonly IAttachmentView[] };

/**
 * 一条消息。compact 时和上一条是同一个人连着发的，不再显示头像和名字。
 * own 是视角成员自己发的：靠右放在气泡里。selfId 是视角成员，点名它的标签用实心的强调色。
 */
export function MessageItem({ message, sender, own = false, compact, memberById, selfId, footer, onOpenTimeline }: {
	message: MessageView;
	sender: IMember | undefined;
	own?: boolean;
	compact: boolean;
	memberById: Map<string, IMember>;
	selfId?: string;
	footer?: ReactNode;
	/** 点 AI 成员的头像打开它的时间线。 */
	onOpenTimeline?: (memberId: string) => void;
}) {
	if (own) return <OwnMessage message={message} ai={sender?.type === 'ai'} compact={compact} memberById={memberById} selfId={selfId} footer={footer} />;
	return (
		// 合并的消息按基线对齐：左边的时间和正文第一行的文字底边对齐，字号不同也不会高低不齐。
		<div className={clsx('group/copy flex gap-3 px-5 hover:bg-hover/60', compact ? 'items-baseline py-0.5' : 'mt-2 pb-0.5 pt-1.5')}>
			<div className={clsx('w-9 shrink-0', compact && 'flex justify-end')}>
				{compact
					// 时分秒比头像这一栏宽：靠右放，多出来的伸进左边的留白。
					? <span title={fullTime(message.sentAt)} className="whitespace-nowrap text-[11px] tabular-nums text-fg-3">{clockTime(message.sentAt)}</span>
					: sender?.type === 'ai' && onOpenTimeline
						? (
							<button type="button" title={`查看 ${sender.name} 的时间线`} onClick={() => onOpenTimeline(sender.memberId)} className="block rounded-md hover:opacity-80">
								<Avatar member={sender} size={36} />
							</button>
						)
						: <Avatar member={sender} size={36} />}
			</div>
			<div className="min-w-0 flex-1">
				{!compact && (
					<div className="flex items-baseline gap-2">
						<AiTag member={sender} />
						<span className="shrink-0 font-semibold">{sender?.name ?? '未知成员'}</span>
						<MemberNote member={sender} />
						{message.external && <ExternalTag source={message.external.source} className="self-center" />}
						<span title={fullTime(message.sentAt)} className="shrink-0 text-xs text-fg-3">{shortTime(message.sentAt)}</span>
					</div>
				)}
				{compact && message.external && <ExternalTag source={message.external.source} className="inline-block" />}
				<Mentions message={message} memberById={memberById} selfId={selfId} />
				{message.text && (sender?.type === 'ai'
					? <Markdown text={message.text} />
					: <div className="whitespace-pre-wrap break-words">{message.text}</div>)}
				{message.attachments.length > 0 && <Attachments attachments={message.attachments} />}
				{message.external && <MetaDetails meta={message.external.meta} className="mt-0.5" />}
				{footer}
			</div>
			{/* 正文右边的一栏：和第一行对齐，正文不会伸到它下面。 */}
			{message.text && <CopyButton text={message.text} className="mt-px self-start" />}
		</div>
	);
}

/** 自己的消息：靠右的气泡，不显示头像和名字，时间在气泡左边（连着发的只在悬停时显示）。AI 视角下气泡里是 Markdown，放宽一些。 */
function OwnMessage({ message, ai, compact, memberById, selfId, footer }: {
	message: MessageView;
	ai: boolean;
	compact: boolean;
	memberById: Map<string, IMember>;
	selfId: string | undefined;
	footer?: ReactNode;
}) {
	return (
		<div className={clsx('group/copy flex items-end justify-end gap-2 px-5 hover:bg-hover/60', compact ? 'py-0.5' : 'mt-2 pb-0.5 pt-1.5')}>
			{message.text && <CopyButton text={message.text} className="mb-1" />}
			<span
				title={fullTime(message.sentAt)}
				className="shrink-0 pb-1 text-[11px] tabular-nums text-fg-3"
			>
				{compact ? clockTime(message.sentAt) : shortTime(message.sentAt)}
			</span>
			<div className={clsx('flex min-w-0 flex-col items-end', ai ? 'max-w-[85%]' : 'max-w-[85%] md:max-w-[70%]')}>
				{message.external && <ExternalTag source={message.external.source} className="mb-0.5" />}
				<Mentions message={message} memberById={memberById} selfId={selfId} className="justify-end" />
				{message.text && (
					<div className="min-w-0 max-w-full rounded-2xl bg-accent-soft px-3.5 py-2">
						{ai
							? <Markdown text={message.text} />
							: <div className="whitespace-pre-wrap break-words">{message.text}</div>}
					</div>
				)}
				{message.attachments.length > 0 && <Attachments attachments={message.attachments} className="justify-end" />}
				{message.external && <MetaDetails meta={message.external.meta} className="mt-0.5" />}
				{footer}
			</div>
		</div>
	);
}

/** 正文前面的点名。点名了「自己」（selfId：视角成员、时间线主人）的那个用实心的强调色，别的是浅底。 */
export function Mentions({ message, memberById, selfId, className }: { message: Pick<IMessage, 'mentionAll' | 'mentionedMemberIds'>; memberById: Map<string, IMember>; selfId?: string; className?: string }) {
	const mentions = message.mentionAll
		? [{ id: 'all', name: '所有人', self: false }]
		: message.mentionedMemberIds.map(memberId => ({ id: memberId, name: memberById.get(memberId)?.name ?? '未知成员', self: memberId === selfId }));
	if (mentions.length === 0) return null;
	return (
		<div className={clsx('flex flex-wrap gap-1 pb-0.5', className)}>
			{mentions.map(mention => (
				<span key={mention.id} className={clsx('rounded px-1.5 text-[13px]', mention.self ? 'bg-accent text-on-accent' : 'bg-accent-soft text-accent')}>@{mention.name}</span>
			))}
		</div>
	);
}

/** 显示用的附件：已发出的消息里的附件有地址；还没发出的用本地预览。 */
export interface IAttachmentView {
	readonly name: string;
	readonly kind: IAttachment['kind'];
	readonly size: number;
	/** 图片和下载的地址。 */
	readonly url: string | undefined;
}

export function attachmentViews(message: IMessage): IAttachmentView[] {
	return message.attachments.map((attachment, index) => ({
		name: attachment.name, kind: attachment.kind, size: attachment.size, url: `/v1/messages/${message.messageId}/attachments/${index}`,
	}));
}

/** 附件数量的说明，例如「2 张图片 · 1 个文件」。 */
export function attachmentLabel(kinds: readonly IAttachment['kind'][]): string {
	const images = kinds.filter(kind => kind === 'image').length;
	const files = kinds.length - images;
	return [images > 0 && `${images} 张图片`, files > 0 && `${files} 个文件`].filter(Boolean).join(' · ');
}

/** 附件：图片显示缩略图，点击看大图；其他文件是卡片，点击下载。small 时图片小一些（时间线里用）。 */
export function Attachments({ attachments, small = false, className }: { attachments: readonly IAttachmentView[]; small?: boolean; className?: string }) {
	return (
		<div className={clsx('mt-1 flex flex-wrap gap-2', className)}>
			{attachments.map((attachment, index) => attachment.kind === 'image' && attachment.url
				? <ImageAttachment key={index} attachment={attachment} small={small} />
				: (
					<a
						key={index}
						href={attachment.url}
						download={attachment.name}
						className="flex w-60 items-center gap-2.5 rounded-lg border border-line bg-raised px-3 py-2 hover:border-line-strong"
					>
						<FileText size={22} className="shrink-0 text-fg-2" />
						<div className="min-w-0">
							<FileName name={attachment.name} className="text-[13px]" />
							<div className="text-xs text-fg-3">{formatSize(attachment.size)}</div>
						</div>
					</a>
				))}
		</div>
	);
}

function ImageAttachment({ attachment, small }: { attachment: IAttachmentView; small: boolean }) {
	return (
		<ImageViewer url={attachment.url!} name={attachment.name}>
			<button type="button" className="overflow-hidden rounded-lg border border-line" title={attachment.name}>
				<img src={attachment.url} alt={attachment.name} className={clsx('block object-contain', small ? 'max-h-32 max-w-48' : 'max-h-60 max-w-80')} />
			</button>
		</ImageViewer>
	);
}

/**
 * 看大图：点 children 打开，铺满屏幕的黑底上显示原图。点图片、点空白处、右上角的 ×、按 Esc 都能关闭。
 * download 时下面可以下载；自己刚加的附件本来就在本地，不用下载。
 */
export function ImageViewer({ url, name, download = true, children }: { url: string; name: string; download?: boolean; children: ReactNode }) {
	const [open, setOpen] = useState(false);
	return (
		<Dialog.Root open={open} onOpenChange={setOpen}>
			<Dialog.Trigger asChild>{children}</Dialog.Trigger>
			<Dialog.Portal>
				<Dialog.Overlay className="fixed inset-0 z-50 bg-black/70" />
				<Dialog.Content
					aria-describedby={undefined}
					onClick={event => event.target === event.currentTarget && setOpen(false)}
					className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 p-8 outline-none"
				>
					<Dialog.Title className="sr-only">{name}</Dialog.Title>
					<Dialog.Close asChild>
						<img src={url} alt={name} className="max-h-[85vh] max-w-[90vw] cursor-zoom-out rounded object-contain" />
					</Dialog.Close>
					{download
						? <a href={url} download={name} className="text-[13px] text-white/80 hover:text-white">{name} · 下载</a>
						: <span className="text-[13px] text-white/80">{name}</span>}
					<Dialog.Close
						aria-label="关闭"
						title="关闭"
						className="absolute right-4 top-4 flex size-9 items-center justify-center rounded-full bg-white/10 text-white/90 hover:bg-white/20 hover:text-white"
					>
						<X size={18} />
					</Dialog.Close>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

/** 文件名：放不下时截掉中间，保留扩展名。 */
export function FileName({ name, className }: { name: string; className?: string }) {
	const dot = name.lastIndexOf('.');
	const extension = dot > 0 && name.length - dot <= 8 ? name.slice(dot) : '';
	return (
		<span title={name} className={clsx('flex min-w-0', className)}>
			<span className="truncate">{extension ? name.slice(0, dot) : name}</span>
			{extension && <span className="shrink-0">{extension}</span>}
		</span>
	);
}
