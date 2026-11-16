import { LoaderCircle } from 'lucide-react';
import { useEffect, useState, type ReactNode, type UIEvent } from 'react';
import { Link } from 'react-router';
import { conversationKey, conversationPath, refKey, refTarget } from '../api/keys.ts';
import { useMessageSearch } from '../api/queries.ts';
import type { IConversationSummary, IMessage, IMember } from '../api/types.ts';
import { listTime } from '../lib/format.ts';
import { usePerspective } from '../perspective/perspective.tsx';
import { Highlighted, matchesAll } from '../ui/SearchBox.tsx';
import { SelfName } from '../ui/SelfName.tsx';

const SEARCH_DELAY_MS = 250;
/** 关键词前面最多留这么多字。 */
const SNIPPET_LEAD = 24;

/** 搜索结果：名字匹配的对话，和包含关键词的消息。 */
export function SearchResults({ words, conversations, memberById, renderConversation }: {
	words: readonly string[];
	conversations: readonly IConversationSummary[];
	memberById: Map<string, IMember>;
	renderConversation: (item: IConversationSummary) => ReactNode;
}) {
	const perspective = usePerspective();
	const query = useDebounced(words.join(' '), SEARCH_DELAY_MS);
	const search = useMessageSearch(perspective.memberId, query);
	const matched = conversations.filter(item => matchesAll(item.name, words));
	const names = new Map(conversations.map(item => [conversationKey(perspective.memberId, item.target), item.name]));
	const messages = search.data?.pages.flat() ?? [];
	const searching = query !== words.join(' ') || search.isPending;

	const onScroll = (event: UIEvent<HTMLDivElement>) => {
		const element = event.currentTarget;
		if (element.scrollHeight - element.scrollTop - element.clientHeight < 120 && search.hasNextPage && !search.isFetchingNextPage) void search.fetchNextPage();
	};

	return (
		<div onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto py-1">
			<GroupTitle>对话</GroupTitle>
			{matched.length === 0 ? <Empty>无名称匹配的对话</Empty> : matched.map(renderConversation)}
			<GroupTitle>消息</GroupTitle>
			{search.isError && <div className="px-4 py-2 text-[13px] text-danger">搜索失败：{search.error.message}</div>}
			{searching && !search.isError && <Spinner />}
			{!searching && search.isSuccess && messages.length === 0 && <Empty>未找到消息</Empty>}
			{!searching && messages.map(message => (
				<MessageResult key={message.messageId} message={message} words={words} sender={memberById.get(message.senderMemberId)} conversationName={names.get(refKey(message.conversation)) ?? fallbackName(message, perspective.memberId, memberById)} />
			))}
			{search.isFetchingNextPage && <Spinner />}
		</div>
	);
}

function MessageResult({ message, words, sender, conversationName }: { message: IMessage; words: readonly string[]; sender: IMember | undefined; conversationName: string }) {
	const perspective = usePerspective();
	const target = refTarget(message.conversation, perspective.memberId);
	return (
		<Link to={conversationPath(perspective.memberId, target, message.messageId)} className="mx-1.5 block rounded-lg px-2.5 py-2 hover:bg-hover">
			<div className="flex items-baseline gap-2 text-xs text-fg-3">
				<span className="min-w-0 flex-1 truncate">{conversationName} · {sender?.memberId === perspective.memberId ? <SelfName name={perspective.name} /> : sender?.name ?? '未知成员'}</span>
				<span className="shrink-0">{listTime(message.sentAt)}</span>
			</div>
			<div className="line-clamp-2 break-words text-[13px] text-fg-2"><Highlighted text={snippet(message.text, words)} words={words} /></div>
		</Link>
	);
}

function GroupTitle({ children }: { children: ReactNode }) {
	return <div className="px-4 pb-1 pt-2 text-xs font-medium text-fg-3">{children}</div>;
}

function Empty({ children }: { children: ReactNode }) {
	return <div className="px-4 py-2 text-[13px] text-fg-3">{children}</div>;
}

function Spinner() {
	return <div className="flex justify-center py-2 text-fg-3"><LoaderCircle size={16} className="animate-spin" /></div>;
}

/** 正文压成一行；第一个关键词太靠后时从它前面一点开始显示。 */
function snippet(text: string, words: readonly string[]): string {
	const flat = text.replace(/\s+/g, ' ').trim();
	const lower = flat.toLowerCase();
	const first = Math.min(...words.map(word => lower.indexOf(word.toLowerCase())).filter(index => index >= 0));
	return Number.isFinite(first) && first > SNIPPET_LEAD ? `…${flat.slice(first - SNIPPET_LEAD)}` : flat;
}

function fallbackName(message: IMessage, viewerMemberId: string, memberById: Map<string, IMember>): string {
	const target = refTarget(message.conversation, viewerMemberId);
	return target.kind === 'direct' ? memberById.get(target.memberId)?.name ?? '私聊' : '群聊';
}

function useDebounced(value: string, delay: number): string {
	const [debounced, setDebounced] = useState(value);
	useEffect(() => {
		const timer = window.setTimeout(() => setDebounced(value), delay);
		return () => window.clearTimeout(timer);
	}, [value, delay]);
	return debounced;
}
