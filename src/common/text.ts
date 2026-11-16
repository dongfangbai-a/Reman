/** 文字太长时保留开头和结尾，中间注明省略了多少字。 */
export function clipMiddle(text: string, headChars: number, tailChars: number): string {
	if (text.length <= headChars + tailChars) return text;
	return `${text.slice(0, headChars)}\n\n……（中间省略 ${text.length - headChars - tailChars} 字）……\n\n${text.slice(-tailChars)}`;
}

/** 文字太长时只留开头，后面接「……」。 */
export function clipEnd(text: string, chars: number): string {
	return text.length > chars ? `${text.slice(0, chars)}……` : text;
}

/** 本地时间，写成 2026-10-30 10:25:54。 */
export function formatLocalTime(time: number): string {
	const date = new Date(time);
	const pad = (value: number) => String(value).padStart(2, '0');
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
