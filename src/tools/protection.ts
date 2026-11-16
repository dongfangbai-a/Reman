import { realpath } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { contains } from './paths.ts';

/** 数据目录里读也要审批的：令牌和密钥；成员浏览器的数据（cookie 和网站的登录状态）；数据库（所有对话）。沙箱里读不到。 */
const SENSITIVE: readonly { readonly name: string; readonly reason: string; readonly directory?: true }[] = [
	...['access-token', 'runtime.json', 'secret-key'].map(name => ({ name, reason: '涉及运行时的令牌和密钥' })),
	{ name: 'browsers', reason: '涉及成员浏览器的数据', directory: true },
	...['runtime.sqlite', 'runtime.sqlite-wal', 'runtime.sqlite-shm'].map(name => ({ name, reason: '涉及全部对话数据' })),
];

/** 数据目录里读也要审批的文件和目录，目录的末尾带分隔符（srt 给还不存在的路径建占位时，按这个建成目录）。 */
export function sensitivePaths(dataDirectory: string): string[] {
	return SENSITIVE.map(item => join(dataDirectory, item.name) + (item.directory ? sep : ''));
}

export interface IDataDirectories {
	readonly dataDirectory: string;
	/** 成员默认的工作目录都在这里，不受保护。 */
	readonly workspacesDirectory: string;
	readonly membersDirectory: string;
	readonly skillsDirectory: string;
	readonly eventRoutesDirectory: string;
	readonly customToolsDirectory: string;
}

/** 一个路径碰到了运行时的什么数据，以及给用户看的说明。 */
export interface IDataTouch {
	/** sensitive：读也要审批的（令牌和密钥、成员浏览器的数据、数据库），或者整个数据目录（数据目录本身或它的上级）；protected：受保护范围里的其他地方。 */
	readonly kind: 'sensitive' | 'protected';
	readonly reason: string;
}

/**
 * 运行时自己的数据：数据目录里除了 workspaces/ 以外的地方是受保护的范围。成员改这些、读里面的敏感文件，
 * 不管审批方式都要审批。除了按路径比较，还按真实路径比较，防止通过符号链接绕过。没给目录时不保护数据目录。
 * 另外，任何 git 仓库的钩子和配置也算受保护的：git 会执行里面写的程序，见设计文档「保护运行时的数据」。
 */
export class DataProtection {
	private readonly directories: IDataDirectories | undefined;
	private real: Promise<IDataDirectories> | undefined;

	constructor(directories?: IDataDirectories) {
		this.directories = directories;
	}

	get enabled(): boolean {
		return this.directories !== undefined;
	}

	/** 路径碰到了什么；没碰到运行时的数据、git 的钩子和配置时是 undefined。 */
	async touch(path: string): Promise<IDataTouch | undefined> {
		return await this.dataTouch(path) ?? gitTouch(path) ?? gitTouch(await realPath(path));
	}

	/** 读这些文件要审批的原因：只看敏感文件，受保护范围里的其他文件照常读。去掉重复的。 */
	async readReasons(paths: readonly string[]): Promise<string[]> {
		const touches = await Promise.all(paths.map(path => this.touch(path)));
		return [...new Set(touches.filter(touch => touch?.kind === 'sensitive').map(touch => touch!.reason))];
	}

	/** 本机文件网址或路径是不是在受保护的数据范围里（包括敏感文件，不包括 git 的钩子和配置）。 */
	async isProtected(path: string): Promise<boolean> {
		return await this.dataTouch(path) !== undefined;
	}

	private async dataTouch(path: string): Promise<IDataTouch | undefined> {
		if (!this.directories) return undefined;
		const lexical = classify(this.directories, path);
		if (lexical?.kind === 'sensitive') return lexical;
		this.real ??= realDirectories(this.directories);
		return classify(await this.real, await realPath(path)) ?? lexical;
	}
}

/**
 * git 会执行的：.git/hooks 里的脚本，.git/config 里配置的程序（子模块、工作树在 .git 下面的也一样）。
 * 整个 .git 目录被换掉也算。Windows 上不区分大小写。
 */
function gitTouch(path: string): IDataTouch | undefined {
	const segments = path.split(/[\\/]/);
	const name = (segment: string) => process.platform === 'win32' ? segment.toLowerCase() : segment;
	const index = segments.findIndex(segment => name(segment) === '.git');
	if (index < 0) return undefined;
	const rest = segments.slice(index + 1).filter(Boolean);
	if (rest.length && !rest.some(segment => name(segment) === 'config' || name(segment) === 'hooks')) return undefined;
	return { kind: 'protected', reason: `修改 git 的钩子和配置：${segments.slice(Math.max(0, index - 1)).join('/')}` };
}

function classify(directories: IDataDirectories, path: string): IDataTouch | undefined {
	const { dataDirectory, workspacesDirectory, membersDirectory, skillsDirectory, eventRoutesDirectory, customToolsDirectory } = directories;
	if (contains(path, dataDirectory)) return { kind: 'sensitive', reason: `涉及整个数据目录：${path}` };
	if (!contains(dataDirectory, path) || contains(workspacesDirectory, path)) return undefined;
	const sensitive = SENSITIVE.find(item => contains(join(dataDirectory, item.name), path));
	if (sensitive) return { kind: 'sensitive', reason: `${sensitive.reason}：${relative(dataDirectory, path).split(sep).join('/')}` };
	const member = firstSegment(membersDirectory, path);
	if (member && member !== 'INDEX.md') return { kind: 'protected', reason: `修改成员配置：${member}` };
	const skill = firstSegment(skillsDirectory, path);
	if (skill) return { kind: 'protected', reason: `修改技能：${skill}` };
	const route = firstSegment(eventRoutesDirectory, path);
	if (route) return { kind: 'protected', reason: `修改事件路由：${route.replace(/\.js$/, '')}` };
	const customTool = firstSegment(customToolsDirectory, path);
	if (customTool) return { kind: 'protected', reason: `修改自定义工具：${customTool}` };
	return { kind: 'protected', reason: `修改运行时的数据：${relative(dataDirectory, path).split(sep).join('/')}` };
}

/** path 在 root 里面时，它在 root 下的第一级名字。 */
function firstSegment(root: string, path: string): string | undefined {
	if (!contains(root, path)) return undefined;
	return relative(root, path).split(sep)[0] || undefined;
}

async function realDirectories(directories: IDataDirectories): Promise<IDataDirectories> {
	const entries = await Promise.all(Object.entries(directories).map(async ([key, path]) => [key, await realPath(path)] as const));
	return Object.fromEntries(entries) as unknown as IDataDirectories;
}

/** 真实路径。路径可能还不存在：找到最近一个存在的上级，换成真实路径再接上后面的部分。 */
async function realPath(path: string): Promise<string> {
	for (let current = path; ; current = dirname(current)) {
		try {
			return join(await realpath(current), relative(current, path));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(current) === current) return path;
		}
	}
}
