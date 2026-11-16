import { rmSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import type { EventHub } from '../common/events.ts';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema.ts';

/**
 * 准备好的语句最多留这么多条。SQL 大多是写死的，几百条以内；按 IN 列表长度拼出来的会有很多种，靠这个上限挡住。
 */
const STATEMENT_CACHE_SIZE = 500;

/**
 * SQLite 是唯一的持久事实。node:sqlite 是同步接口，运行时单进程，直接同步读写。
 * 写操作都放在 transaction 里，事件在提交后才发布。
 */
export class Database {
	private readonly db: DatabaseSync;
	private readonly events: EventHub;
	private depth = 0;
	/** 按 SQL 记下准备好的语句，同一条不用每次重新编译（每次 3–20 微秒，成员页概览这样的一次要调几百条）。最近用过的排在最后。 */
	private readonly statements = new Map<string, StatementSync>();

	private constructor(db: DatabaseSync, events: EventHub) {
		this.db = db;
		this.events = events;
	}

	/** 打开数据库；表结构版本对不上时删掉重建（开发阶段不做迁移）。传 ':memory:' 用于测试。 */
	static open(path: string, events: EventHub): Database {
		let db = new DatabaseSync(path);
		const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
		const hasTables = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' LIMIT 1`).get() !== undefined;
		if (hasTables && version !== SCHEMA_VERSION) {
			db.close();
			for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
			db = new DatabaseSync(path);
		}
		db.exec('PRAGMA foreign_keys = ON');
		if (path !== ':memory:') {
			db.exec('PRAGMA journal_mode = WAL');
			// 提交时不等写盘：默认的 FULL 每次提交约 2 毫秒，同步接口下主线程一直在等，脚本里同时调几百次工具时会卡住一秒多。
			// WAL 下 NORMAL 库不会损坏；运行时崩溃不丢数据，只有系统崩溃、断电时可能丢最后几次提交。
			db.exec('PRAGMA synchronous = NORMAL');
		}
		if (!hasTables || version !== SCHEMA_VERSION) {
			db.exec('BEGIN');
			db.exec(SCHEMA_SQL);
			db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
			db.exec('COMMIT');
		}
		return new Database(db, events);
	}

	get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
		return this.statement(sql).get(...params) as T | undefined;
	}

	all<T>(sql: string, ...params: SQLInputValue[]): T[] {
		return this.statement(sql).all(...params) as T[];
	}

	run(sql: string, ...params: SQLInputValue[]): { changes: number; lastId: number } {
		const result = this.statement(sql).run(...params);
		return { changes: Number(result.changes), lastId: Number(result.lastInsertRowid) };
	}

	private statement(sql: string): StatementSync {
		let statement = this.statements.get(sql);
		if (statement) {
			this.statements.delete(sql);
		} else {
			statement = this.db.prepare(sql);
			if (this.statements.size >= STATEMENT_CACHE_SIZE) this.statements.delete(this.statements.keys().next().value!);
		}
		this.statements.set(sql, statement);
		return statement;
	}

	/** 在事务里执行 fn。可以嵌套，只有最外层真正提交；fn 抛错时整体回滚、事件丢弃。 */
	transaction<T>(fn: () => T): T {
		if (this.depth > 0) {
			this.depth++;
			try {
				return fn();
			} finally {
				this.depth--;
			}
		}
		this.depth = 1;
		this.events.beginBatch();
		this.db.exec('BEGIN IMMEDIATE');
		let committed = false;
		try {
			const result = fn();
			this.db.exec('COMMIT');
			committed = true;
			return result;
		} finally {
			if (!committed) this.db.exec('ROLLBACK');
			this.depth = 0;
			this.events.endBatch(committed);
		}
	}

	close(): void {
		this.db.close();
	}
}
