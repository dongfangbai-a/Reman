import clsx from 'clsx';
import { ArrowDown, LoaderCircle } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { api } from '../api/client.ts';
import { conversationKey } from '../api/keys.ts';
import { setMessagesAtBottom, useMessages } from '../api/queries.ts';
import type { ConversationTarget, IMessage, IMember } from '../api/types.ts';
import { errorMessage } from '../lib/errors.ts';
import { forgetScroll, type IScrollPosition, recallScroll, rememberScroll, restoreScroll } from '../lib/scrollMemory.ts';
import { usePerspective } from '../perspective/perspective.tsx';
import { TextButton } from '../ui/TextButton.tsx';
import type { IOutgoing } from './Composer.tsx';
import { attachmentViews, MessageItem } from './MessageItem.tsx';

/** 还没发成功的消息：发送中（error 为空）或发送失败。 */
export interface IPendingMessage {
	readonly localId: string;
	readonly outgoing: IOutgoing;
	readonly sentAt: number;
	readonly error: string | undefined;
}

/** 同一个人这么久之内的连续消息合并显示。 */
const GROUP_WINDOW_MS = 5 * 60 * 1000;
/** 离底部这么近算在底部。 */
const BOTTOM_SLACK = 40;
/** 离顶部、底部这么近时加载更早、更新的消息。 */
const LOAD_SLACK = 120;
/** 跳到的消息高亮这么久。 */
const HIGHLIGHT_MS = 3000;

/**
 * 消息列表：在底部时新消息来了自动滚到底；滚到顶加载更早的，保持当前看到的位置不动；
 * 在底部且页面可见时标记已读。地址带 ?message= 时跳到那条消息并高亮，往下滚接着加载更新的。
 * 切走时不在底部的，回来时停在原来看到的位置。
 */
export function MessageList({ target, memberById, pending, onRetry, onRestore, onOpenTimeline }: {
	target: ConversationTarget;
	onOpenTimeline: (memberId: string) => void;
	memberById: Map<string, IMember>;
	pending: readonly IPendingMessage[];
	onRetry: (message: IPendingMessage) => void;
	onRestore: (message: IPendingMessage) => void;
}) {
	const perspective = usePerspective();
	const query = useMessages(perspective.memberId, target);
	const messages = query.data?.messages ?? [];
	const scroller = useRef<HTMLDivElement>(null);
	const content = useRef<HTMLDivElement>(null);
	const memoryKey = `${perspective.memberId}|${conversationKey(perspective.memberId, target)}`;
	/** 上次离开时看到的位置，没有就是在底部。 */
	const [saved] = useState(() => recallScroll(memoryKey));
	/** 还没恢复到的位置。 */
	const restoring = useRef<IScrollPosition | undefined>(saved);
	/** 位置所在的那段消息不在缓存里时，已经去加载过了。 */
	const restoreLoaded = useRef(false);
	const atBottom = useRef(saved === undefined);
	const queryClient = useQueryClient();
	const [showJump, setShowJump] = useState(false);
	const [loadingOlder, setLoadingOlder] = useState(false);
	/** 加载更早消息前的滚动高度，加载后据此保持位置。 */
	/** 加载更早消息前的滚动位置和高度，加载后据此保持看到的位置。 */
	const anchor = useRef<{ top: number; height: number } | undefined>(undefined);
	const lastRead = useRef(0);
	const hasNewer = query.data?.hasNewer ?? false;
	const [loadingNewer, setLoadingNewer] = useState(false);
	const [searchParams, setSearchParams] = useSearchParams();
	const requested = Number(searchParams.get('message')) || undefined;
	const [highlight, setHighlight] = useState<number>();
	/** 渲染后要滚到的消息。 */
	const scrollTarget = useRef<number | undefined>(undefined);
	const [jumpError, setJumpError] = useState<string>();

	const scrollToBottom = () => {
		const element = scroller.current;
		if (element) element.scrollTop = element.scrollHeight;
	};

	/**
	 * 记下在不在底部，也记给消息的数据：在底部时去掉太早的，不在底部时限制接上多少新来的。
	 * 后面还有没取的不算在底部，除非 latest：这就回到最新一页。
	 */
	const setAtBottom = (value: boolean, latest = false) => {
		atBottom.current = value;
		setMessagesAtBottom(queryClient, perspective.memberId, target, value && (latest || !hasNewer));
	};

	/** 按实际的滚动位置记下在不在底部、显不显示「回到底部」。内容不够滚动时位置不变，不会有滚动事件，要自己算。 */
	const syncBottom = (element: HTMLElement) => {
		setAtBottom(element.scrollHeight - element.scrollTop - element.clientHeight < BOTTOM_SLACK);
		setShowJump(!atBottom.current || hasNewer);
	};

	const markRead = () => {
		const latest = messages.at(-1)?.messageId ?? 0;
		if (!atBottom.current || hasNewer || requested !== undefined || document.visibilityState !== 'visible' || latest <= lastRead.current) return;
		lastRead.current = latest;
		const id = target.kind === 'direct' ? target.memberId : target.groupId;
		void api('POST', `/v1/members/${perspective.memberId}/conversations/${target.kind}/${id}/read`, { throughMessageId: latest }).catch(() => {
			lastRead.current = 0;
		});
	};

	// 恢复不了就回到最新。
	const stopRestoring = () => {
		restoring.current = undefined;
		forgetScroll(memoryKey);
		setAtBottom(true, true);
		if (query.data?.hasNewer) void query.backToLatest();
		else scrollToBottom();
	};

	// 回到上次看到的位置；那段消息已经不在缓存里时，先加载它前后的一段。
	const restore = (element: HTMLElement, position: IScrollPosition) => {
		if (restoreScroll(element, position)) {
			restoring.current = undefined;
			syncBottom(element);
		} else if (!restoreLoaded.current && messages.length > 0) {
			restoreLoaded.current = true;
			query.jumpTo(Number(position.id)).catch(stopRestoring);
		} else {
			stopRestoring();
		}
	};

	// 内容变了：自己刚发了消息就滚到底；刚加载了更早的消息就保持位置；原来在底部就继续贴着底部。
	const pendingCount = useRef(pending.length);
	useLayoutEffect(() => {
		const element = scroller.current;
		if (!element) return;
		if (pending.length > pendingCount.current) {
			setAtBottom(true, true);
			restoring.current = undefined;
		}
		pendingCount.current = pending.length;
		// 地址里要跳到某条消息时以跳转为准。
		if (requested !== undefined) restoring.current = undefined;
		if (restoring.current) {
			if (query.data) restore(element, restoring.current);
			return;
		}
		if (anchor.current !== undefined) {
			// 按加载前记下的绝对位置算：浏览器的滚动锚定会自己调一次 scrollTop，用增量加会算两遍，直接跳到接近底部。
			const { top, height } = anchor.current;
			element.scrollTop = top + (element.scrollHeight - height);
			anchor.current = undefined;
		} else if (atBottom.current && !hasNewer) {
			scrollToBottom();
		}
	}, [messages, pending]);

	// 跳到的消息渲染出来后滚到它。
	useLayoutEffect(() => {
		const messageId = scrollTarget.current;
		const element = messageId === undefined ? null : scroller.current?.querySelector(`[data-scroll-id="${messageId}"]`);
		if (!element) return;
		scrollTarget.current = undefined;
		element.scrollIntoView({ block: 'center' });
		syncBottom(scroller.current!);
	});

	// 地址里的 ?message=：已经加载了就直接滚过去，否则加载它前后的消息。处理完从地址里去掉。
	useEffect(() => {
		if (!requested || !query.data) return;
		// 跳过去看的是旧消息，不算看过最新的。
		setAtBottom(false);
		setSearchParams(params => {
			params.delete('message');
			return params;
		}, { replace: true });
		// 在不在底部等滚到这条消息后再算。
		const show = () => {
			scrollTarget.current = requested;
			setAtBottom(false);
			setHighlight(requested);
		};
		setJumpError(undefined);
		if (query.data.messages.some(message => message.messageId === requested)) show();
		else query.jumpTo(requested).then(show, caught => setJumpError(errorMessage(caught)));
	}, [requested, !!query.data]);

	// 上次离开时在底部，但缓存里还是跳到的那一段：回到最新。
	useEffect(() => {
		if (query.data?.hasNewer && !requested && !saved) void query.backToLatest();
	}, []);

	useEffect(() => {
		if (highlight === undefined) return;
		const timer = window.setTimeout(() => setHighlight(undefined), HIGHLIGHT_MS);
		return () => window.clearTimeout(timer);
	}, [highlight]);

	// 停在跳到的位置时自己发了消息，回到最新。
	useEffect(() => {
		if (hasNewer && pending.length > 0) void query.backToLatest();
	}, [pending.length > 0 && hasNewer]);

	// 图片加载完会撑高内容，在底部时跟着滚到底。
	const hasNewerRef = useRef(hasNewer);
	hasNewerRef.current = hasNewer;
	useEffect(() => {
		if (!content.current) return;
		const observer = new ResizeObserver(() => atBottom.current && !hasNewerRef.current && scrollToBottom());
		observer.observe(content.current);
		return () => observer.disconnect();
	}, []);

	// 消息不够撑出滚动条时滚不动，直接接着加载。
	useEffect(() => {
		const element = scroller.current;
		if (!element || restoring.current || element.scrollHeight > element.clientHeight) return;
		if (query.data?.hasOlder) void loadOlder();
		else if (hasNewer) void loadNewer();
	});

	useEffect(markRead);
	useEffect(() => {
		const onVisible = () => markRead();
		document.addEventListener('visibilitychange', onVisible);
		return () => document.removeEventListener('visibilitychange', onVisible);
	});

	const loadOlder = async () => {
		if (loadingOlder || !query.data?.hasOlder || !scroller.current) return;
		setLoadingOlder(true);
		anchor.current = { top: scroller.current.scrollTop, height: scroller.current.scrollHeight };
		try {
			await query.loadOlder();
		} catch {
			anchor.current = undefined;
		} finally {
			setLoadingOlder(false);
		}
	};

	const loadNewer = async () => {
		if (loadingNewer || !hasNewer) return;
		setLoadingNewer(true);
		try {
			await query.loadNewer();
		} catch {
			// 滚动时会再试。
		} finally {
			setLoadingNewer(false);
		}
	};

	const onScroll = () => {
		const element = scroller.current!;
		if (restoring.current) return;
		syncBottom(element);
		if (atBottom.current && !hasNewer) forgetScroll(memoryKey);
		else rememberScroll(memoryKey, element);
		if (atBottom.current) markRead();
		if (element.scrollTop < LOAD_SLACK) void loadOlder();
		if (element.scrollHeight - element.scrollTop - element.clientHeight < LOAD_SLACK) void loadNewer();
	};

	// 先记下在底部：最新一页换上来后，渲染时就会滚到底。
	const backToBottom = async () => {
		setAtBottom(true, true);
		restoring.current = undefined;
		forgetScroll(memoryKey);
		setShowJump(false);
		if (hasNewer) await query.backToLatest();
		scrollToBottom();
	};

	return (
		<div className="relative min-h-0 flex-1">
			<div ref={scroller} onScroll={onScroll} className="h-full overflow-y-auto [overflow-anchor:none]">
				<div ref={content} className="center-column flex min-h-full flex-col justify-end pb-3 pt-2">
					{query.isPending && <div className="py-8 text-center text-[13px] text-fg-3">正在加载…</div>}
					{query.isError && (
						<div className="py-8 text-center text-[13px] text-danger">
							加载消息失败：{query.error.message} <button type="button" className="underline" onClick={() => void query.refetch()}>重试</button>
						</div>
					)}
					{query.data?.hasOlder && (
						<div className="flex justify-center py-2 text-fg-3">{loadingOlder ? <LoaderCircle size={16} className="animate-spin" /> : <span className="text-xs">向上滚动加载更早的消息</span>}</div>
					)}
					{query.data && !query.data.hasOlder && messages.length > 0 && <div className="py-3 text-center text-xs text-fg-3">以上为全部消息</div>}
					{query.data && messages.length === 0 && pending.length === 0 && <div className="py-8 text-center text-[13px] text-fg-3">暂无消息</div>}
					{messages.map((message, index) => (
						<ListedMessage
							key={message.messageId}
							message={message}
							sender={memberById.get(message.senderMemberId)}
							compact={continues(messages[index - 1], message)}
							highlighted={highlight === message.messageId}
							memberById={memberById}
							selfId={perspective.memberId}
							onOpenTimeline={onOpenTimeline}
						/>
					))}
					{hasNewer && <div className="flex justify-center py-2 text-fg-3">{loadingNewer ? <LoaderCircle size={16} className="animate-spin" /> : <span className="text-xs">向下滚动加载更新的消息</span>}</div>}
					{!hasNewer && pending.map((message, index) => (
						<div key={message.localId} className={message.error ? '' : 'opacity-60'}>
							<MessageItem
								message={{
									text: message.outgoing.text,
									mentionAll: message.outgoing.mentions === 'all',
									mentionedMemberIds: message.outgoing.mentions === 'all' ? [] : message.outgoing.mentions,
									sentAt: message.sentAt,
									attachments: message.outgoing.attachments.map(item => ({ name: item.name, kind: item.image ? 'image' : 'file', size: item.size, url: item.previewUrl })),
								}}
								sender={perspective}
								own
								compact={pendingContinues(index > 0 ? pending[index - 1] : messages.at(-1), message, perspective.memberId)}
								memberById={memberById}
								footer={message.error
									? (
										<div className="mt-1 flex flex-wrap items-center gap-2 text-[13px] text-danger">
											发送失败：{message.error}
											<TextButton onClick={() => onRetry(message)}>重试</TextButton>
											<TextButton onClick={() => onRestore(message)}>恢复至输入框</TextButton>
										</div>
									)
									: <div className="mt-0.5 text-xs text-fg-3">发送中…</div>}
							/>
						</div>
					))}
				</div>
			</div>
			{jumpError && (
				<div className="absolute left-1/2 top-3 -translate-x-1/2 rounded-md bg-danger px-3 py-1.5 text-xs text-white shadow-md">
					无法定位到该消息：{jumpError}
					<button type="button" className="ml-2 underline" onClick={() => setJumpError(undefined)}>关闭</button>
				</div>
			)}
			{(showJump || hasNewer) && (
				<button
					type="button"
					onClick={() => void backToBottom()}
					className="absolute bottom-3 right-5 flex items-center gap-1 rounded-full border border-line bg-raised px-3 py-1.5 text-xs shadow-md hover:bg-hover-layer"
				>
					<ArrowDown size={14} />回到底部
				</button>
			)}
		</div>
	);
}

/**
 * 列表里的一条消息。消息对象和其他属性都没变时跳过重画：成员状态变、来了新消息、往上翻页时，已经显示的不跟着重画。
 * 属性里只放这一条要的；memberById、onOpenTimeline 由对话页保持不变。
 */
const ListedMessage = memo(function ListedMessage({ message, sender, compact, highlighted, memberById, selfId, onOpenTimeline }: {
	message: IMessage;
	sender: IMember | undefined;
	compact: boolean;
	highlighted: boolean;
	memberById: Map<string, IMember>;
	selfId: string;
	onOpenTimeline: (memberId: string) => void;
}) {
	const view = useMemo(() => ({ ...message, attachments: attachmentViews(message) }), [message]);
	return (
		<div data-scroll-id={message.messageId} className={clsx('transition-colors duration-700', highlighted && 'bg-accent-soft')}>
			<MessageItem
				message={view}
				sender={sender}
				own={message.senderMemberId === selfId}
				compact={compact}
				memberById={memberById}
				selfId={selfId}
				onOpenTimeline={onOpenTimeline}
			/>
		</div>
	);
});

function continues(previous: IMessage | undefined, message: IMessage): boolean {
	return !!previous && previous.senderMemberId === message.senderMemberId && message.sentAt - previous.sentAt < GROUP_WINDOW_MS;
}

/** 还没发出的消息接着上一条自己的消息（已发出的或也还没发出的）时合并。 */
function pendingContinues(previous: IMessage | IPendingMessage | undefined, message: IPendingMessage, selfId: string): boolean {
	if (!previous || ('senderMemberId' in previous && previous.senderMemberId !== selfId)) return false;
	return message.sentAt - previous.sentAt < GROUP_WINDOW_MS;
}
