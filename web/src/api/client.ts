/** 运行时返回的错误，message 是可以直接给用户看的中文说明。 */
export class ApiError extends Error {
	readonly status: number;
	readonly code: string;

	constructor(status: number, code: string, message: string) {
		super(message);
		this.status = status;
		this.code = code;
	}
}

/** 调运行时的接口。body 是 Blob 时原样发送，其他按 JSON 发送。认证靠 Cookie（开发时由代理带令牌），不在这里处理。 */
export async function api<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
	let response: Response;
	try {
		const json = body !== undefined && !(body instanceof Blob);
		response = await fetch(path, {
			method,
			headers: json ? { 'Content-Type': 'application/json', ...headers } : headers,
			body: json ? JSON.stringify(body) : body as Blob | undefined,
		});
	} catch {
		throw new ApiError(0, 'network', '无法连接运行时');
	}
	return readResponse<T>(response.status, await response.text());
}

/** 上传一个附件，onProgress 收到 0 到 1 的进度。fetch 没有上传进度，所以用 XMLHttpRequest。 */
export function upload<T>(path: string, file: Blob, onProgress: (ratio: number) => void, signal: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		const request = new XMLHttpRequest();
		request.open('POST', path);
		request.upload.onprogress = event => event.lengthComputable && onProgress(event.loaded / event.total);
		request.onload = () => {
			try {
				resolve(readResponse<T>(request.status, request.responseText));
			} catch (error) {
				reject(error);
			}
		};
		request.onerror = () => reject(new ApiError(0, 'network', '无法连接运行时'));
		request.onabort = () => reject(new ApiError(0, 'aborted', '已取消'));
		signal.addEventListener('abort', () => request.abort());
		request.send(file);
	});
}

function readResponse<T>(status: number, text: string): T {
	let payload: unknown;
	try {
		payload = text ? JSON.parse(text) : {};
	} catch {
		throw new ApiError(status, 'invalid_response', '运行时返回的内容无法识别');
	}
	if (status >= 200 && status < 300) return payload as T;
	const error = (payload as { error?: { code?: string; message?: string } }).error;
	throw new ApiError(status, error?.code ?? 'unknown', error?.message ?? `请求失败（${status}）`);
}
