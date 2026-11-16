import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { ID_ALPHABET } from '../common/ids.ts';

/** 能进上下文的图片格式，按文件开头的字节判断。 */
const IMAGE_TYPES = [
	{ mimeType: 'image/png', extension: 'png', matches: (bytes: Buffer) => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
	{ mimeType: 'image/jpeg', extension: 'jpg', matches: (bytes: Buffer) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff },
	{ mimeType: 'image/gif', extension: 'gif', matches: (bytes: Buffer) => bytes.toString('ascii', 0, 4) === 'GIF8' },
	{ mimeType: 'image/webp', extension: 'webp', matches: (bytes: Buffer) => bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' },
] as const;

/** 上下文里引用资源的图片写成这个前缀加资源 ID，发请求前再换成图片内容。 */
const RESOURCE_URL_PREFIX = 'resource:';

/**
 * 资源文件名的长度。比 ID 长：ID 生成时能查重、撞了就重新抽，资源的名字由内容定，撞了只能加长。
 * 两份不同的内容撞了名时，后存的多取一位，直到不冲突。
 */
const NAME_LENGTH = 8;
/** SHA-256 的 256 比特按 5 比特一位，最多写成 51 位。 */
const MAX_NAME_LENGTH = 51;
/** 资源文件名：按内容算出的短名。 */
const NAME = `[${ID_ALPHABET}]{${NAME_LENGTH},${MAX_NAME_LENGTH}}`;
const IMAGE_ID = new RegExp(`^${NAME}\\.[a-z]+$`);
const ATTACHMENT_ID = new RegExp(`^attachments/${NAME}/[^/\\\\]+$`);

/** 认出图片格式；不是支持的图片时返回 undefined。 */
export function detectImage(bytes: Buffer): { mimeType: string; extension: string } | undefined {
	return IMAGE_TYPES.find(type => type.matches(bytes));
}

/**
 * 工具结果里的图片和消息附件，按内容命名存成文件，时间线和消息里只记资源 ID（相对资源目录的路径）。同样的内容只存一份。
 * 工具结果的图片是 `<名字>.<扩展名>`；附件保留原文件名，是 `attachments/<名字>/<文件名>`。名字是内容的 SHA-256
 * 用 ID 的字母表写成的前 8 位：模型要把路径原样抄进工具参数、带进摘要，越短越不容易抄错。见运行时设计第 8 部分「资源文件」。
 */
export class Resources {
	private readonly directory: string;

	constructor(directory: string) {
		this.directory = directory;
		mkdirSync(directory, { recursive: true });
	}

	/** 保存一张工具结果里的图片，带上来源和存图片的文件。不是支持的图片格式时报错。 */
	toolImage(bytes: Buffer, source: string): IToolImage {
		const id = this.saveImage(bytes);
		return { ...resourceImage(id), source, path: resolve(this.directory, id) };
	}

	/** 保存一张图片，返回资源 ID。不是支持的图片格式时报错。 */
	saveImage(bytes: Buffer): string {
		const type = detectImage(bytes);
		if (!type) throw new Error('不支持的图片格式');
		for (const name of names(bytes)) {
			const id = `${name}.${type.extension}`;
			const path = join(this.directory, id);
			if (!existsSync(path)) {
				writeFileSync(path, bytes);
				return id;
			}
			if (sameContent(path, bytes)) return id;
		}
		throw new Error('资源文件名冲突');
	}

	/** 保存一个附件文件，返回资源 ID。文件名要先检查过。 */
	saveFile(bytes: Buffer, name: string): string {
		for (const folder of names(bytes)) {
			const directory = join(this.directory, 'attachments', folder);
			// 一个目录里是同一份内容，只是文件名不同：看其中一个就知道这个目录是不是这份内容的。
			const existing = existsSync(directory) ? readdirSync(directory) : [];
			if (existing.length > 0 && !sameContent(join(directory, existing[0]!), bytes)) continue;
			const id = `attachments/${folder}/${name}`;
			const path = this.path(id)!;
			if (!existsSync(path)) {
				mkdirSync(directory, { recursive: true });
				writeFileSync(path, bytes);
			}
			return id;
		}
		throw new Error('资源文件名冲突');
	}

	/** 资源 ID 对应的本地文件路径；ID 不合法时返回 undefined。 */
	path(id: string): string | undefined {
		if (!IMAGE_ID.test(id) && !ATTACHMENT_ID.test(id)) return undefined;
		const path = join(this.directory, id);
		const inside = relative(this.directory, path);
		return inside && !inside.startsWith('..') && !inside.startsWith(sep) ? path : undefined;
	}

	/**
	 * 发请求前把输入里引用资源的图片换成图片内容；模型不能看图时换成一句说明。
	 * 找不到的资源也换成说明，不让请求失败。
	 */
	materialize(input: readonly object[], vision: boolean): object[] {
		const visit = (value: unknown): unknown => {
			if (Array.isArray(value)) return value.map(visit);
			if (!value || typeof value !== 'object') return value;
			const record = value as Record<string, unknown>;
			const url = record['image_url'];
			if (record['type'] === 'input_image' && typeof url === 'string' && url.startsWith(RESOURCE_URL_PREFIX)) {
				if (!vision) return { type: 'input_text', text: '[图片：当前模型不能看图，已省略]' };
				const dataUrl = this.dataUrl(url.slice(RESOURCE_URL_PREFIX.length));
				return dataUrl ? { ...record, image_url: dataUrl } : { type: 'input_text', text: '[图片：文件已不存在]' };
			}
			return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, visit(item)]));
		};
		return input.map(item => visit(item) as object);
	}

	private dataUrl(id: string): string | undefined {
		const path = this.path(id);
		if (!path) return undefined;
		try {
			const bytes = readFileSync(path);
			const type = detectImage(bytes);
			return type && `data:${type.mimeType};base64,${bytes.toString('base64')}`;
		} catch {
			return undefined;
		}
	}
}

/** 引用一张资源图片：和模型接口的图片输入同一个形状，image_url 是资源 ID，发请求前才换成图片内容。 */
export interface IInputImage {
	readonly type: 'input_image';
	readonly image_url: string;
	readonly detail: 'auto';
}

/**
 * 工具结果里的图片：source 写明来源（本地文件路径、PDF 路径加页码），run_tool_script 输出图片时用它说明是哪张；
 * path 是存这张图片的文件，成员要把图片当文件用（如作为附件发送）时用它。
 */
export interface IToolImage extends IInputImage {
	readonly source: string;
	readonly path: string;
}

/** 上下文里引用一张资源图片。 */
export function resourceImage(id: string): IInputImage {
	return { type: 'input_image', image_url: `${RESOURCE_URL_PREFIX}${id}`, detail: 'auto' };
}

/** 引用资源图片时给出资源 ID；不是资源图片的引用（包括外部链接和 data: 地址）时返回 undefined。 */
export function imageResourceId(value: unknown): string | undefined {
	if (typeof value !== 'object' || value === null) return undefined;
	const { type, image_url: url } = value as Record<string, unknown>;
	if (type !== 'input_image' || typeof url !== 'string' || !url.startsWith(RESOURCE_URL_PREFIX)) return undefined;
	const id = url.slice(RESOURCE_URL_PREFIX.length);
	return IMAGE_ID.test(id) ? id : undefined;
}

/** 按内容算出的名字，从 8 位起每次多一位：前面的被别的内容占了时用下一个。 */
function* names(bytes: Buffer): Generator<string> {
	const digest = createHash('sha256').update(bytes).digest();
	let full = '';
	let value = 0;
	let bits = 0;
	for (const byte of digest) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			bits -= 5;
			full += ID_ALPHABET[(value >>> bits) & 31];
		}
		value &= (1 << bits) - 1;
	}
	for (let length = NAME_LENGTH; length <= full.length; length++) yield full.slice(0, length);
}

/** 文件的内容和 bytes 一样。读不了时算不一样。 */
function sameContent(path: string, bytes: Buffer): boolean {
	try {
		return statSync(path).size === bytes.length && readFileSync(path).equals(bytes);
	} catch {
		return false;
	}
}
