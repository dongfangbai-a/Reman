import { useGroup } from '../api/queries.ts';
import { Dialog } from '../ui/Dialog.tsx';
import { GroupDetail } from './GroupSettings.tsx';

/** 群聊设置的弹窗，在视角页群聊顶部的齿轮打开。加人、移出、解散以视角成员的身份去做。 */
export function GroupSettingsDialog({ groupId, open, onOpenChange }: { groupId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
	const group = useGroup(groupId);
	return (
		<Dialog open={open} onOpenChange={onOpenChange} title="群聊设置" width="w-[42rem]" dense focusInput={false}>
			{group.data
				? <GroupDetail group={group.data} />
				: <div className="py-6 text-center text-[13px] text-fg-3">{group.isError ? `加载失败：${group.error.message}` : '正在加载…'}</div>}
		</Dialog>
	);
}
