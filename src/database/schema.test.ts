import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SCHEMA_SQL } from './schema.ts';

/** 代码里会删除行的表：彻底删除成员删的那些、成员页的分组、定时。加了新的删除要补到这里。 */
const DELETED_TABLES = [
	'approvals', 'code_calls', 'tasks', 'plans', 'timeline_items', 'model_requests', 'runs', 'member_states', 'tool_policies',
	'reminders', 'conversation_reads', 'timeline_views', 'member_section_members', 'member_sections',
];

test('会删除行的表，引用它的外键列都有索引：不然每删一行都要把引用它的表整个扫一遍', () => {
	const db = new DatabaseSync(':memory:');
	db.exec(SCHEMA_SQL);
	const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map(row => String(row['name']));
	const missing: string[] = [];
	for (const table of tables) {
		const indexed = new Set(db.prepare(`
			SELECT info.name FROM pragma_index_list(?) AS list, pragma_index_info(list.name) AS info WHERE info.seqno = 0
		`).all(table).map(row => String(row['name'])));
		for (const key of db.prepare('SELECT "table" AS parent, "from" AS child FROM pragma_foreign_key_list(?)').all(table)) {
			if (DELETED_TABLES.includes(String(key['parent'])) && !indexed.has(String(key['child']))) missing.push(`${table}.${String(key['child'])}`);
		}
	}
	db.close();
	assert.deepEqual(missing, []);
});
