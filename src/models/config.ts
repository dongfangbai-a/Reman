import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { errorMessage, invalid } from '../common/errors.ts';
import { isRecord, parseJson } from '../common/json.ts';
import { undecryptable, type Secrets } from '../common/secrets.ts';
import { ModelError } from './client.ts';

/** 已添加的模型。上游列表里拉到的和手动添加的都是这个样子。 */
export interface IModelEntry {
	readonly model: string;
	readonly displayName: string;
	/** 供应商标的上下文长度；没写时按默认值算。到一定比例就压缩，剩下的留给输出。 */
	readonly contextWindow: number | undefined;
	/**
	 * 一次回复最多多少 token；没写时不给服务商发，按它的默认值来。
	 * 上下文放得下但模型一次想太久的时候，靠它兜底，免得一份输出就把窗口撑爆。
	 */
	readonly maxOutputTokens: number | undefined;
	/** 能不能看图；不能时上下文里的图片换成一句说明。 */
	readonly vision: boolean;
}

export interface IProvider {
	readonly id: string;
	readonly name: string;
	readonly baseUrl: string;
	/** 解密后的 key；加密保存的值解不开时是 null。 */
	readonly apiKey: string | null;
	readonly models: readonly IModelEntry[];
}

/** 成员用哪个模型：哪个供应商的哪个模型。 */
export interface IModelRef {
	readonly provider: string;
	readonly model: string;
}

/** key 能用的供应商。 */
export interface IUsableProvider extends IProvider {
	readonly apiKey: string;
}

/** 一次请求要用的模型：供应商和模型条目。 */
export interface IResolvedModel {
	readonly provider: IUsableProvider;
	readonly entry: IModelEntry;
}

/** 给前端看的配置：key 不给原文，只给末几位（key 短时不给）；undecryptable 是加密保存的值解不开。 */
export interface IModelList {
	readonly defaultModel: IModelRef | undefined;
	readonly providers: readonly (Omit<IProvider, 'apiKey'> & { readonly apiKey: { readonly preview: string; readonly undecryptable: boolean } })[];
	readonly error: string | undefined;
}

/** 文件里写的供应商：apiKey 是保存的值，可能是加密后的。 */
type StoredProvider = Omit<IProvider, 'apiKey'> & { readonly apiKey: string };

interface IModelsFile<P> {
	readonly defaultModel: IModelRef | undefined;
	readonly providers: readonly P[];
}

const TOP_FIELDS = ['defaultModel', 'providers'];
const PROVIDER_FIELDS = ['id', 'name', 'baseUrl', 'apiKey', 'models'];
const MODEL_FIELDS = ['model', 'displayName', 'contextWindow', 'maxOutputTokens', 'vision'];
const PROVIDER_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * 模型配置 models.json：一个或多个供应商，每个供应商有自己的地址、key 和已添加的模型。
 * 没有文件时没有供应商，第一次保存时写出。每次用到时重新读取，改了文件不用重启。给了 secrets 时 key 加密保存：读到明文的 key 加密后写回，用的时候解密。
 */
export class ModelConfig {
	private readonly load: () => unknown;
	private readonly save: ((value: unknown) => void) | undefined;
	private readonly secrets: Secrets | undefined;

	constructor(load: () => unknown, save?: (value: unknown) => void, secrets?: Secrets) {
		this.load = load;
		this.save = save;
		this.secrets = secrets;
	}

	static fromFile(path: string, secrets: Secrets): ModelConfig {
		return new ModelConfig(() => {
			if (!existsSync(path)) return { providers: [] };
			let text: string;
			try {
				text = readFileSync(path, 'utf8');
			} catch {
				throw new ModelError('config', `无法读取模型配置文件 ${path}`, false);
			}
			try {
				return parseJson(text);
			} catch {
				throw new ModelError('config', 'models.json 不是合法的 JSON', false);
			}
		}, value => {
			const temporary = `${path}.tmp`;
			writeFileSync(temporary, `${JSON.stringify(value, null, '\t')}\n`);
			renameSync(temporary, path);
		}, secrets);
	}

	/** 找到要用的模型；ref 为 null 时用默认模型。 */
	resolve(ref: IModelRef | null): IResolvedModel {
		const parsed = this.parse();
		const target = ref ?? parsed.defaultModel;
		if (!target) throw new ModelError('config', 'models.json 未设置默认模型 defaultModel', false);
		const provider = parsed.providers.find(item => item.id === target.provider);
		if (!provider) throw new ModelError('config', `models.json 中不存在供应商 ${target.provider}`, false);
		const entry = provider.models.find(model => model.model === target.model);
		if (!entry) throw new ModelError('config', `供应商 ${provider.id} 未添加模型 ${target.model}`, false);
		if (provider.apiKey === null) throw new ModelError('config', `供应商 ${provider.id} 的 ${undecryptable('key')}`, false);
		return { provider: { ...provider, apiKey: provider.apiKey }, entry };
	}

	provider(id: string): IUsableProvider {
		const provider = this.parse().providers.find(item => item.id === id);
		if (!provider) throw invalid(`不存在供应商 ${id}`);
		if (provider.apiKey === null) throw invalid(`供应商 ${id} 的 ${undecryptable('key')}`);
		return { ...provider, apiKey: provider.apiKey };
	}

	list(): IModelList {
		try {
			const parsed = this.parse();
			return { defaultModel: parsed.defaultModel, providers: parsed.providers.map(publicProvider), error: undefined };
		} catch (error) {
			return { defaultModel: undefined, providers: [], error: errorMessage(error) };
		}
	}

	/** 这个模型能不能用；不能时说明原因。 */
	problem(ref: IModelRef): string | undefined {
		try {
			this.resolve(ref);
			return undefined;
		} catch (error) {
			return errorMessage(error);
		}
	}

	/** 给成员看的可用模型清单，写进管理成员的技能里。 */
	describeAvailable(): string {
		let parsed: IModelsFile<IProvider>;
		try {
			parsed = this.parse();
		} catch (error) {
			return `（当前无法读取模型配置：${errorMessage(error)}）`;
		}
		const lines = parsed.providers.map(provider => `- 供应商 \`${provider.id}\`${provider.name === provider.id ? '' : `（${provider.name}）`}：`
			+ (provider.models.map(model => `\`${model.model}\``).join('、') || '尚未添加模型'));
		if (parsed.defaultModel) lines.unshift(`默认模型：供应商 \`${parsed.defaultModel.provider}\` 的 \`${parsed.defaultModel.model}\``);
		return lines.join('\n') || '（尚未配置供应商）';
	}

	/**
	 * 整个替换配置。供应商没给 apiKey 时沿用同一个 id 原来保存的 key（解不开的也原样留着）；给了的加密后保存。
	 * 先按同样的规则检查，有误时不写文件。
	 */
	update(value: unknown): IModelList {
		if (!this.save) throw invalid('模型配置不能修改');
		let current: readonly StoredProvider[] = [];
		try {
			current = parseFile(this.read()).providers;
		} catch {
			// 原来的文件有误时，没有可以沿用的 key。
		}
		if (!isRecord(value) || !Array.isArray(value['providers'])) throw invalid('模型配置必须是对象，且 providers 必须是数组');
		const providers = value['providers'].map((provider: unknown) => {
			if (!isRecord(provider)) return provider;
			const apiKey = provider['apiKey'];
			if (apiKey !== undefined) return typeof apiKey === 'string' && this.secrets ? { ...provider, apiKey: this.secrets.encrypt(apiKey) } : provider;
			const previous = current.find(item => item.id === provider['id']);
			return previous ? { ...provider, apiKey: previous.apiKey } : provider;
		});
		const next = { ...value, providers };
		let parsed: IModelsFile<StoredProvider>;
		try {
			parsed = parseFile(next);
		} catch (error) {
			throw invalid(errorMessage(error));
		}
		const fallback = parsed.defaultModel;
		if (fallback && !parsed.providers.some(provider => provider.id === fallback.provider && provider.models.some(model => model.model === fallback.model))) {
			throw invalid(`默认模型不存在：供应商 ${fallback.provider} 的 ${fallback.model}`);
		}
		this.save(next);
		return this.list();
	}

	/** 把明文的 key 加密写回。启动时调用；之后每次读取时也会做。 */
	encryptKeys(): void {
		try {
			this.read();
		} catch {
			// 文件读不出或不是 JSON 时没有可加密的。
		}
	}

	/** 检查配置，key 解密。 */
	private parse(): IModelsFile<IProvider> {
		const parsed = parseFile(this.read());
		const secrets = this.secrets;
		if (!secrets) return parsed;
		return { ...parsed, providers: parsed.providers.map(provider => ({ ...provider, apiKey: secrets.decrypt(provider.apiKey) ?? null })) };
	}

	/** 读配置文件；有明文的 key 时加密后写回。写不回去时照常用，下次再试。 */
	private read(): unknown {
		const value = this.load();
		const secrets = this.secrets;
		if (!secrets || !this.save || !isRecord(value) || !Array.isArray(value['providers'])) return value;
		let changed = false;
		const providers = value['providers'].map((provider: unknown) => {
			if (!isRecord(provider) || typeof provider['apiKey'] !== 'string') return provider;
			const apiKey = secrets.encrypt(provider['apiKey']);
			if (apiKey === provider['apiKey']) return provider;
			changed = true;
			return { ...provider, apiKey };
		});
		if (!changed) return value;
		const next = { ...value, providers };
		try {
			this.save(next);
		} catch (error) {
			console.error('加密 models.json 中的 key 失败：', error);
		}
		return next;
	}
}

function parseFile(value: unknown): IModelsFile<StoredProvider> {
	if (!isRecord(value)) throw configError('内容必须是一个对象');
	unknownFields(value, TOP_FIELDS, '');
	if (!Array.isArray(value['providers'])) throw configError('providers 必须是数组');
	const providers = value['providers'].map((provider: unknown, index) => parseProvider(provider, `providers[${index}]`));
	const ids = providers.map(provider => provider.id);
	const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
	if (duplicate) throw configError(`供应商 id 重复：${duplicate}`);
	let defaultModel: IModelRef | undefined;
	if (value['defaultModel'] !== undefined) {
		const ref = value['defaultModel'];
		if (!isRecord(ref) || typeof ref['provider'] !== 'string' || typeof ref['model'] !== 'string') {
			throw configError('defaultModel 必须是 { "provider": "供应商 id", "model": "模型名" }');
		}
		defaultModel = { provider: ref['provider'], model: ref['model'] };
	}
	return { defaultModel, providers };
}

function parseProvider(value: unknown, path: string): StoredProvider {
	if (!isRecord(value)) throw configError(`${path} 必须是对象`);
	unknownFields(value, PROVIDER_FIELDS, `${path}.`);
	const { id, name, baseUrl, apiKey, models } = value;
	if (typeof id !== 'string' || !PROVIDER_ID.test(id)) throw configError(`${path}.id 只能包含小写字母、数字和横杠，例如 zhipu`);
	if (name !== undefined && typeof name !== 'string') throw configError(`${path}.name 必须是字符串`);
	if (typeof baseUrl !== 'string' || !/^https?:\/\//.test(baseUrl)) throw configError(`${path}.baseUrl 必须是 http(s) 地址`);
	if (typeof apiKey !== 'string' || !apiKey.trim()) throw configError(`${path}.apiKey 不能为空`);
	if (!Array.isArray(models)) throw configError(`${path}.models 必须是数组`);
	const entries = models.map((model: unknown, index) => parseModel(model, `${path}.models[${index}]`));
	const names = entries.map(entry => entry.model);
	const duplicate = names.find((model, index) => names.indexOf(model) !== index);
	if (duplicate) throw configError(`${path} 中模型重复：${duplicate}`);
	return { id, name: name || id, baseUrl, apiKey, models: entries };
}

function parseModel(value: unknown, path: string): IModelEntry {
	if (!isRecord(value)) throw configError(`${path} 必须是对象`);
	unknownFields(value, MODEL_FIELDS, `${path}.`);
	const { model, displayName, contextWindow, maxOutputTokens, vision } = value;
	if (typeof model !== 'string' || !model.trim()) throw configError(`${path}.model 必须是非空字符串`);
	if (displayName !== undefined && typeof displayName !== 'string') throw configError(`${path}.displayName 必须是字符串`);
	if (contextWindow !== undefined && !(typeof contextWindow === 'number' && Number.isSafeInteger(contextWindow) && contextWindow > 0)) {
		throw configError(`${path}.contextWindow 必须是正整数`);
	}
	if (maxOutputTokens !== undefined && !(typeof maxOutputTokens === 'number' && Number.isSafeInteger(maxOutputTokens) && maxOutputTokens > 0)) {
		throw configError(`${path}.maxOutputTokens 必须是正整数`);
	}
	if (vision !== undefined && typeof vision !== 'boolean') throw configError(`${path}.vision 必须是 true 或 false`);
	return {
		model, displayName: displayName || model,
		contextWindow: contextWindow as number | undefined,
		maxOutputTokens: maxOutputTokens as number | undefined,
		vision: vision ?? false,
	};
}

function unknownFields(value: Record<string, unknown>, fields: readonly string[], path: string): void {
	const unknown = Object.keys(value).filter(key => !fields.includes(key));
	if (unknown.length > 0) throw configError(`无法识别的字段 ${unknown.map(key => path + key).join('、')}；可用字段：${fields.join('、')}`);
}

function publicProvider(provider: IProvider): IModelList['providers'][number] {
	const { apiKey, ...rest } = provider;
	return { ...rest, apiKey: { preview: apiKey !== null && apiKey.length >= 12 ? `…${apiKey.slice(-4)}` : '', undecryptable: apiKey === null } };
}

function configError(detail: string): ModelError {
	return new ModelError('config', `models.json 配置有误：${detail}`, false);
}
