import { readFileSync, statSync, type Stats } from 'node:fs';
import { extname } from 'node:path';
import { invalid, notFound } from '../common/errors.ts';
import { newId, wrongKind } from '../common/ids.ts';
import { mimeType } from '../common/mime.ts';
import type { Database } from '../database/database.ts';
import { detectImage, type Resources } from '../resources/resources.ts';

export const MAX_ATTACHMENTS = 10;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_NAME_LENGTH = 200;

/** 图片会放进收到的人的上下文；其他文件只给路径。 */
type AttachmentKind = 'image' | 'file';

export interface IAttachment {
	readonly attachmentId: string;
	readonly name: string;
	readonly kind: AttachmentKind;
	readonly mimeType: string;
	readonly size: number;
	/** 资源 ID，上下文里引用图片用。 */
	readonly resourceId: string;
	/** 本地文件路径，成员可以直接读。 */
	readonly path: string;
}

interface IAttachmentRow {
	readonly attachment_id: string;
	readonly resource_id: string;
	readonly name: string;
	readonly kind: AttachmentKind;
	readonly mime_type: string;
	readonly size: number;
}

/** 消息附件：先保存成附件拿到 ID，发消息时带上。文件存进资源目录，原文件之后改了或删了都不影响。 */
export class Attachments {
	private readonly db: Database;
	private readonly resources: Resources;

	constructor(db: Database, resources: Resources) {
		this.db = db;
		this.resources = resources;
	}

	/** 保存一个附件。图片按文件开头的字节认出来。 */
	save(name: string, bytes: Buffer): IAttachment {
		const fileName = attachmentName(name);
		if (bytes.length === 0) throw invalid(`文件为空：${fileName}`);
		const image = detectImage(bytes);
		if (image && bytes.length > MAX_IMAGE_BYTES) throw invalid(`图片过大，最大 ${MAX_IMAGE_BYTES / 1024 / 1024} MB：${fileName}`);
		if (bytes.length > MAX_FILE_BYTES) throw invalid(`文件过大，最大 ${MAX_FILE_BYTES / 1024 / 1024} MB：${fileName}`);
		const attachmentId = newId('A', id => this.db.get('SELECT 1 FROM attachments WHERE attachment_id = ?', id) !== undefined);
		this.db.run(
			'INSERT INTO attachments (attachment_id, resource_id, name, kind, mime_type, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
			attachmentId, this.resources.saveFile(bytes, fileName), fileName, image ? 'image' : 'file',
			image?.mimeType ?? mimeType(fileName) ?? 'application/octet-stream', bytes.length, Date.now(),
		);
		return this.require(attachmentId);
	}

	/** 把本地文件存成附件。成员发消息带附件时用。 */
	importFile(path: string): IAttachment {
		let stat: Stats;
		try {
			stat = statSync(path);
		} catch {
			throw invalid(`文件不存在：${path}`);
		}
		if (!stat.isFile()) throw invalid(`不是文件：${path}`);
		if (stat.size > MAX_FILE_BYTES) throw invalid(`文件过大，最大 ${MAX_FILE_BYTES / 1024 / 1024} MB：${path}`);
		return this.save(path, readFileSync(path));
	}

	require(attachmentId: string): IAttachment {
		const row = this.db.get<IAttachmentRow>('SELECT * FROM attachments WHERE attachment_id = ?', attachmentId);
		if (!row) throw notFound(wrongKind(attachmentId, 'A') ?? `附件不存在：${attachmentId}`);
		return this.toAttachment(row);
	}

	/** 一条消息的附件，按发送时的顺序。 */
	/** 一批消息各自的附件，按先后；没有附件的消息不在里面。 */
	forMessages(messageIds: readonly number[]): Map<number, IAttachment[]> {
		const result = new Map<number, IAttachment[]>();
		for (const row of this.db.all<IAttachmentRow & { message_id: number }>(`
			SELECT link.message_id, attachment.* FROM message_attachments link JOIN attachments attachment ON attachment.attachment_id = link.attachment_id
			WHERE link.message_id IN (SELECT value FROM json_each(?)) ORDER BY link.message_id, link.position
		`, JSON.stringify(messageIds))) {
			result.set(row.message_id, [...result.get(row.message_id) ?? [], this.toAttachment(row)]);
		}
		return result;
	}

	/** 消息 ID 在 (after, through] 里的消息各自的附件，按先后；没有附件的消息不在里面。按主键的范围取，只读到带附件的。 */
	inRange(afterMessageId: number, throughMessageId: number): Map<number, IAttachment[]> {
		const result = new Map<number, IAttachment[]>();
		for (const row of this.db.all<IAttachmentRow & { message_id: number }>(`
			SELECT link.message_id, attachment.* FROM message_attachments link JOIN attachments attachment ON attachment.attachment_id = link.attachment_id
			WHERE link.message_id > ? AND link.message_id <= ? ORDER BY link.message_id, link.position
		`, afterMessageId, throughMessageId)) {
			result.set(row.message_id, [...result.get(row.message_id) ?? [], this.toAttachment(row)]);
		}
		return result;
	}

	private toAttachment(row: IAttachmentRow): IAttachment {
		return {
			attachmentId: row.attachment_id, name: row.name, kind: row.kind, mimeType: row.mime_type, size: row.size,
			resourceId: row.resource_id, path: this.resources.path(row.resource_id)!,
		};
	}
}

/** 只取文件名本身，去掉 Windows 不允许的字符；太长时保留扩展名截短。 */
function attachmentName(name: string): string {
	let fileName = (name.split(/[\\/]/).pop() ?? '').replace(/[\u0000-\u001f<>:"|?*]/g, '_').trim().replace(/[. ]+$/, '');
	if (!fileName || fileName === '.' || fileName === '..') throw invalid('附件的文件名不能为空');
	if (fileName.length > MAX_NAME_LENGTH) {
		const extension = extname(fileName).slice(0, 20);
		fileName = fileName.slice(0, MAX_NAME_LENGTH - extension.length) + extension;
	}
	return /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(fileName) ? `_${fileName}` : fileName;
}

/** 给人看的文件大小。先取整再定单位：差一点到 1 MB 的写 1.0 MB，不写 1024.0 KB。 */
export function formatSize(size: number): string {
	if (size < 1024) return `${size} B`;
	const kilo = (size / 1024).toFixed(1);
	if (Number(kilo) < 1024) return `${kilo} KB`;
	return `${(size / 1024 / 1024).toFixed(1)} MB`;
}
