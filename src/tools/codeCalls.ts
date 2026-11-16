import type { EventHub } from '../common/events.ts';
import type { Database } from '../database/database.ts';

export type CodeCallStatus = 'running' | 'completed' | 'failed';

export interface ICodeCall {
	readonly callIndex: number;
	readonly toolName: string;
	readonly arguments: unknown;
	readonly status: CodeCallStatus;
	readonly output: string | null;
	readonly startedAt: number;
	readonly endedAt: number | null;
}

interface ICodeCallRow {
	readonly call_index: number;
	readonly tool_name: string;
	readonly arguments_json: string;
	readonly status: CodeCallStatus;
	readonly output: string | null;
	readonly started_at: number;
	readonly ended_at: number | null;
}

/** run_tool_script 脚本里每一次工具调用的记录。 */
export class CodeCalls {
	private readonly db: Database;
	private readonly events: EventHub;

	constructor(db: Database, events: EventHub) {
		this.db = db;
		this.events = events;
	}

	start(memberId: string, runId: number, callId: string, callIndex: number, toolName: string, args: unknown): void {
		this.db.transaction(() => {
			this.db.run(`
				INSERT INTO code_calls (member_id, run_id, call_id, call_index, tool_name, arguments_json, status, started_at)
				VALUES (?, ?, ?, ?, ?, ?, 'running', ?)
			`, memberId, runId, callId, callIndex, toolName, JSON.stringify(args), Date.now());
			this.events.emit({ type: 'codeCall.changed', memberId, runId, callId, callIndex });
		});
	}

	finish(memberId: string, runId: number, callId: string, callIndex: number, status: 'completed' | 'failed', output: string): void {
		this.db.transaction(() => {
			this.db.run('UPDATE code_calls SET status = ?, output = ?, ended_at = ? WHERE run_id = ? AND call_id = ? AND call_index = ?',
				status, output, Date.now(), runId, callId, callIndex);
			this.events.emit({ type: 'codeCall.changed', memberId, runId, callId, callIndex });
		});
	}

	list(runId: number, callId: string): ICodeCall[] {
		return this.db.all<ICodeCallRow>('SELECT * FROM code_calls WHERE run_id = ? AND call_id = ? ORDER BY call_index', runId, callId).map(row => ({
			callIndex: row.call_index, toolName: row.tool_name, arguments: JSON.parse(row.arguments_json), status: row.status,
			output: row.output, startedAt: row.started_at, endedAt: row.ended_at,
		}));
	}

	/** 运行时启动时，上次没执行完的调用都算失败：那些脚本已经中断了。 */
	recover(): void {
		this.db.run(`UPDATE code_calls SET status = 'failed', output = '运行时重启，调用中断', ended_at = ? WHERE status = 'running'`, Date.now());
	}
}
