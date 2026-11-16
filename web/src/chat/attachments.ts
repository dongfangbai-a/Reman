import { upload } from '../api/client.ts';
import type { IAttachment } from '../api/types.ts';
import { formatSize } from '../lib/format.ts';

/** 和运行时的上限一致。 */
export const MAX_ATTACHMENTS = 10;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_FILE_BYTES = 50 * 1024 * 1024;

/** 输入框里待发的一个附件：加入时就开始上传。 */
export interface IDraftAttachment {
	readonly localId: string;
	readonly name: string;
	readonly size: number;
	readonly image: boolean;
	/** 图片的本地预览地址。 */
	readonly previewUrl: string | undefined;
	readonly status: 'uploading' | 'done' | 'failed';
	readonly progress: number;
	readonly attachmentId: string | undefined;
	readonly error: string | undefined;
}

/** 加入前检查上限；不通过时返回说明。 */
export function checkFile(file: File, count: number): string | undefined {
	if (count >= MAX_ATTACHMENTS) return `一次最多 ${MAX_ATTACHMENTS} 个附件`;
	if (file.size === 0) return `文件为空：${file.name}`;
	const image = file.type.startsWith('image/');
	const limit = image ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
	if (file.size > limit) return `${image ? '图片' : '文件'}过大，最大 ${formatSize(limit)}：${file.name}`;
	return undefined;
}

export function draftAttachment(file: File): IDraftAttachment {
	const image = file.type.startsWith('image/');
	return {
		localId: crypto.randomUUID(), name: file.name || '未命名', size: file.size, image,
		previewUrl: image ? URL.createObjectURL(file) : undefined, status: 'uploading', progress: 0, attachmentId: undefined, error: undefined,
	};
}

export function uploadAttachment(file: File, name: string, onProgress: (ratio: number) => void, signal: AbortSignal): Promise<IAttachment> {
	return upload<{ attachment: IAttachment }>(`/v1/attachments?name=${encodeURIComponent(name)}`, file, onProgress, signal).then(result => result.attachment);
}
