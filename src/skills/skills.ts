import { randomUUID } from 'node:crypto';
import {
	cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, watch, writeFileSync, type FSWatcher,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { errorMessage, invalid, notFound, RuntimeError } from '../common/errors.ts';
import { readJsonFile } from '../common/json.ts';

const SKILL_FILE = 'SKILL.md';
const NAME_MAX_LENGTH = 64;
const CONTENT_MAX_CHARS = 512 * 1024;
const DESCRIPTION_MAX_CHARS = 1024;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
/** 导入的技能文件夹最大多少（不算隐藏文件）。 */
const IMPORT_MAX_BYTES = 50 * 1024 * 1024;
/** 详情里最多列多少个其他文件。 */
const MAX_LISTED_FILES = 200;
const WATCH_DEBOUNCE_MS = 300;
/** 常见的全局 agent 技能目录，相对用户目录。 */
const GLOBAL_SOURCES = ['.agents/skills', '.claude/skills', '.codex/skills'];

/** 技能正文里可以写的占位符：{{skills_directory}} 和构造时给的路径（如 {{members_directory}}）读取时换成实际路径，这个换成现在能用的模型列表。 */
const AVAILABLE_MODELS = '{{available_models}}';

export type SkillSource = 'builtin' | 'data';

export interface ISkill {
	/** 文件夹名就是技能名。 */
	readonly name: string;
	readonly description: string;
	readonly source: SkillSource;
	/** 技能目录里和内置技能同名，覆盖了内置的。 */
	readonly overridesBuiltin: boolean;
	/** 新成员默认启用。 */
	readonly defaultEnabled: boolean;
	/** 技能文件夹的绝对路径，技能里提到的其他文件相对它。 */
	readonly directory: string;
	/** SKILL.md 全文，占位符已经换成实际路径。 */
	readonly content: string;
}

/** 读不出来的技能文件夹。 */
export interface ISkillIssue {
	readonly name: string;
	readonly source: SkillSource;
	readonly directory: string;
	readonly message: string;
}

export interface ISkillsSnapshot {
	/** 数据目录里的技能目录，用户和成员在这里新建、修改技能。 */
	readonly directory: string;
	readonly skills: readonly ISkill[];
	readonly issues: readonly ISkillIssue[];
}

/** 一个技能的详情：SKILL.md 开头字段以后的原文，和文件夹里的其他文件。 */
export interface ISkillDetail {
	readonly skill: Omit<ISkill, 'content'>;
	readonly body: string;
	/** 相对技能文件夹的路径，不含 SKILL.md 和隐藏文件，最多列 MAX_LISTED_FILES 个。 */
	readonly files: readonly string[];
	readonly moreFiles: boolean;
}

/** 可以导入的一个技能文件夹。 */
export interface ISkillCandidate {
	readonly name: string;
	readonly description: string;
	readonly directory: string;
	/** 不能导入的原因。 */
	readonly problem: string | null;
	/** 技能目录里已有同名技能，导入会覆盖。 */
	readonly exists: boolean;
}

/** 一个可以导入技能的文件夹。 */
export interface ISkillSource {
	/** 显示用的名字：全局目录写成 ~/ 开头，其他是绝对路径。 */
	readonly label: string;
	readonly directory: string;
	readonly exists: boolean;
	readonly skills: readonly ISkillCandidate[];
}

/**
 * 两处技能：随运行时提供的内置技能（只读）和数据目录里的技能目录，同名时用技能目录里的。
 * 每个技能一个文件夹，里面是 SKILL.md。每次用到时重新读取；技能目录里的文件或新成员的默认技能变了调用 onChange。
 * 新成员的默认技能存在 defaultsPath（技能名列表），不给时只在内存里。
 */
export class Skills {
	readonly directory: string;
	private readonly builtinDirectory: string;
	/** 占位符名（不带花括号）和它代表的路径。 */
	private readonly paths: Readonly<Record<string, string>>;
	private readonly defaultsPath: string | undefined;
	private readonly availableModels: () => string;
	private readonly onChange: () => void;
	/** 新成员默认启用的技能名，包括现在不存在的。 */
	private defaultNames: readonly string[];
	/** defaultNames 里现在有的技能。成员的技能每次取都要用，技能变了才重新算。 */
	private existingDefaults: readonly string[] = [];
	private watcher: FSWatcher | undefined;
	private timer: NodeJS.Timeout | undefined;

	constructor(
		directory: string, builtinDirectory: string, paths: Readonly<Record<string, string>>, defaultsPath: string | undefined,
		availableModels: () => string, onChange: () => void = () => {},
	) {
		this.directory = directory;
		this.builtinDirectory = builtinDirectory;
		this.paths = { ...paths, skills_directory: directory };
		this.defaultsPath = defaultsPath;
		this.availableModels = availableModels;
		this.onChange = onChange;
		mkdirSync(directory, { recursive: true });
		this.defaultNames = this.readDefaults();
		this.refreshDefaults();
	}

	snapshot(): ISkillsSnapshot {
		const data = this.scan(this.directory, 'data');
		const builtin = this.scan(this.builtinDirectory, 'builtin');
		const builtinNames = new Set(builtin.skills.map(skill => skill.name));
		const names = new Set(data.skills.map(skill => skill.name));
		const defaults = new Set(this.defaultNames);
		const skills = [
			...data.skills.map(skill => ({ ...skill, overridesBuiltin: builtinNames.has(skill.name) })),
			...builtin.skills.filter(skill => !names.has(skill.name)),
		].map(skill => ({ ...skill, defaultEnabled: defaults.has(skill.name) })).sort(skillOrder);
		return { directory: this.directory, skills, issues: [...data.issues, ...builtin.issues] };
	}

	get(name: string): ISkill | undefined {
		return this.snapshot().skills.find(skill => skill.name === name);
	}

	names(): ReadonlySet<string> {
		return new Set(this.snapshot().skills.map(skill => skill.name));
	}

	/** 新成员默认启用的技能，不含现在没有的。 */
	defaults(): readonly string[] {
		return this.existingDefaults;
	}

	/** 设新成员是否默认启用这个技能。要改时先调用 beforeChange，让还在用默认技能的成员先把当前的技能记成自己的。 */
	setDefault(name: string, enabled: unknown, beforeChange: () => void): void {
		if (typeof enabled !== 'boolean') throw invalid('enabled 必须是 true 或 false');
		if (!this.get(name)) throw notFound(`不存在技能 ${name}`);
		if (this.defaultNames.includes(name) === enabled) return;
		beforeChange();
		this.writeDefaults(enabled ? [...this.defaultNames, name] : this.defaultNames.filter(item => item !== name));
		this.changed();
	}

	detail(name: string): ISkillDetail {
		const skill = this.get(name);
		if (!skill) throw notFound(`不存在技能 ${name}`);
		const { content: _, ...rest } = skill;
		const files = listFiles(skill.directory, MAX_LISTED_FILES + 1).filter(file => file !== SKILL_FILE);
		return { skill: rest, body: splitFrontMatter(readSkillFile(join(skill.directory, SKILL_FILE))).body, files: files.slice(0, MAX_LISTED_FILES), moreFiles: files.length > MAX_LISTED_FILES };
	}

	/** 在技能目录里新建技能。和已有技能（包括内置技能）同名时报错。 */
	create(name: string, description: string, body: string): void {
		const problem = skillNameProblem(name);
		if (problem) throw invalid(problem);
		if (existsSync(join(this.directory, name)) || existsSync(join(this.builtinDirectory, name))) throw invalid(`已存在技能 ${name}`);
		const content = composeSkill([`name: ${name}`], description, body);
		mkdirSync(join(this.directory, name));
		writeFileSync(join(this.directory, name, SKILL_FILE), content);
		this.changed();
	}

	/** 改技能目录里的技能的说明和正文，SKILL.md 开头的其他字段原样保留。 */
	update(name: string, description: string, body: string): void {
		const path = join(this.dataFolder(name, '修改'), SKILL_FILE);
		if (!existsSync(path)) throw invalid(`技能 ${name} 缺少 ${SKILL_FILE}`);
		const { fields } = splitFrontMatter(readSkillFile(path));
		writeFileSync(path, composeSkill(fields.length > 0 ? fields : [`name: ${name}`], description, body));
		this.changed();
	}

	/**
	 * 删除技能目录里的技能文件夹（包括读不出来的），也从新成员的默认技能里去掉；去掉前先调用 beforeChange。
	 * 覆盖内置的技能删除后内置的还在，默认技能不变。
	 */
	remove(name: string, beforeChange: () => void = () => {}): void {
		const folder = this.dataFolder(name, '删除');
		const dropDefault = this.defaultNames.includes(name) && !isDirectory(join(this.builtinDirectory, name));
		if (dropDefault) beforeChange();
		rmSync(folder, { recursive: true, force: true });
		if (dropDefault) this.writeDefaults(this.defaultNames.filter(item => item !== name));
		this.changed();
	}

	/** 常见的全局 agent 技能目录里的技能。 */
	globalSources(): ISkillSource[] {
		return GLOBAL_SOURCES.map(path => this.source(join(homedir(), ...path.split('/')), `~/${path}`));
	}

	/** 一个文件夹里可以导入的技能：它本身是一个技能，或者每个有 SKILL.md 的子文件夹是一个技能。 */
	source(directory: string, label = directory): ISkillSource {
		const exists = isDirectory(directory);
		if (!exists) return { label, directory, exists, skills: [] };
		if (existsSync(join(directory, SKILL_FILE))) return { label, directory, exists, skills: [this.candidate(directory)] };
		const skills = readdirSync(directory, { withFileTypes: true })
			.filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && existsSync(join(directory, entry.name, SKILL_FILE)))
			.map(entry => this.candidate(join(directory, entry.name)))
			.sort((left, right) => left.name.localeCompare(right.name));
		return { label, directory, exists, skills };
	}

	/** 把整个技能文件夹复制到技能目录，返回技能名。已有同名技能时要 overwrite 才覆盖。 */
	import(directory: string, overwrite: boolean): string {
		const candidate = this.candidate(resolve(directory));
		if (candidate.problem) throw invalid(candidate.problem);
		const target = join(this.directory, candidate.name);
		if (existsSync(target) && !overwrite) throw new RuntimeError('conflict', `已存在技能 ${candidate.name}`, 409);
		// 先复制到隐藏的临时文件夹，复制完再换上去，中途失败不留下半个技能。
		const temporary = join(this.directory, `.import-${randomUUID()}`);
		try {
			cpSync(candidate.directory, temporary, { recursive: true, filter: source => source === candidate.directory || copied(source) });
			rmSync(target, { recursive: true, force: true });
			renameSync(temporary, target);
		} finally {
			rmSync(temporary, { recursive: true, force: true });
		}
		this.changed();
		return candidate.name;
	}

	/** 监听技能目录，文件变了调用 onChange。 */
	watch(): void {
		if (this.watcher) return;
		this.watcher = watch(this.directory, { recursive: true }, () => {
			clearTimeout(this.timer);
			this.timer = setTimeout(() => {
				try {
					this.changed();
				} catch (error) {
					console.error('技能目录变化后同步失败：', error);
				}
			}, WATCH_DEBOUNCE_MS);
		});
		this.watcher.on('error', error => console.error('监听技能目录失败：', error));
	}

	close(): void {
		clearTimeout(this.timer);
		this.watcher?.close();
		this.watcher = undefined;
	}

	private changed(): void {
		this.refreshDefaults();
		this.onChange();
	}

	private refreshDefaults(): void {
		const names = this.names();
		this.existingDefaults = this.defaultNames.filter(name => names.has(name));
	}

	/** 读默认技能文件；没有文件时一个都不启用，不是技能名的项跳过。 */
	private readDefaults(): string[] {
		if (!this.defaultsPath || !existsSync(this.defaultsPath)) return [];
		let parsed: unknown;
		try {
			parsed = readJsonFile(this.defaultsPath);
		} catch (error) {
			console.warn(`新成员的默认技能读取失败，不启用任何技能：${errorMessage(error)}`);
			return [];
		}
		if (!Array.isArray(parsed)) return [];
		return [...new Set(parsed.filter((name): name is string => typeof name === 'string' && !skillNameProblem(name)))].sort();
	}

	private writeDefaults(names: readonly string[]): void {
		const sorted = [...names].sort();
		if (this.defaultsPath) writeFileSync(this.defaultsPath, `${JSON.stringify(sorted, null, '\t')}\n`);
		this.defaultNames = sorted;
	}

	/** 技能目录里这个技能的文件夹；是内置技能或者不存在时报错。 */
	private dataFolder(name: string, action: string): string {
		if (!name || name !== basename(name) || name.startsWith('.')) throw invalid(`技能名「${name}」格式有误`);
		const folder = join(this.directory, name);
		if (isDirectory(folder)) return folder;
		if (isDirectory(join(this.builtinDirectory, name))) throw invalid(`内置技能不能${action}，可先复制为自定义技能`);
		throw notFound(`不存在技能 ${name}`);
	}

	private candidate(directory: string): ISkillCandidate {
		const name = basename(directory);
		const base = { name, directory, exists: existsSync(join(this.directory, name)) };
		const inside = relative(this.directory, directory);
		if (!inside || (!inside.startsWith('..') && !isAbsolute(inside))) return { ...base, description: '', problem: '已位于技能目录中' };
		try {
			const skill = this.read(name, directory, 'data');
			if (folderSize(directory, IMPORT_MAX_BYTES) > IMPORT_MAX_BYTES) return { ...base, description: skill.description, problem: `文件夹过大，最大 ${IMPORT_MAX_BYTES / 1024 / 1024} MB` };
			return { ...base, description: skill.description, problem: null };
		} catch (error) {
			return { ...base, description: '', problem: errorMessage(error) };
		}
	}

	private scan(root: string, source: SkillSource): { skills: ISkill[]; issues: ISkillIssue[] } {
		const skills: ISkill[] = [];
		const issues: ISkillIssue[] = [];
		if (!existsSync(root)) return { skills, issues };
		for (const entry of readdirSync(root, { withFileTypes: true })) {
			if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
			const directory = join(root, entry.name);
			try {
				skills.push(this.read(entry.name, directory, source));
			} catch (error) {
				issues.push({ name: entry.name, source, directory, message: errorMessage(error) });
			}
		}
		return { skills, issues };
	}

	private read(name: string, directory: string, source: SkillSource): ISkill {
		const problem = skillNameProblem(name);
		if (problem) throw new Error(problem);
		const path = join(directory, SKILL_FILE);
		if (!existsSync(path)) throw new Error(`缺少 ${SKILL_FILE}`);
		let content = readSkillFile(path);
		for (const [name, value] of Object.entries(this.paths)) content = content.split(`{{${name}}}`).join(value);
		if (content.includes(AVAILABLE_MODELS)) content = content.split(AVAILABLE_MODELS).join(this.availableModels());
		if (content.length > CONTENT_MAX_CHARS) throw new Error(`${SKILL_FILE} 过长，最多 ${CONTENT_MAX_CHARS} 个字符`);
		const frontMatter = parseFrontMatter(content);
		if (frontMatter.name !== undefined && frontMatter.name !== name) {
			throw new Error(`${SKILL_FILE} 中的 name「${frontMatter.name}」须与文件夹名「${name}」一致，或省略`);
		}
		return {
			name, description: (frontMatter.description ?? '').slice(0, DESCRIPTION_MAX_CHARS), source, overridesBuiltin: false, defaultEnabled: false, directory, content,
		};
	}
}

/** 技能名同时是文件夹名，按通用的 Agent Skills 规则：小写英文字母、数字和横杠，最多 64 个字符。 */
export function skillNameProblem(name: string): string | undefined {
	if (!/^[a-z0-9-]+$/.test(name)) return `技能名「${name}」只能包含小写英文字母、数字和横杠`;
	if (name.length > NAME_MAX_LENGTH) return `技能名「${name}」过长，最长 ${NAME_MAX_LENGTH} 个字符`;
	if (WINDOWS_RESERVED.test(name)) return `「${name}」是系统保留名称，不能用作技能名`;
	return undefined;
}

/**
 * 读 SKILL.md 开头 `---` 之间的 name 和 description。只支持单行的 `键: 值`
 * 和 `|`、`>` 开头的多行写法，足够覆盖常见技能文件；其他字段忽略。
 */
export function parseFrontMatter(content: string): { readonly name?: string; readonly description?: string } {
	const lines = content.split('\n');
	if (lines[0]?.trim() !== '---') return {};
	const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
	if (end < 0) return {};
	const values = new Map<string, string>();
	for (let index = 1; index < end; index++) {
		const match = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[index]!);
		if (!match) continue;
		let value = match[2]!.trim();
		if (['|', '>', '|-', '>-'].includes(value)) {
			const block: string[] = [];
			while (index + 1 < end && (/^\s+\S/.test(lines[index + 1]!) || !lines[index + 1]!.trim())) block.push(lines[++index]!.trim());
			value = block.filter(Boolean).join(value.startsWith('|') ? '\n' : ' ');
		} else if (value.length >= 2 && (value[0] === '"' || value[0] === '\'') && value.at(-1) === value[0]) {
			value = value.slice(1, -1);
		}
		values.set(match[1]!, value);
	}
	const name = values.get('name')?.trim();
	const description = values.get('description')?.trim();
	return { ...(name ? { name } : {}), ...(description ? { description } : {}) };
}

/** 读 SKILL.md：去掉 BOM，换行统一成 \n。 */
function readSkillFile(path: string): string {
	return readFileSync(path, 'utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

/** 拆出开头 `---` 之间的字段行（不含 description）和后面的正文。没有开头字段时全是正文。 */
function splitFrontMatter(content: string): { fields: string[]; body: string } {
	const lines = content.split('\n');
	const end = lines[0]?.trim() === '---' ? lines.findIndex((line, index) => index > 0 && line.trim() === '---') : -1;
	if (end < 0) return { fields: [], body: content.replace(/^\n+/, '') };
	const fields: string[] = [];
	for (let index = 1; index < end; index++) {
		if (!/^description:/.test(lines[index]!)) {
			fields.push(lines[index]!);
			continue;
		}
		// 跳过 description 和它缩进的续行。
		while (index + 1 < end && /^\s+\S/.test(lines[index + 1]!)) index++;
	}
	return { fields, body: lines.slice(end + 1).join('\n').replace(/^\n+/, '') };
}

/** 写成 SKILL.md：开头字段（description 放在 name 后面），再是正文。 */
function composeSkill(fields: readonly string[], description: string, body: string): string {
	const text = description.replace(/\s+/g, ' ').trim();
	if (!text) throw invalid('说明不能为空');
	if (text.length > DESCRIPTION_MAX_CHARS) throw invalid(`说明过长，最多 ${DESCRIPTION_MAX_CHARS} 个字符`);
	const content = body.replace(/\r\n?/g, '\n').trim();
	if (!content) throw invalid('正文不能为空');
	if (content.length > CONTENT_MAX_CHARS) throw invalid(`正文过长，最多 ${CONTENT_MAX_CHARS} 个字符`);
	// 能直接写的就写在一行；有 YAML 特殊字符时用折叠写法，不用转义。
	const line = /^[^\s\-?:,[\]{}#&*!|>'"%@`]/.test(text) && !/: | #|:$/.test(text) ? `description: ${text}` : `description: >-\n  ${text}`;
	const at = fields.findIndex(field => /^name:/.test(field));
	const all = [...fields.slice(0, at + 1), line, ...fields.slice(at + 1)];
	return `---\n${all.join('\n')}\n---\n\n${content}\n`;
}

/** 复制时跳过隐藏文件和符号链接。 */
function copied(path: string): boolean {
	return !basename(path).startsWith('.') && !lstatSync(path).isSymbolicLink();
}

/** 内置技能（包括覆盖内置的）在前，两组各按名字排。 */
function skillOrder(left: ISkill, right: ISkill): number {
	const builtin = (skill: ISkill) => skill.source === 'builtin' || skill.overridesBuiltin ? 0 : 1;
	return builtin(left) - builtin(right) || left.name.localeCompare(right.name);
}

function isDirectory(path: string): boolean {
	try {
		return lstatSync(path).isDirectory();
	} catch {
		return false;
	}
}

/** 文件夹的大小，不算隐藏文件和符号链接；超过 limit 就不再往下数。 */
function folderSize(directory: string, limit: number): number {
	let total = 0;
	const stack = [directory];
	while (stack.length > 0 && total <= limit) {
		const current = stack.pop()!;
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
			const path = join(current, entry.name);
			if (entry.isDirectory()) stack.push(path);
			else if (entry.isFile()) total += lstatSync(path).size;
		}
	}
	return total;
}

/** 文件夹里的文件，相对路径用 / 分隔，不含隐藏文件；最多列 limit 个。 */
function listFiles(directory: string, limit: number): string[] {
	const files: string[] = [];
	const visit = (current: string) => {
		for (const entry of readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
			if (files.length >= limit) return;
			if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
			const path = join(current, entry.name);
			if (entry.isDirectory()) visit(path);
			else files.push(relative(directory, path).split(sep).join('/'));
		}
	};
	visit(directory);
	return files;
}
