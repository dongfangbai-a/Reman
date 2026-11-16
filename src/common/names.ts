import { invalid } from './errors.ts';

/** 群聊里点名所有人时用的保留名，成员不能用它做名字。 */
export const ALL_MEMBERS_NAME = '所有人';

const MEMBER_NAME_MAX_WEIGHT = 20;
const GROUP_NAME_MAX_WEIGHT = 48;

/** 成员名：中文、英文字母、点号、横杠、下划线；最多约 5 个中文或 20 个英文。 */
export function assertMemberName(name: string): void {
	if (!name.trim()) throw invalid('成员名不能为空');
	if (name.trim() !== name) throw invalid(`成员名「${name}」首尾不能有空格`);
	if (name === ALL_MEMBERS_NAME) throw invalid(`「${name}」是系统保留名称，不能用作成员名`);
	if (![...name].every(char => isLetter(char) || isCjk(char) || '.-_'.includes(char))) {
		throw invalid(`成员名「${name}」含不支持的字符，只能使用中文、英文字母、点号、横杠、下划线`);
	}
	if (weight(name) > MEMBER_NAME_MAX_WEIGHT) throw invalid(`成员名「${name}」过长，最长约 5 个汉字或 20 个英文字母`);
	if (name.startsWith('.') || name.endsWith('.')) throw invalid(`成员名「${name}」不能以点号开头或结尾`);
}

/** 群聊名：中文、英文字母、数字、点号、横杠、下划线；最多约 12 个中文或 48 个英文。 */
export function assertGroupName(name: string): void {
	if (!name.trim()) throw invalid('群聊名不能为空');
	if (name.trim() !== name) throw invalid(`群聊名「${name}」首尾不能有空格`);
	if (![...name].every(char => isLetter(char) || isCjk(char) || (char >= '0' && char <= '9') || '.-_'.includes(char))) {
		throw invalid(`群聊名「${name}」含不支持的字符，只能使用中文、英文字母、数字、点号、横杠、下划线`);
	}
	if (weight(name) > GROUP_NAME_MAX_WEIGHT) throw invalid(`群聊名「${name}」过长，最长约 12 个汉字或 48 个英文字母`);
}

const MEMBER_DESCRIPTION_MAX_WEIGHT = 120;

/** 成员备注：一行，最多约 30 个中文或 120 个英文。有问题时返回说明。 */
export function memberDescriptionProblem(description: string): string | undefined {
	if (/[\r\n]/.test(description)) return '备注不能换行';
	if (weight(description) > MEMBER_DESCRIPTION_MAX_WEIGHT) return '备注过长，最长约 30 个汉字或 120 个英文字母';
	return undefined;
}

/** 中日韩字符按 4 个英文字符计。 */
function weight(name: string): number {
	let total = 0;
	for (const char of name) {
		const code = char.charCodeAt(0);
		total += code >= 0x20 && code <= 0x7E ? 1 : 4;
	}
	return total;
}

function isLetter(char: string): boolean {
	return /^[A-Za-z]$/.test(char);
}

function isCjk(char: string): boolean {
	const code = char.codePointAt(0) ?? 0;
	return (code >= 0x3400 && code <= 0x4DBF)
		|| (code >= 0x4E00 && code <= 0x9FFF)
		|| (code >= 0xF900 && code <= 0xFAFF)
		|| (code >= 0x20000 && code <= 0x2EBEF)
		|| (code >= 0x3040 && code <= 0x30FF)
		|| (code >= 0xAC00 && code <= 0xD7AF);
}
