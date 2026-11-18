import { errorMessage } from '../common/errors.ts';
import { isRecord, parseJson } from '../common/json.ts';
import { memberDescriptionProblem } from '../common/names.ts';
import { MAX_TERMINALS_PER_MEMBER } from '../terminals/limits.ts';

/** 成员文件夹里的文件名。 */
export const DEFINITION_FILE = 'member.json';
export const PROMPT_FILE = 'prompt.md';
export const MEMORY_FILE = 'memory.md';
export const INDEX_FILE = 'INDEX.md';
/** 按顺序找头像文件，用第一个存在的。 */
export const AVATAR_FILES = ['avatar.png', 'avatar.jpg', 'avatar.jpeg', 'avatar.webp', 'avatar.gif'] as const;

/** 思考强度。不写时不发这个参数，用供应商的默认。 */
const REASONING_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/** 对其他 AI 成员的限制：都不允许、都允许、只允许名单里的、除了名单里的都允许。私聊和群聊共用。 */
export type MemberRuleDefinition = 'none' | 'all' | { readonly allow: readonly string[] } | { readonly deny: readonly string[] };

/** member.json 的内容。省略的字段取默认值，写回文件时也保持省略。私聊、群聊名单写成员名，不写 ID。 */
export interface IMemberDefinition {
	readonly description?: string;
	readonly model?: { readonly provider: string; readonly name: string };
	readonly reasoning?: string;
	readonly directMessage?: MemberRuleDefinition;
	/** 哪些 AI 成员能把它拉进群聊；省略时都能。 */
	readonly groupInvite?: MemberRuleDefinition;
	readonly skills?: readonly string[];
	/** 省略时有新成员默认启用的工具；写了就只有列出的。 */
	readonly tools?: readonly string[];
	/** 时间感知：收到的内容带不带收到时的时间；省略时带。 */
	readonly timeAwareness?: boolean;
	/** 最多同时保留几个自己建的终端（只算这个成员建的、还没关闭的）；省略时 3，最多 16。 */
	readonly maxTerminals?: number;
}

const FIELDS = ['description', 'model', 'reasoning', 'directMessage', 'groupInvite', 'skills', 'tools', 'timeAwareness', 'maxTerminals'];
const LIST_MAX_LENGTH = 200;
const LIST_ITEM_MAX_LENGTH = 128;

type DefinitionParseResult =
	| { readonly definition: IMemberDefinition; readonly issues?: undefined }
	| { readonly definition?: undefined; readonly issues: readonly string[] };

/** 严格解析 member.json：不认识的字段、类型不对都算写错，一次列出全部问题。 */
export function parseDefinition(text: string): DefinitionParseResult {
	let value: unknown;
	try {
		value = parseJson(text);
	} catch (error) {
		return { issues: [`member.json 不是合法的 JSON：${errorMessage(error)}`] };
	}
	if (!isRecord(value)) return { issues: ['member.json 的内容必须是一个 JSON 对象，例如 {}'] };
	const issues: string[] = [];
	const definition: { -readonly [K in keyof IMemberDefinition]: IMemberDefinition[K] } = {};
	for (const key of Object.keys(value)) {
		if (!FIELDS.includes(key)) issues.push(`无法识别的字段「${key}」；可用字段：${FIELDS.join('、')}`);
	}
	if ('description' in value) {
		const description = value['description'];
		if (typeof description !== 'string') {
			issues.push('description 必须是字符串');
		} else {
			const problem = memberDescriptionProblem(description.trim());
			if (problem) issues.push(`description：${problem}`);
			else if (description.trim()) definition.description = description.trim();
		}
	}
	if ('model' in value) {
		const model = value['model'];
		if (!isRecord(model)) {
			issues.push('model 必须是对象，例如 { "provider": "供应商 id", "name": "模型名" }');
		} else {
			const unknown = Object.keys(model).filter(key => key !== 'provider' && key !== 'name');
			if (unknown.length > 0) issues.push(`model 中无法识别的字段：${unknown.join('、')}；只能包含 provider 和 name`);
			const provider = typeof model['provider'] === 'string' ? model['provider'].trim() : '';
			if (!provider) issues.push('model.provider 必须是非空字符串（models.json 中的供应商 id）');
			const name = typeof model['name'] === 'string' ? model['name'].trim() : '';
			if (!name) issues.push('model.name 必须是非空字符串');
			if (provider && name) definition.model = { provider, name };
		}
	}
	if ('reasoning' in value) {
		const reasoning = value['reasoning'];
		if ((REASONING_LEVELS as readonly unknown[]).includes(reasoning)) definition.reasoning = reasoning as string;
		else issues.push(`reasoning 只能是 ${REASONING_LEVELS.join('、')} 之一`);
	}
	for (const key of ['directMessage', 'groupInvite'] as const) {
		if (!(key in value)) continue;
		const rule = parseMemberRule(value[key], key, issues);
		if (rule) definition[key] = rule;
	}
	for (const key of ['skills', 'tools'] as const) {
		if (!(key in value)) continue;
		const names = parseNameList(value[key], key, issues);
		if (names) definition[key] = names;
	}
	if ('timeAwareness' in value) {
		const timeAwareness = value['timeAwareness'];
		if (typeof timeAwareness === 'boolean') definition.timeAwareness = timeAwareness;
		else issues.push('timeAwareness 必须是 true 或 false');
	}
	if ('maxTerminals' in value) {
		const maxTerminals = value['maxTerminals'];
		const valid = typeof maxTerminals === 'number' && Number.isInteger(maxTerminals)
			&& maxTerminals >= 1 && maxTerminals <= MAX_TERMINALS_PER_MEMBER;
		if (valid) definition.maxTerminals = maxTerminals as number;
		else issues.push(`maxTerminals 必须是 1 到 ${MAX_TERMINALS_PER_MEMBER} 的整数`);
	}
	return issues.length > 0 ? { issues } : { definition };
}

/** 写回 member.json：只写出明确设置的字段，字段顺序固定。 */
export function serializeDefinition(definition: IMemberDefinition): string {
	const output: Record<string, unknown> = {};
	if (definition.description) output['description'] = definition.description;
	if (definition.model) output['model'] = { provider: definition.model.provider, name: definition.model.name };
	if (definition.reasoning) output['reasoning'] = definition.reasoning;
	if (definition.directMessage !== undefined) output['directMessage'] = definition.directMessage;
	if (definition.groupInvite !== undefined) output['groupInvite'] = definition.groupInvite;
	if (definition.skills) output['skills'] = definition.skills;
	if (definition.tools) output['tools'] = definition.tools;
	if (definition.timeAwareness !== undefined) output['timeAwareness'] = definition.timeAwareness;
	if (definition.maxTerminals !== undefined) output['maxTerminals'] = definition.maxTerminals;
	return `${JSON.stringify(output, null, 2)}\n`;
}

/** 私聊或群聊名单里的成员名。 */
export function ruleNames(rule: MemberRuleDefinition | undefined): readonly string[] {
	if (!rule || typeof rule === 'string') return [];
	return 'allow' in rule ? rule.allow : rule.deny;
}

function parseMemberRule(value: unknown, label: string, issues: string[]): MemberRuleDefinition | undefined {
	if (value === 'none' || value === 'all') return value;
	if (isRecord(value)) {
		const keys = Object.keys(value);
		const key = keys[0];
		if (keys.length === 1 && (key === 'allow' || key === 'deny')) {
			const names = parseNameList(value[key], `${label}.${key}`, issues);
			if (!names) return undefined;
			return key === 'allow' ? { allow: names } : { deny: names };
		}
	}
	issues.push(`${label} 只能是 "none"、"all"、{ "allow": [成员名...] } 或 { "deny": [成员名...] }`);
	return undefined;
}

function parseNameList(value: unknown, label: string, issues: string[]): readonly string[] | undefined {
	if (!Array.isArray(value)) {
		issues.push(`${label} 必须是字符串数组`);
		return undefined;
	}
	if (value.length > LIST_MAX_LENGTH) {
		issues.push(`${label} 最多 ${LIST_MAX_LENGTH} 项`);
		return undefined;
	}
	const names: string[] = [];
	for (const item of value) {
		const name = typeof item === 'string' ? item.trim() : '';
		if (!name || name.length > LIST_ITEM_MAX_LENGTH) {
			issues.push(`${label} 中的每一项都必须是非空字符串，且不超过 ${LIST_ITEM_MAX_LENGTH} 个字符`);
			return undefined;
		}
		if (names.includes(name)) {
			issues.push(`${label} 中「${name}」重复`);
			return undefined;
		}
		names.push(name);
	}
	return names;
}
