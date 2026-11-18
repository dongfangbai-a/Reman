import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

/** 加密后的值的前缀。 */
const PREFIX = 'enc:v1:';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * 配置里的密钥（models.json 的 apiKey，mcp.json 的 env、headers）：运行时加密后原地替换，用的时候解密。
 * 钥匙每个数据目录一把，存在 secret-key 里，是敏感文件。加密用 AES-256-GCM，每个值一个随机数；值被改坏时解不开，不会解出乱码。
 */
export class Secrets {
	private readonly key: Buffer;

	private constructor(key: Buffer) {
		this.key = key;
	}

	/** 读钥匙；没有时生成一个并保存。文件内容不是钥匙时报错，不覆盖：钥匙可能还找得回来。 */
	static fromFile(path: string): Secrets {
		if (!existsSync(path)) writeFileSync(path, randomBytes(KEY_BYTES).toString('base64url'), { mode: 0o600, flag: 'wx' });
		const key = Buffer.from(readFileSync(path, 'utf8').trim(), 'base64url');
		if (key.length !== KEY_BYTES) throw new Error(`${path} 不是有效的密钥文件。删除该文件后将生成新的密钥，配置中已加密的值须重新填写`);
		return new Secrets(key);
	}

	/** 只在内存里的钥匙，测试用：重启后用它加密的值都解不开。 */
	static temporary(): Secrets {
		return new Secrets(randomBytes(KEY_BYTES));
	}

	/**
	 * 这台运行时的标识：由钥匙派生，和钥匙一样每个数据目录不同，但反推不出钥匙。
	 * 发 prompt_cache_key 时当盐用（见 models/cacheKey.ts）：不同数据目录之间不会撞上同一个 key。
	 */
	get cacheSalt(): string {
		return createHash('sha256').update(this.key).update('\nprompt-cache').digest('hex').slice(0, 32);
	}

	/** 加密；空值和已经加密的原样返回。 */
	encrypt(value: string): string {
		if (!value || isEncrypted(value)) return value;
		const iv = randomBytes(IV_BYTES);
		const cipher = createCipheriv('aes-256-gcm', this.key, iv);
		const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
		return `${PREFIX}${Buffer.concat([iv, data, cipher.getAuthTag()]).toString('base64url')}`;
	}

	/** 解密；明文原样返回。解不开（钥匙丢了或换了、值被改坏）时是 undefined。 */
	decrypt(value: string): string | undefined {
		if (!isEncrypted(value)) return value;
		const raw = Buffer.from(value.slice(PREFIX.length), 'base64url');
		if (raw.length < IV_BYTES + TAG_BYTES) return undefined;
		try {
			const decipher = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, IV_BYTES));
			decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
			return Buffer.concat([decipher.update(raw.subarray(IV_BYTES, raw.length - TAG_BYTES)), decipher.final()]).toString('utf8');
		} catch {
			return undefined;
		}
	}

	/** 把对象里的明文值都加密；有改动时返回新对象，没有时返回 undefined。 */
	encryptValues(values: Readonly<Record<string, unknown>>): Record<string, unknown> | undefined {
		let changed = false;
		const next = Object.fromEntries(Object.entries(values).map(([name, value]) => {
			if (typeof value !== 'string') return [name, value];
			const encrypted = this.encrypt(value);
			if (encrypted !== value) changed = true;
			return [name, encrypted];
		}));
		return changed ? next : undefined;
	}
}

export function isEncrypted(value: string): boolean {
	return value.startsWith(PREFIX);
}

/** 解不开时的说明，names 是解不开的值的名字。 */
export function undecryptable(names: string): string {
	return `${names} 已加密保存，但无法用当前数据目录的密钥解密，须重新填写`;
}
