import clsx from 'clsx';
import type { ReactNode } from 'react';
import type { IMember } from '../api/types.ts';

/** 名字后面的备注：灰色小字，放不下时截断，悬停看全文。没有备注时什么都不显示。children 可以换成高亮后的文字。 */
export function MemberNote({ member, className, children }: { member: Pick<IMember, 'description'> | undefined; className?: string; children?: ReactNode }) {
	if (!member?.description) return null;
	return <span title={member.description} className={clsx('min-w-0 truncate text-xs font-normal text-fg-3', className)}>{children ?? member.description}</span>;
}

/** 成员名前面的 AI 标签；不是 AI 成员时什么都不显示。 */
export function AiTag({ member }: { member: Pick<IMember, 'type'> | undefined }) {
	if (member?.type !== 'ai') return null;
	return <span className="shrink-0 rounded bg-selected px-1 text-[10px] font-medium leading-4 text-fg-2">AI</span>;
}
