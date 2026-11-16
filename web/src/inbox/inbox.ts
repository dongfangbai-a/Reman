import { usePendingApprovals } from '../api/member.ts';
import { useTerminals } from '../api/system.ts';
import type { IApproval, ITerminalInfo } from '../api/types.ts';

/** 概况栏的待处理里的一项：等你审批的调用，或者成员请你接管终端。 */
export type InboxItem =
	| { readonly kind: 'approval'; readonly key: string; readonly memberId: string; readonly at: number; readonly approval: IApproval }
	| { readonly kind: 'takeover'; readonly key: string; readonly memberId: string; readonly at: number; readonly terminalId: string; readonly request: string };

/** 要你处理的事，按时间排。接管请求只算还在运行的终端：退出后交不出去，请求也就没用了。 */
export function useInbox(): { readonly items: readonly InboxItem[]; readonly isPending: boolean; readonly error: Error | null } {
	const approvals = usePendingApprovals();
	const terminals = useTerminals();
	const items: InboxItem[] = [
		...(approvals.data ?? []).map(approval => ({ kind: 'approval' as const, key: `approval-${approval.approvalId}`, memberId: approval.memberId, at: approval.createdAt, approval })),
		...(terminals.data ?? []).flatMap(terminal => takeoverItems(terminal)),
	];
	items.sort((left, right) => left.at - right.at);
	return { items, isPending: approvals.isPending || terminals.isPending, error: approvals.error ?? terminals.error };
}

function takeoverItems(terminal: ITerminalInfo): InboxItem[] {
	if (terminal.status !== 'running') return [];
	return terminal.takeoverRequests.map(({ memberId, request, requestedAt }) => ({
		kind: 'takeover' as const, key: `takeover-${terminal.terminalId}-${memberId}`, memberId, at: requestedAt, terminalId: terminal.terminalId, request,
	}));
}
