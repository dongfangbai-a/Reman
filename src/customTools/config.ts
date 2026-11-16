import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isRecord, parseJson } from '../common/json.ts';
import type { Secrets } from '../common/secrets.ts';

/** 选模型设置里的供应商，只记标识。 */
export interface IProviderValue {
	readonly provider: string;
}

/** 单独填的地址和 key，key 加密保存。 */
export interface IEndpointValue {
	readonly baseUrl: string;
	readonly apiKey: string;
}

/** 保存的一项配置的值：text、secret 是字符串（secret 加密），service 是选的供应商或单独填的地址和 key。 */
export type StoredValue = string | IProviderValue | IEndpointValue;

/** 一个文件夹保存的内容：停用了没有，和填的配置。 */
export interface IStoredFolder {
	readonly disabled: boolean;
	readonly values: Readonly<Record<string, StoredValue>>;
}

/** 按文件夹名。 */
export type StoredConfig = Readonly<Record<string, IStoredFolder>>;

const EMPTY_FOLDER: IStoredFolder = { disabled: false, values: {} };

/**
 * 自定义工具的配置 custom-tools.json：用户在网页端填的值和停用，按文件夹名存，每项是 { "disabled": true, "values": { ... } }，没停用时不写 disabled。
 * secret 类型的值和单独填的 apiKey 加密保存：读到明文时加密后写回。哪些是 secret 要看工具的声明，由调用的一方给出。
 * 每次用到时重新读取，改了文件不用重启。不给路径时只在内存里（测试用）。
 */
export class CustomToolConfig {
	private readonly path: string | undefined;
	private readonly secrets: Secrets;
	private memory: StoredConfig = {};

	constructor(path: string | undefined, secrets: Secrets) {
		this.path = path;
		this.secrets = secrets;
	}

	/** 读配置；文件有错时报错，错误信息就是原因。secretFields 给出一个文件夹里哪些项是 secret。 */
	read(secretFields: (folder: string) => ReadonlySet<string>): StoredConfig {
		const config = this.load();
		let changed = false;
		const next = Object.fromEntries(Object.entries(config).map(([folder, stored]) => {
			const values = this.encryptValues(stored.values, secretFields(folder));
			if (values !== stored.values) changed = true;
			return [folder, { ...stored, values }];
		}));
		if (changed) {
			try {
				this.save(next);
			} catch (error) {
				console.error('加密 custom-tools.json 中的密钥失败：', error);
			}
		}
		return next;
	}

	/** 整个替换一个文件夹的配置，停用不变。值要先检查过；secret 的值还是明文时给出 secretFields 加密。 */
	write(folder: string, values: Readonly<Record<string, StoredValue>>, secretFields: ReadonlySet<string>): void {
		this.update(folder, stored => ({ ...stored, values: this.encryptValues(values, secretFields) }));
	}

	setDisabled(folder: string, disabled: boolean): void {
		this.update(folder, stored => ({ ...stored, disabled }));
	}

	/** 改一个文件夹的内容；没停用、也没有配置时去掉这一项。 */
	private update(folder: string, change: (stored: IStoredFolder) => IStoredFolder): void {
		const config = { ...this.load() };
		const next = change(config[folder] ?? EMPTY_FOLDER);
		if (next.disabled || Object.keys(next.values).length > 0) config[folder] = next;
		else delete config[folder];
		this.save(config);
	}

	/** 加密还是明文的密钥；都已经加密时返回原对象。 */
	private encryptValues(values: Readonly<Record<string, StoredValue>>, secretFields: ReadonlySet<string>): Readonly<Record<string, StoredValue>> {
		let changed = false;
		const next = Object.fromEntries(Object.entries(values).map(([name, value]) => {
			const encrypted = this.encryptValue(value, secretFields.has(name));
			if (encrypted !== value) changed = true;
			return [name, encrypted];
		}));
		return changed ? next : values;
	}

	private encryptValue(value: StoredValue, secret: boolean): StoredValue {
		if (typeof value === 'string') return secret ? this.secrets.encrypt(value) : value;
		if ('apiKey' in value) {
			const apiKey = this.secrets.encrypt(value.apiKey);
			return apiKey === value.apiKey ? value : { ...value, apiKey };
		}
		return value;
	}

	private load(): StoredConfig {
		if (!this.path) return this.memory;
		if (!existsSync(this.path)) return {};
		let value: unknown;
		try {
			value = parseJson(readFileSync(this.path, 'utf8'));
		} catch {
			throw new Error('custom-tools.json 不是合法的 JSON');
		}
		return parseConfig(value);
	}

	private save(config: StoredConfig): void {
		if (!this.path) {
			this.memory = config;
			return;
		}
		// 没停用时不写 disabled。
		const file = Object.fromEntries(Object.entries(config).map(([folder, stored]) => [folder, stored.disabled ? stored : { values: stored.values }]));
		const temporary = `${this.path}.tmp`;
		writeFileSync(temporary, `${JSON.stringify(file, null, '\t')}\n`);
		renameSync(temporary, this.path);
	}
}

function parseConfig(value: unknown): StoredConfig {
	if (!isRecord(value)) throw configError('内容须为对象，以文件夹名为键记录每个自定义工具的配置');
	return Object.fromEntries(Object.entries(value).map(([folder, stored]) => {
		if (!isRecord(stored)) throw configError(`${folder} 必须是对象，如 { "values": { ... } }`);
		const unknown = Object.keys(stored).filter(key => key !== 'disabled' && key !== 'values');
		if (unknown.length > 0) throw configError(`${folder} 中有无法识别的字段 ${unknown.join('、')}；可用字段：disabled、values`);
		const disabled = stored['disabled'] ?? false;
		if (typeof disabled !== 'boolean') throw configError(`${folder}.disabled 必须是 true 或 false`);
		const values = stored['values'] ?? {};
		if (!isRecord(values)) throw configError(`${folder}.values 必须是对象`);
		return [folder, { disabled, values: Object.fromEntries(Object.entries(values).map(([name, item]) => [name, parseValue(item, `${folder}.values.${name}`)])) }];
	}));
}

function parseValue(value: unknown, path: string): StoredValue {
	if (typeof value === 'string') return value;
	if (isRecord(value)) {
		const keys = Object.keys(value).sort().join(',');
		if (keys === 'provider' && typeof value['provider'] === 'string' && value['provider']) return { provider: value['provider'] };
		if (keys === 'apiKey,baseUrl' && typeof value['baseUrl'] === 'string' && /^https?:\/\//.test(value['baseUrl']) && typeof value['apiKey'] === 'string' && value['apiKey']) {
			return { baseUrl: value['baseUrl'], apiKey: value['apiKey'] };
		}
	}
	throw configError(`${path} 必须是字符串、{ "provider": "供应商标识" } 或 { "baseUrl": "http(s) 地址", "apiKey": "key" }`);
}

function configError(detail: string): Error {
	return new Error(`custom-tools.json 配置有误：${detail}`);
}
