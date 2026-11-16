import { useEffect } from 'react';
import { Navigate, useParams } from 'react-router';
import { useMembers } from '../api/queries.ts';
import { useFocus } from '../layout/uiState.ts';
import { TimelineView } from '../timeline/TimelineView.tsx';
import { CenteredMessage } from '../ui/CenteredMessage.tsx';

/** 成员页中间：AI 成员的时间线。真人没有时间线，进它的视角。 */
export function MemberTimelinePage() {
	const { memberId } = useParams();
	const members = useMembers();
	const member = members.data?.find(item => item.memberId === memberId);
	// 概况栏把正在看的成员的待处理排在前面、显示它的计划。
	useEffect(() => {
		useFocus.setState({ center: memberId });
		return () => useFocus.setState({ center: undefined });
	}, [memberId]);
	if (!member) return <CenteredMessage title={members.isPending ? '正在加载…' : '未找到该成员'} />;
	if (member.type === 'human') return <Navigate to={`/as/${member.memberId}`} replace />;
	if (member.purged) return <CenteredMessage title={`${member.name} 已彻底删除`} detail="时间线已删除，对话中的消息仍保留。" />;
	return <TimelineView key={member.memberId} memberId={member.memberId} mode="center" />;
}
