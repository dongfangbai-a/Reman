import { Search, X } from 'lucide-react';
import type { Ref } from 'react';

/** 列表顶部的搜索框：有内容时右边有清空按钮，按 Esc 清空。 */
export function SearchBox({ value, onChange, placeholder, ref }: { value: string; onChange: (value: string) => void; placeholder: string; ref?: Ref<HTMLInputElement> }) {
	return (
		<div className="relative">
			<Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-3" />
			<input
				ref={ref}
				type="search"
				value={value}
				onChange={event => onChange(event.target.value)}
				onKeyDown={event => {
					if (event.key !== 'Escape' || !value) return;
					event.preventDefault();
					onChange('');
				}}
				placeholder={placeholder}
				aria-label={placeholder}
				className="h-8 w-full rounded-md border border-line bg-page pl-8 pr-7 text-[13px] outline-none focus:border-accent [&::-webkit-search-cancel-button]:hidden"
			/>
			{value && (
				<button type="button" aria-label="清空" title="清空" onClick={() => onChange('')} className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-fg-3 hover:bg-hover hover:text-fg">
					<X size={14} />
				</button>
			)}
		</div>
	);
}

/** 按空格分开的关键词。 */
export function keywords(query: string): string[] {
	return query.trim().split(/\s+/).filter(Boolean);
}

/** 不分大小写，是否包含全部关键词。 */
export function matchesAll(text: string, words: readonly string[]): boolean {
	const lower = text.toLowerCase();
	return words.every(word => lower.includes(word.toLowerCase()));
}

/** 文字里的关键词高亮。 */
export function Highlighted({ text, words }: { text: string; words: readonly string[] }) {
	if (words.length === 0) return text;
	const pattern = new RegExp(`(${words.map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
	return text.split(pattern).map((part, index) => index % 2 === 1 ? <mark key={index} className="rounded-sm bg-accent-soft text-accent">{part}</mark> : part);
}
