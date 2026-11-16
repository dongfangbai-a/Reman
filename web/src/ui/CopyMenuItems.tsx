import { Copy, Hash } from 'lucide-react';
import { copyText } from '../lib/clipboard.ts';
import { MenuItem } from './Menu.tsx';

/** 成员上下文里的写法：成员是 沈安(M_xxx)。粘贴进消息后成员直接认得出。 */
export function memberReference(member: { readonly name: string; readonly memberId: string }): string {
	return `${member.name}(${member.memberId})`;
}

/** 成员上下文里的写法：群聊是 群聊「讨论组」(G_xxx)。 */
export function groupReference(group: { readonly name: string; readonly groupId: string }): string {
	return `群聊「${group.name}」(${group.groupId})`;
}

/** 菜单里的两项：复制名字和 ID、只复制 ID。 */
export function CopyMenuItems({ reference, id, group = false }: { reference: string; id: string; group?: boolean }) {
	return (
		<>
			<MenuItem onSelect={() => void copyText(reference)}><Copy size={15} />{group ? '复制群名和 ID' : '复制名字和 ID'}</MenuItem>
			<MenuItem onSelect={() => void copyText(id)}><Hash size={15} />{group ? '复制群聊 ID' : '复制 ID'}</MenuItem>
		</>
	);
}
