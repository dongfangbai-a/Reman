import { invalid } from '../common/errors.ts';
import type { EventHub } from '../common/events.ts';
import type { Database } from '../database/database.ts';
import type { Timeline } from '../timeline/timeline.ts';

/** 事项的状态：未开始、进行中、已完成。 */
export const PLAN_STATUSES = ['pending', 'in_progress', 'completed'] as const;
export type PlanStatus = typeof PLAN_STATUSES[number];

export interface IPlanItem {
	readonly text: string;
	readonly status: PlanStatus;
}

/** 成员现在的计划；没有更新过时 items 为空、updatedAt 为 null。全部完成后自动清空，items 不会全是已完成的。 */
export interface IPlan {
	readonly items: readonly IPlanItem[];
	readonly updatedAt: number | null;
}

/** 计划最多几项（包括已完成的），每项最多几个字：计划是提醒和概况，不是工作记录。 */
export const MAX_PLAN_ITEMS = 20;
export const MAX_PLAN_ITEM_LENGTH = 60;

/** 计划说明的开头：压缩后放回上下文时，下面接着计划原样的 JSON，和成员调用 update_plan 时写的一样。 */
export const PLAN_NOTE_HEAD = '上下文已整理。以下是你用 update_plan 写下的当前计划：';

/** 计划说明在上下文里的文字，不含编号。 */
export function planNoteText(items: readonly IPlanItem[]): string {
	return `${PLAN_NOTE_HEAD}\n${JSON.stringify({ items })}`;
}

/** 检查 update_plan 的 items 参数，返回去掉首尾空白后的事项。不合要求时报错，写明是第几项。 */
export function readPlanItems(value: unknown): IPlanItem[] {
	if (!Array.isArray(value)) throw invalid('items 必须是数组');
	if (value.length > MAX_PLAN_ITEMS) throw invalid(`计划最多 ${MAX_PLAN_ITEMS} 项，本次有 ${value.length} 项`);
	return value.map((item: unknown, index) => {
		const position = `第 ${index + 1} 项`;
		if (typeof item !== 'object' || item === null || Array.isArray(item)) throw invalid(`${position}必须是包含 text 和 status 的对象`);
		const { text, status } = item as Record<string, unknown>;
		if (typeof text !== 'string') throw invalid(`${position}的 text 必须是字符串`);
		const trimmed = text.trim();
		if (!trimmed) throw invalid(`${position}的 text 不能为空`);
		if (trimmed.length > MAX_PLAN_ITEM_LENGTH) throw invalid(`${position}有 ${trimmed.length} 字，每项最多 ${MAX_PLAN_ITEM_LENGTH} 字`);
		if (!PLAN_STATUSES.includes(status as PlanStatus)) throw invalid(`${position}的 status 只能是 ${PLAN_STATUSES.join('、')}`);
		return { text: trimmed, status: status as PlanStatus };
	});
}

interface IPlanRow {
	readonly items_json: string;
	readonly shown_item_id: number | null;
	readonly updated_at: number;
}

/**
 * 每个 AI 成员当前的计划（运行时设计第 5 部分「计划」）。上下文里没有固定的位置：平时就是成员最近一次 update_plan 调用的参数；
 * 压缩后那次调用看不到了、计划又没做完，才在时间线末尾放回一条计划说明。
 */
export class Plans {
	private readonly db: Database;
	private readonly events: EventHub;
	private readonly timeline: Timeline;

	constructor(db: Database, events: EventHub, timeline: Timeline) {
		this.db = db;
		this.events = events;
		this.timeline = timeline;
	}

	get(memberId: string): IPlan {
		const row = this.row(memberId);
		return row ? { items: JSON.parse(row.items_json) as IPlanItem[], updatedAt: row.updated_at } : { items: [], updatedAt: null };
	}

	/**
	 * 整份替换。shownItemId 是这份计划原文所在的时间线条目：直接调用时是这次调用，在脚本里调用时为 null。
	 * 所有事项都已完成时清空：做完了就没有当前的计划。
	 */
	update(memberId: string, items: readonly IPlanItem[], shownItemId: number | null): void {
		const current = items.every(item => item.status === 'completed') ? [] : items;
		this.db.transaction(() => {
			this.db.run(`
				INSERT INTO plans (member_id, items_json, shown_item_id, updated_at) VALUES (?, ?, ?, ?)
				ON CONFLICT (member_id) DO UPDATE SET items_json = excluded.items_json, shown_item_id = excluded.shown_item_id, updated_at = excluded.updated_at
			`, memberId, JSON.stringify(current), current.length > 0 ? shownItemId : null, Date.now());
			this.events.emit({ type: 'plan.changed', memberId });
		});
	}

	/**
	 * 用户在网页端清空计划：成员忘了更新时，计划不会一直挂着。在时间线末尾放一条变动说明告诉成员，不唤醒：
	 * 不说的话，它上下文里最近一次 update_plan 的参数还是旧计划，会以为计划还在。计划本来就是空的时不做什么。
	 */
	clear(memberId: string): void {
		this.db.transaction(() => {
			const row = this.row(memberId);
			if (!row || row.items_json === '[]') return;
			this.db.run('UPDATE plans SET items_json = ?, shown_item_id = NULL, updated_at = ? WHERE member_id = ?', '[]', Date.now(), memberId);
			this.timeline.appendChangeNotice(memberId, { text: '用户清空了你的计划。', brief: '用户清空了计划' });
			this.events.emit({ type: 'plan.changed', memberId });
		});
	}

	/**
	 * 压缩生效后、在同一个事务里调用：计划还有没完成的事项，而最近一份计划原文已经不在上下文里时，在时间线末尾放回一条计划说明，
	 * 之后它就是最近一份计划原文。只查记着的那一条，不翻时间线。
	 */
	restore(memberId: string): void {
		const row = this.row(memberId);
		if (!row) return;
		const items = JSON.parse(row.items_json) as IPlanItem[];
		// 清空了（全部完成时也清空）。
		if (items.length === 0) return;
		if (row.shown_item_id !== null && this.timeline.get(memberId, row.shown_item_id)?.contextState === 'visible') return;
		const itemId = this.timeline.appendPlan(memberId, items);
		this.db.run('UPDATE plans SET shown_item_id = ? WHERE member_id = ?', itemId, memberId);
	}

	private row(memberId: string): IPlanRow | undefined {
		return this.db.get<IPlanRow>('SELECT items_json, shown_item_id, updated_at FROM plans WHERE member_id = ?', memberId);
	}
}
