import { extname } from 'node:path';

const TEXT = 'text/plain';

/** 按扩展名定的类型，本机文件预览和附件共用。文本类的都是 UTF-8；代码按纯文本，网页端按扩展名高亮。 */
const MIME_TYPES: Record<string, string> = {
	'.md': 'text/markdown', '.markdown': 'text/markdown', '.html': 'text/html', '.htm': 'text/html',
	'.txt': TEXT, '.log': TEXT, '.csv': 'text/csv', '.json': 'application/json', '.xml': 'application/xml',
	'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
	'.ico': 'image/x-icon', '.avif': 'image/avif', '.svg': 'image/svg+xml',
	'.pdf': 'application/pdf',
	'.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac', '.opus': 'audio/ogg',
	'.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.ogv': 'video/ogg', '.mov': 'video/quicktime',
	'.zip': 'application/zip', '.gz': 'application/gzip', '.exe': 'application/octet-stream', '.dll': 'application/octet-stream',
	'.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	'.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	'.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/** 按扩展名定的类型，认不出时 undefined。 */
export function mimeType(path: string): string | undefined {
	return MIME_TYPES[extname(path).toLowerCase()];
}
