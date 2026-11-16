import clsx from 'clsx';
import { Check } from 'lucide-react';
import { useState } from 'react';
import type { IMember } from '../api/types.ts';
import { Avatar } from '../ui/Avatar.tsx';
import { INPUT_CLASS } from '../ui/Dialog.tsx';
import { MemberNote } from '../ui/MemberNote.tsx';
import { Highlighted, keywords, matchesAll } from '../ui/SearchBox.tsx';

/** 多选成员：可以按名字和备注筛选，AI 在前。 */
export function MemberPicker({ candidates, selected, onChange }: {
	candidates: readonly IMember[];
	selected: readonly string[];
	onChange: (selected: string[]) => void;
}) {
	const [filter, setFilter] = useState('');
	const words = keywords(filter);
	const shown = candidates
		.filter(member => matchesAll(`${member.name} ${member.description}`, words))
		.sort((left, right) => (left.type === right.type ? left.name.localeCompare(right.name, 'zh-CN') : left.type === 'ai' ? -1 : 1));
	const toggle = (memberId: string) => onChange(selected.includes(memberId) ? selected.filter(id => id !== memberId) : [...selected, memberId]);
	return (
		<div>
			<input value={filter} onChange={event => setFilter(event.target.value)} placeholder="搜索成员" className={INPUT_CLASS} />
			<div className="mt-1.5 max-h-64 overflow-y-auto rounded-md border border-line">
				{shown.length === 0 && <div className="px-3 py-4 text-center text-[13px] text-fg-3">暂无可选的成员</div>}
				{shown.map(member => {
					const checked = selected.includes(member.memberId);
					return (
						<button
							key={member.memberId}
							type="button"
							role="checkbox"
							aria-checked={checked}
							onClick={() => toggle(member.memberId)}
							className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[13px] hover:bg-hover"
						>
							<span className={clsx('flex size-4 shrink-0 items-center justify-center rounded border', checked ? 'border-accent bg-accent text-on-accent' : 'border-line-strong')}>
								{checked && <Check size={12} />}
							</span>
							<Avatar member={member} size={22} />
							<span className="flex min-w-0 flex-1 items-baseline gap-1.5">
								<span className="shrink-0"><Highlighted text={member.name} words={words} /></span>
								<MemberNote member={member}><Highlighted text={member.description} words={words} /></MemberNote>
							</span>
							<span className="text-xs text-fg-3">{member.type === 'ai' ? 'AI' : '真人'}</span>
						</button>
					);
				})}
			</div>
		</div>
	);
}
