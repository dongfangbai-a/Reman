/**
 * 估算输入 token：普通内容按 JSON 的 UTF-8 字节数 / 4；
 * 有加密内容的思考按加密内容字节数 / 8；图片按 32×32 的小块数，读不出尺寸时按固定值。
 * 只用来估算「上次请求之后新增的内容」和压缩后的整体长度，已知的部分用模型返回的实际用量。
 */
const IMAGE_PATCH_SIZE = 32;
const IMAGE_UNKNOWN_TOKENS = 1944;

export function estimateTokens(items: readonly object[]): number {
	return items.reduce((sum, item) => sum + estimateItemTokens(item), 0);
}

export function estimateItemTokens(item: object): number {
	const record = item as Record<string, unknown>;
	if (record['type'] === 'reasoning') return estimateReasoningTokens(record);
	const serialized = JSON.stringify(item);
	let tokens = Math.floor(Buffer.byteLength(serialized, 'utf8') / 4);
	for (const url of imageUrls(item)) {
		// 图片在 JSON 里是一长串 base64，换成按尺寸估算的值。
		tokens += imageTokens(url) - Math.floor(Buffer.byteLength(url, 'utf8') / 4);
	}
	return Math.max(0, tokens);
}

function estimateReasoningTokens(item: Record<string, unknown>): number {
	const encrypted = item['encrypted_content'];
	if (typeof encrypted === 'string' && encrypted.length > 0) return Math.floor(Buffer.byteLength(encrypted, 'utf8') / 8);
	let bytes = 0;
	for (const key of ['summary', 'content']) {
		const parts = item[key];
		if (!Array.isArray(parts)) continue;
		for (const part of parts) {
			if (part && typeof part.text === 'string') bytes += Buffer.byteLength(part.text, 'utf8');
		}
	}
	return Math.floor(bytes / 4);
}

function imageUrls(value: unknown, urls: string[] = []): string[] {
	if (Array.isArray(value)) {
		for (const item of value) imageUrls(item, urls);
	} else if (value && typeof value === 'object') {
		const record = value as Record<string, unknown>;
		if (record['type'] === 'input_image' && typeof record['image_url'] === 'string') urls.push(record['image_url']);
		for (const item of Object.values(record)) imageUrls(item, urls);
	}
	return urls;
}

function imageTokens(url: string): number {
	if (!url.startsWith('data:image/')) return IMAGE_UNKNOWN_TOKENS;
	const size = imageSize(Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'));
	return size ? Math.ceil(size.width / IMAGE_PATCH_SIZE) * Math.ceil(size.height / IMAGE_PATCH_SIZE) : IMAGE_UNKNOWN_TOKENS;
}

/** 读 PNG、GIF、JPEG 的宽高；其他格式返回 undefined。 */
function imageSize(bytes: Buffer): { width: number; height: number } | undefined {
	try {
		if (bytes.toString('ascii', 1, 4) === 'PNG' && bytes.toString('ascii', 12, 16) === 'IHDR') {
			return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
		}
		if (bytes.toString('ascii', 0, 3) === 'GIF') return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
		if (bytes[0] === 0xff && bytes[1] === 0xd8) {
			let offset = 2;
			while (offset + 9 < bytes.length) {
				if (bytes[offset] !== 0xff) return undefined;
				const marker = bytes[offset + 1]!;
				if (marker >= 0xc0 && marker <= 0xc2) return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
				offset += 2 + bytes.readUInt16BE(offset + 2);
			}
		}
	} catch {
		// 数据不完整，按读不出尺寸处理。
	}
	return undefined;
}
