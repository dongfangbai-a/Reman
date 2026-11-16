export interface IDiffLine {
	readonly kind: 'add' | 'remove' | 'context' | 'hunk' | 'note';
	readonly text: string;
	readonly old?: number;
	readonly new?: number;
}

/** 文件头里这几行不显示：文件名已经在上面那一行了。改名、改权限、新建、删除这些照原样灰着写。 */
const HIDDEN_HEADERS = /^(diff --git |diff --cc |diff --combined |index |--- |\+\+\+ )/;

/**
 * 统一 diff 拆成行，算出每行原来和现在的行号。合并冲突时的 diff（@@@ 开头）有两列标记，不算行号。
 * Windows 换行的文件每行末尾带 \r，去掉。
 */
export function parseDiff(text: string): IDiffLine[] {
	const lines: IDiffLine[] = [];
	const raw = text.split('\n');
	if (raw.at(-1) === '') raw.pop();
	let inHunk = false;
	let combined = false;
	let old = 0;
	let now = 0;
	for (const value of raw) {
		const line = value.replace(/\r$/, '');
		const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
		if (hunk) {
			inHunk = true;
			combined = false;
			old = Number(hunk[1]);
			now = Number(hunk[2]);
			lines.push({ kind: 'hunk', text: line });
			continue;
		}
		if (line.startsWith('@@@')) {
			inHunk = true;
			combined = true;
			lines.push({ kind: 'hunk', text: line });
			continue;
		}
		if (line.startsWith('diff ')) inHunk = false;
		if (!inHunk) {
			if (!HIDDEN_HEADERS.test(line)) lines.push({ kind: 'note', text: line });
			continue;
		}
		if (line.startsWith('\\')) {
			lines.push({ kind: 'note', text: line });
		} else if (combined) {
			const marks = line.slice(0, 2);
			lines.push({ kind: marks.includes('+') ? 'add' : marks.includes('-') ? 'remove' : 'context', text: line });
		} else if (line.startsWith('+')) {
			lines.push({ kind: 'add', text: line, new: now++ });
		} else if (line.startsWith('-')) {
			lines.push({ kind: 'remove', text: line, old: old++ });
		} else {
			lines.push({ kind: 'context', text: line, old: old++, new: now++ });
		}
	}
	return lines;
}
