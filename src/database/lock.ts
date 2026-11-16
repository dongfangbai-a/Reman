import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isRecord } from '../common/json.ts';

/**
 * 抢不到锁时最多等这么久再下结论：上一个运行时刚退出时，系统放锁、SQLite 回滚热日志都还要一点时间；
 * 用 npm start 时 Ctrl+C 也可能先杀掉外层，里面那个进程过一会儿才退。
 */
const WAIT_MS = 3000;
const RETRY_MS = 100;

/**
 * 数据目录的排他锁：一个数据目录同一时间只允许一个运行时。
 * 借用 SQLite 的独占锁（操作系统级文件锁），进程退出（包括崩溃）时由系统自动释放。
 */
export class DataDirectoryLock {
	private readonly db: DatabaseSync;
	private released = false;

	private constructor(db: DatabaseSync) {
		this.db = db;
	}

	static async acquire(dataDirectory: string): Promise<DataDirectoryLock> {
		const path = join(dataDirectory, 'runtime.lock');
		const deadline = Date.now() + WAIT_MS;
		for (;;) {
			const db = new DatabaseSync(path, { timeout: 0 });
			try {
				db.exec('PRAGMA locking_mode = EXCLUSIVE');
				db.exec('BEGIN EXCLUSIVE');
				return new DataDirectoryLock(db);
			} catch {
				db.close();
				if (Date.now() >= deadline) throw new Error(describeHolder(dataDirectory));
				await delay(RETRY_MS);
			}
		}
	}

	release(): void {
		if (this.released) return;
		this.released = true;
		try {
			this.db.exec('ROLLBACK');
		} finally {
			this.db.close();
		}
	}
}

/** 占着锁的是谁：从上次写的 runtime.json 里取进程号和端口，好让人知道该结束哪个进程。 */
function describeHolder(dataDirectory: string): string {
	const file = join(dataDirectory, 'runtime.json');
	const holder = readHolder(file);
	if (!holder) return `数据目录 ${dataDirectory} 已被另一个运行时占用`;
	if (!isAlive(holder.pid)) return `数据目录 ${dataDirectory} 已被另一个运行时占用：上一次的进程 ${holder.pid} 已经不在了，锁还没放开，过几秒再启动一次`;
	return `数据目录 ${dataDirectory} 已被另一个运行时占用（runtime.json 里记的进程 ${holder.pid} 还在运行，端口 ${holder.port ?? '?'}）。要结束它：taskkill /pid ${holder.pid} /f`;
}

function readHolder(file: string): { pid: number; port?: number } | undefined {
	try {
		if (!existsSync(file)) return undefined;
		const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
		if (!isRecord(parsed) || typeof parsed.pid !== 'number' || parsed.pid <= 0) return undefined;
		return typeof parsed.port === 'number' ? { pid: parsed.pid, port: parsed.port } : { pid: parsed.pid };
	} catch {
		return undefined;
	}
}

/** pid 这个进程还在不在（没有权限看别的用户的进程也算在）。 */
function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
}

async function delay(ms: number): Promise<void> {
	await new Promise(resolve => setTimeout(resolve, ms));
}
