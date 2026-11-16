/** 调用方能看懂并据此修正的错误；message 是给人或模型看的中文说明。 */
export class RuntimeError extends Error {
	readonly code: string;
	readonly status: number;

	constructor(code: string, message: string, status = 400) {
		super(message);
		this.name = 'RuntimeError';
		this.code = code;
		this.status = status;
	}
}

export function notFound(message: string): RuntimeError {
	return new RuntimeError('not_found', message, 404);
}

export function forbidden(message: string): RuntimeError {
	return new RuntimeError('forbidden', message, 403);
}

export function invalid(message: string): RuntimeError {
	return new RuntimeError('invalid_argument', message, 400);
}

/** 错误的说明：Error 取 message，别的值转成字符串。 */
export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
