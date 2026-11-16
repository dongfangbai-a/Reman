import type { EventHub } from '../common/events.ts';
import { invalid, notFound } from '../common/errors.ts';
import type { Database } from '../database/database.ts';

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled';

export interface IApproval {
	readonly approvalId: number;
	readonly memberId: string;
	readonly runId: number;
	readonly callId: string;
	/** run_tool_script 脚本里的第几次工具调用；直接调用时为 null。 */
	readonly nestedIndex: number | null;
	readonly toolName: string;
	readonly arguments: unknown;
	/** 工具按审批方式 auto 判断出来的短原因，不复述调用要做什么；ask 策略下每次都审批，没有原因。 */
	readonly reasons: readonly string[];
	/** 受保护的原因：改运行时的数据、读令牌和密钥。不为空时只能允许这一次。 */
	readonly protectedReasons: readonly string[];
	readonly status: ApprovalStatus;
	readonly reason: string | null;
	readonly createdAt: number;
	readonly expiresAt: number;
	readonly decidedAt: number | null;
}

/**
 * once：只允许这一次；code：这段脚本里这个工具都允许（只用于脚本里的调用）；
 * run：这次运行里这个工具都允许，同一次运行里这个工具其他在等的审批一起通过；
 * terminal：这个成员往这个终端里的输入都允许，到终端关闭为止（只用于有审批原因的终端调用）。
 * 受保护的调用只能 once。
 */
export type ApprovalScope = 'once' | 'code' | 'run' | 'terminal';

const SCOPES: readonly ApprovalScope[] = ['once', 'code', 'run', 'terminal'];

export type ApprovalDecision = { readonly approved: true; readonly scope: ApprovalScope } | { readonly approved: false; readonly message: string };

export interface IApprovalRequest {
	readonly memberId: string;
	readonly runId: number;
	readonly callId: string;
	readonly nestedIndex: number | null;
	readonly toolName: string;
	readonly args: unknown;
	readonly reasons: readonly string[];
	readonly protectedReasons: readonly string[];
	/** 「本次运行中允许此工具」按什么记，见 Tools.approvalKey。 */
	readonly runKey: string;
}

interface IApprovalRow {
	readonly approval_id: number;
	readonly member_id: string;
	readonly run_id: number;
	readonly call_id: string;
	readonly nested_index: number | null;
	readonly tool_name: string;
	readonly arguments_json: string;
	readonly reasons_json: string;
	readonly protected_reasons_json: string;
	readonly status: ApprovalStatus;
	readonly reason: string | null;
	readonly created_at: number;
	readonly expires_at: number;
	readonly decided_at: number | null;
}

interface IWaiter {
	readonly runId: number;
	readonly runKey: string;
	readonly nested: boolean;
	readonly protected: boolean;
	/** 终端按 auto 要审批的调用，能选「这个终端里都允许」。 */
	readonly terminal: boolean;
	readonly resolve: (decision: ApprovalDecision) => void;
	readonly timer: NodeJS.Timeout;
}

/** 等用户审批的工具调用。等待期间这次运行停在这里；超时没人处理就自动拒绝。 */
export class Approvals {
	private readonly db: Database;
	private readonly events: EventHub;
	private readonly timeoutMs: number;
	private readonly waiters = new Map<number, IWaiter>();

	constructor(db: Database, events: EventHub, timeoutMs: number) {
		this.db = db;
		this.events = events;
		this.timeoutMs = timeoutMs;
	}

	/** 运行时启动时，上次没处理完的审批都作废：那些运行已经中断了。 */
	recover(): void {
		this.db.run(`UPDATE approvals SET status = 'cancelled', decided_at = ? WHERE status = 'pending'`, Date.now());
	}

	/** 请求审批并等待结果。运行被中止时审批作废，抛出中止错误。 */
	request(input: IApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision> {
		const { memberId, runId, callId, nestedIndex, toolName, args, reasons, protectedReasons, runKey } = input;
		const isProtected = protectedReasons.length > 0;
		signal.throwIfAborted();
		return new Promise<ApprovalDecision>((resolve, reject) => {
			let approvalId = 0;
			const onAbort = () => {
				this.finish(approvalId, 'cancelled', null);
				reject(signal.reason);
			};
			signal.addEventListener('abort', onAbort, { once: true });
			// 先登记等待，再提交事务发出通知：收到通知立刻审批也不会落空。
			approvalId = this.db.transaction(() => {
				const now = Date.now();
				const id = this.db.run(`
					INSERT INTO approvals (member_id, run_id, call_id, nested_index, tool_name, arguments_json, reasons_json, protected_reasons_json, status, created_at, expires_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
				`, memberId, runId, callId, nestedIndex, toolName, JSON.stringify(args), JSON.stringify(reasons), JSON.stringify(protectedReasons), now, now + this.timeoutMs).lastId;
				const timer = setTimeout(() => this.finish(id, 'expired', null), this.timeoutMs);
				this.waiters.set(id, {
					runId,
					runKey,
					nested: nestedIndex !== null,
					protected: isProtected,
					terminal: toolName === 'terminal' && reasons.length > 0,
					resolve: decision => {
						signal.removeEventListener('abort', onAbort);
						resolve(decision);
					},
					timer,
				});
				this.events.emit({ type: 'approval.changed', memberId, approvalId: id });
				return id;
			});
		});
	}

	approve(approvalId: number, scope: ApprovalScope = 'once'): void {
		if (!SCOPES.includes(scope)) throw invalid('scope 只能是 once、code、run 或 terminal');
		const waiter = this.waiters.get(approvalId);
		if (scope === 'code' && waiter?.nested === false) throw invalid('只有脚本中的调用才能选择「允许本脚本中的所有调用」');
		if (scope === 'terminal' && waiter?.terminal === false) throw invalid('只有须审批的终端调用才能选择「允许该终端中的所有输入」');
		if (scope !== 'once' && waiter?.protected) throw invalid('修改运行时数据的调用只能允许本次');
		this.decide(approvalId, 'approved', null, scope);
		if (scope !== 'run' || !waiter) return;
		// 一轮里并行发出的调用可能同时在等：同一次运行里这个工具其他不受保护的审批一起通过。
		for (const [otherId, other] of [...this.waiters]) {
			if (other.runId === waiter.runId && other.runKey === waiter.runKey && !other.protected) this.finish(otherId, 'approved', null, 'run');
		}
	}

	deny(approvalId: number, reason: string | null): void {
		this.decide(approvalId, 'denied', reason?.trim() || null);
	}

	/** 条件按需拼上，不写成 (? IS NULL OR ...)：那样用不上索引，每次都扫整张表。 */
	list(options: { readonly memberId?: string; readonly pendingOnly?: boolean } = {}): IApproval[] {
		const conditions = [...options.memberId === undefined ? [] : ['member_id = ?'], ...options.pendingOnly ? ["status = 'pending'"] : []];
		return this.db.all<IApprovalRow>(`
			SELECT * FROM approvals ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
			ORDER BY approval_id DESC LIMIT 200
		`, ...options.memberId === undefined ? [] : [options.memberId]).map(toApproval);
	}

	hasPending(memberId: string): boolean {
		return this.db.get(`SELECT 1 FROM approvals WHERE member_id = ? AND status = 'pending' LIMIT 1`, memberId) !== undefined;
	}

	private decide(approvalId: number, status: 'approved' | 'denied', reason: string | null, scope: ApprovalScope = 'once'): void {
		const row = this.db.get<{ status: ApprovalStatus }>('SELECT status FROM approvals WHERE approval_id = ?', approvalId);
		if (!row) throw notFound(`审批不存在：${approvalId}`);
		if (row.status !== 'pending' || !this.waiters.has(approvalId)) throw invalid('该审批已处理');
		this.finish(approvalId, status, reason, scope);
	}

	private finish(approvalId: number, status: Exclude<ApprovalStatus, 'pending'>, reason: string | null, scope: ApprovalScope = 'once'): void {
		const waiter = this.waiters.get(approvalId);
		if (!waiter) return;
		this.waiters.delete(approvalId);
		clearTimeout(waiter.timer);
		this.db.transaction(() => {
			const memberId = this.db.get<{ member_id: string }>('SELECT member_id FROM approvals WHERE approval_id = ?', approvalId)!.member_id;
			this.db.run('UPDATE approvals SET status = ?, reason = ?, decided_at = ? WHERE approval_id = ?', status, reason, Date.now(), approvalId);
			this.events.emit({ type: 'approval.changed', memberId, approvalId });
		});
		if (status === 'approved') {
			waiter.resolve({ approved: true, scope });
		} else if (status === 'denied') {
			waiter.resolve({ approved: false, message: reason ? `用户拒绝了本次调用，理由：${reason}` : '用户拒绝了本次调用。' });
		} else if (status === 'expired') {
			waiter.resolve({ approved: false, message: '审批超时，已自动拒绝。' });
		}
	}
}

function toApproval(row: IApprovalRow): IApproval {
	return {
		approvalId: row.approval_id, memberId: row.member_id, runId: row.run_id, callId: row.call_id, nestedIndex: row.nested_index, toolName: row.tool_name,
		arguments: JSON.parse(row.arguments_json), reasons: JSON.parse(row.reasons_json), protectedReasons: JSON.parse(row.protected_reasons_json), status: row.status, reason: row.reason,
		createdAt: row.created_at, expiresAt: row.expires_at, decidedAt: row.decided_at,
	};
}
