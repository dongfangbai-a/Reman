const pad = (value: number) => String(value).padStart(2, '0');

/** 今天的只显示时:分:秒，今年的显示月-日 时:分:秒，更早的带年份。 */
export function shortTime(time: number, now = Date.now()): string {
	const date = new Date(time);
	const today = new Date(now);
	const clock = clockTime(time);
	if (date.toDateString() === today.toDateString()) return clock;
	const day = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
	return date.getFullYear() === today.getFullYear() ? `${day} ${clock}` : `${date.getFullYear()}-${day} ${clock}`;
}

/** 只有时:分:秒，不带日期。合并的连续消息用：日期看同组第一条。 */
export function clockTime(time: number): string {
	const date = new Date(time);
	return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 对话列表里的时间：今天显示时:分，其他只显示日期。 */
export function listTime(time: number, now = Date.now()): string {
	const date = new Date(time);
	const today = new Date(now);
	if (date.toDateString() === today.toDateString()) return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
	const day = `${date.getMonth() + 1}-${date.getDate()}`;
	return date.getFullYear() === today.getFullYear() ? day : `${date.getFullYear()}-${day}`;
}

export function fullTime(time: number): string {
	const date = new Date(time);
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** token 数：不到 1000 原样，再大写成 41.2k、1.2M，整数时不带小数。先取整再定单位：999999 是 1M，不是 1000k。 */
export function formatTokens(count: number): string {
	if (count < 1000) return String(count);
	const kilo = Number((count / 1000).toFixed(1));
	if (kilo < 1000) return `${kilo}k`;
	return `${Number((count / 1_000_000).toFixed(1))}M`;
}

/** 百分比：整数时不带小数（75%），有小数时保留两位（86.89%）。传的是 0 到 1 的比例。 */
export function formatPercent(ratio: number): string {
	const percent = ratio * 100;
	return Number.isInteger(percent) ? `${percent}%` : `${percent.toFixed(2)}%`;
}

/** 文件大小。先取整再定单位：差一点到 1 MB 的写 1.0 MB，不写 1024.0 KB。 */
export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const kilo = (bytes / 1024).toFixed(1);
	if (Number(kilo) < 1024) return `${kilo} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 「11 月 2 日 17:40」，不是今年的带上年份。 */
export function dayTime(time: number, now = Date.now()): string {
	const date = new Date(time);
	const day = `${date.getMonth() + 1} 月 ${date.getDate()} 日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
	return date.getFullYear() === new Date(now).getFullYear() ? day : `${date.getFullYear()} 年 ${day}`;
}

/** 运行用时：「42 秒」「3 分 12 秒」「1 小时 5 分」；不到 1 秒写「不到 1 秒」。 */
export function elapsedText(ms: number): string {
	if (ms < 1000) return '不到 1 秒';
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds} 秒`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return seconds % 60 ? `${minutes} 分 ${seconds % 60} 秒` : `${minutes} 分`;
	return minutes % 60 ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分` : `${Math.floor(minutes / 60)} 小时`;
}

/** 后台任务的耗时：4s、1m3s、2h4m5s，一眼看懂，不占地方。 */
export function compactDuration(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	const h = Math.floor(seconds / 3600);
	const m = Math.floor(seconds % 3600 / 60);
	const s = seconds % 60;
	return h ? `${h}h${m}m${s}s` : m ? `${m}m${s}s` : `${s}s`;
}

/** 第一行不是空白的内容，去掉首尾空白。 */
export function firstLine(text: string): string {
	return text.split('\n').find(line => line.trim())?.trim() ?? '';
}
