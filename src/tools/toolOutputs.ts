import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { clipMiddle, formatLocalTime } from '../common/text.ts';

/**
 * 过长的工具结果：保留开头和结尾，完整内容存成 directory 下的文件，说明里写明路径；存不了时只注明省略了多少字。
 * directory 用到时才建。
 */
export function clipToFile(text: string, headChars: number, tailChars: number, directory: string, toolName: string): string {
	if (text.length <= headChars + tailChars) return text;
	let path: string;
	try {
		path = saveText(directory, toolName, text);
	} catch {
		return clipMiddle(text, headChars, tailChars);
	}
	return `${text.slice(0, headChars)}\n\n……（中间省略 ${text.length - headChars - tailChars} 字，完整内容已保存到 ${path}）……\n\n${text.slice(-tailChars)}`;
}

/** 存成 <时间>-<工具名>-<随机>.txt，按时间排得开，同一毫秒的也不重名。 */
function saveText(directory: string, toolName: string, text: string): string {
	mkdirSync(directory, { recursive: true });
	const time = formatLocalTime(Date.now()).replace(/[-:]/g, '').replace(' ', '-');
	const path = join(directory, `${time}-${toolName}-${randomBytes(3).toString('hex')}.txt`);
	writeFileSync(path, text);
	return path;
}
