import { useMembers } from '../api/queries.ts';
import { openMemberDialog } from '../layout/uiState.ts';
import { CenteredMessage } from '../ui/CenteredMessage.tsx';

/** 成员页没选成员时。 */
export function MembersHome() {
	const members = useMembers();
	if (members.isSuccess && !members.data.some(member => member.type === 'ai' && !member.deleted)) {
		return <CenteredMessage title="暂无 AI 成员" action={{ label: '新建 AI 成员', onClick: () => openMemberDialog({ kind: 'newAi' }) }} />;
	}
	return <CenteredMessage title="选择一个成员" />;
}
