import clsx from 'clsx';
import { Users } from 'lucide-react';
import type { IMember } from '../api/types.ts';

const TINTS = ['#e7664b', '#d9822b', '#3f9a5f', '#2f8fa3', '#4a74d8', '#7d5fd3', '#c2559a', '#6b7280'];

/** 成员头像：有头像图片用图片，没有时用名字首字和按 ID 固定的底色。 */
export function Avatar({ member, size = 32, className }: { member: Pick<IMember, 'memberId' | 'name' | 'avatar' | 'type'> | undefined; size?: number; className?: string }) {
	const style = { width: size, height: size, fontSize: Math.round(size * 0.42) };
	if (member?.avatar) {
		return <img src={`/v1/members/${member.memberId}/avatar?v=${member.avatar}`} alt="" style={style} className={clsx('avatar object-cover', className)} />;
	}
	return (
		<div
			aria-hidden
			style={{ ...style, background: tint(member?.memberId ?? '') }}
			className={clsx('avatar flex select-none items-center justify-center font-medium text-white', className)}
		>
			{member ? [...member.name][0] : '?'}
		</div>
	);
}

export function GroupAvatar({ groupId, size = 32 }: { groupId: string; size?: number }) {
	return (
		<div aria-hidden style={{ width: size, height: size, background: tint(groupId) }} className="flex shrink-0 items-center justify-center rounded-md text-white">
			<Users size={Math.round(size * 0.5)} />
		</div>
	);
}

function tint(id: string): string {
	let hash = 0;
	for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
	return TINTS[hash % TINTS.length]!;
}
