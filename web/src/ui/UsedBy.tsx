import type { IMember } from '../api/types.ts';

/** 最多列出几个名字，多了写「等 N 个」。 */
const MAX_NAMES = 5;

/** 删除确认框里的「在用的成员」一行：每个名字一个小标签。没有成员时不显示。 */
export function UsedBy({ members }: { members: readonly Pick<IMember, 'memberId' | 'name'>[] }) {
	if (members.length === 0) return null;
	return (
		<div className="mt-3 flex items-start gap-3">
			<span className="shrink-0 pt-0.5 text-xs text-fg-3">正在使用的成员</span>
			<div className="flex min-w-0 flex-wrap items-center gap-1.5">
				{members.slice(0, MAX_NAMES).map(member => (
					<span key={member.memberId} className="max-w-40 truncate rounded border border-line px-1.5 text-xs leading-5 text-fg">{member.name}</span>
				))}
				{members.length > MAX_NAMES && <span className="text-xs text-fg-2">等 {members.length} 个</span>}
			</div>
		</div>
	);
}
