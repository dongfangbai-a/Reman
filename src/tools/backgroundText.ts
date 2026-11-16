/** 后台任务给成员看的文字：转后台时的返回和查看后台任务时共用，写法一致。 */

/** 最近的输出最多几行、多少字。 */
export const RECENT_LINES = 20;
const RECENT_CHARS = 2000;

/** 最后几行，最多多少字；没有执行中的输出时是 null。 */
export function recentOutput(output: string | undefined): string | null {
	if (output === undefined) return null;
	const lines = output.trimEnd().split('\n').slice(-RECENT_LINES).join('\n');
	return lines.length > RECENT_CHARS ? `…${lines.slice(-RECENT_CHARS)}` : lines;
}

/** 4s、1m3s、2h4m5s。 */
export function compactDuration(seconds: number): string {
	const h = Math.floor(seconds / 3600);
	const m = Math.floor(seconds % 3600 / 60);
	const s = seconds % 60;
	return h ? `${h}h${m}m${s}s` : m ? `${m}m${s}s` : `${s}s`;
}
