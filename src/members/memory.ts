import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EventHub } from '../common/events.ts';
import { invalid } from '../common/errors.ts';
import { MEMORY_FILE } from './definition.ts';
import type { Members } from './members.ts';

/** 记忆的上限（字符）。用工具修改时，改完超过它并且变长了就不改。 */
export const MEMORY_LIMIT = 3000;
/** 压缩时可以暂时超过上限，但不能超过这个兜底。 */
export const MEMORY_HARD_LIMIT = 6000;

export type MemoryOperation =
	| { readonly op: 'add'; readonly text: string }
	| { readonly op: 'replace'; readonly oldText: string; readonly newText: string };

/**
 * 成员自己记下的长期记忆，存在成员文件夹的 memory.md；数据库里另存一份，成员删除后恢复时用。
 * 上下文开头放的是快照：为了不打断缓存，只在压缩之后、用户改了记忆、运行时重启时按文件重新生成；
 * 成员自己用工具改的不刷新，改了什么它在那次工具调用里看得到。
 */
export class Memories {
	private readonly directory: string;
	private readonly members: Members;
	private readonly events: EventHub;
	private readonly snapshots = new Map<string, string>();
	/** 运行时最近一次写入或读到的文件内容，用来分辨文件是不是在运行时之外被改了。 */
	private readonly known = new Map<string, string>();

	constructor(directory: string, members: Members, events: EventHub) {
		this.directory = directory;
		this.members = members;
		this.events = events;
	}

	/** 记忆的当前内容，没有时是空字符串。 */
	read(memberId: string): string {
		return this.readFile(memberId);
	}

	/** 上下文开头用的快照。 */
	snapshot(memberId: string): string {
		let snapshot = this.snapshots.get(memberId);
		if (snapshot === undefined) {
			snapshot = this.readFile(memberId);
			this.snapshots.set(memberId, snapshot);
			this.known.set(memberId, snapshot);
		}
		return snapshot;
	}

	/** 下次用到快照时按文件重新生成。 */
	refresh(memberId: string): void {
		this.snapshots.delete(memberId);
	}

	/** 写入记忆，空内容删掉文件。refresh 为 true 时同时刷新快照（压缩、用户修改）；成员用工具改的不刷新。 */
	write(memberId: string, content: string, refresh: boolean): void {
		const text = normalize(content);
		const path = this.path(memberId);
		if (text) writeFileSync(path, `${text}\n`, 'utf8');
		else rmSync(path, { force: true });
		this.known.set(memberId, text);
		this.members.saveMemory(memberId, text);
		if (refresh) this.refresh(memberId);
		this.events.emit({ type: 'member.changed', memberId });
	}

	/** 成员文件夹同步之后调用：文件在运行时之外被改了（用户直接改文件），刷新快照。数据库里存的那份跟着更新。 */
	checkExternalChanges(): void {
		const active = new Set<string>();
		for (const member of this.members.list()) {
			if (member.type !== 'ai' || member.deleted) continue;
			const memberId = member.memberId;
			active.add(memberId);
			const content = this.readFile(memberId);
			this.members.saveMemory(memberId, content);
			const known = this.known.get(memberId);
			if (content === known) continue;
			this.known.set(memberId, content);
			if (known === undefined) continue;
			this.refresh(memberId);
			this.events.emit({ type: 'member.changed', memberId });
		}
		for (const memberId of [...this.known.keys()]) {
			if (active.has(memberId)) continue;
			this.known.delete(memberId);
			this.snapshots.delete(memberId);
		}
	}

	private readFile(memberId: string): string {
		try {
			return normalize(readFileSync(this.path(memberId), 'utf8'));
		} catch {
			return '';
		}
	}

	private path(memberId: string): string {
		return join(this.directory, this.members.requireAi(memberId).name, MEMORY_FILE);
	}
}

/** 对记忆执行一个修改，返回新内容。原文找不到或不止一处时报错，找不到时附上当前全文。 */
export function applyMemoryOperation(current: string, operation: MemoryOperation): string {
	if (operation.op === 'add') {
		const text = operation.text.trim();
		if (!text) throw invalid('text 不能为空');
		return current ? `${current}\n${text}` : text;
	}
	const { oldText, newText } = operation;
	if (!oldText.trim()) throw invalid('old_text 不能为空');
	const index = current.indexOf(oldText);
	if (index < 0) throw invalid(current ? `记忆中未找到 old_text 的原文。记忆的当前内容：\n${current}` : '记忆当前为空，没有可替换的内容');
	if (current.indexOf(oldText, index + 1) >= 0) throw invalid('old_text 在记忆中出现了多处，请提供更多原文，使其只匹配一处');
	let end = index + oldText.length;
	// 删掉整行时连同换行一起删，不留空行。
	if (!newText && (index === 0 || current[index - 1] === '\n') && current[end] === '\n') end++;
	return normalize(current.slice(0, index) + newText + current.slice(end));
}

/** 用工具修改时的上限检查：改完超过上限并且比原来长才拒绝，超限后缩短的修改仍然可以做。 */
export function checkMemoryLimit(current: string, next: string): void {
	if (next.length > MEMORY_LIMIT && next.length > current.length) {
		throw invalid(`修改后记忆将有 ${next.length} 字，超过上限 ${MEMORY_LIMIT} 字，未做修改。记忆当前 ${current.length} 字，可先删减或合并已有的内容。`);
	}
}

/** 写给成员看的字数说明。 */
export function memoryLength(text: string): string {
	return text.length > MEMORY_LIMIT
		? `记忆当前 ${text.length} 字，超过上限 ${MEMORY_LIMIT} 字。`
		: `记忆当前 ${text.length} 字，上限 ${MEMORY_LIMIT} 字。`;
}

function normalize(text: string): string {
	return text.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
