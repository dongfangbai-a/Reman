/** 报错的文字：Error 取 message，别的转成字符串。 */
export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
