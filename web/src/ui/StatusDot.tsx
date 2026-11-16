import clsx from 'clsx';
import type { MemberStatus } from '../api/types.ts';

export const STATUS_LABELS: Record<MemberStatus, string> = {
	idle: '空闲',
	running: '运行中',
	waiting_approval: '等待审批',
	paused: '已暂停',
	failed: '因出错停止',
	interrupted: '运行中断',
};

const COLORS: Record<MemberStatus, string> = {
	idle: '',
	running: 'bg-success',
	waiting_approval: 'bg-attention',
	paused: 'bg-fg-3',
	failed: 'bg-danger',
	interrupted: 'bg-fg-3',
};

/** 成员状态圆点，空闲不显示。放在头像上时由调用方加 ring 和底色隔开。 */
export function StatusDot({ status, className }: { status: MemberStatus | undefined; className?: string }) {
	if (!status || status === 'idle') return null;
	return <span title={STATUS_LABELS[status]} className={clsx('status-dot', COLORS[status], className)} />;
}
