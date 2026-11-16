import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { invalid } from '../common/errors.ts';

/** 一个目录的子目录，给浏览选择目录用。读不了时 error 写原因，directories 为空。 */
export interface IDirectoryListing {
	/** 不给路径时为 null，只看 home 和 roots。 */
	readonly path: string | null;
	/** 已经是根目录或盘符时为 null。 */
	readonly parent: string | null;
	readonly directories: readonly { readonly name: string; readonly path: string }[];
	readonly error?: string;
	readonly home: string;
	/** 各个盘符，不是 Windows 时只有根目录。 */
	readonly roots: readonly string[];
}

/** 列出目录下的子目录，不含隐藏目录（名字以点开头的，Windows 上以 $ 开头的系统目录）。 */
export function listDirectories(path: string | undefined): IDirectoryListing {
	const base = { home: homedir(), roots: roots() };
	if (path === undefined || !path.trim()) return { ...base, path: null, parent: null, directories: [] };
	if (!isAbsolute(path.trim())) throw invalid('路径必须是绝对路径');
	const full = resolve(path.trim());
	const parentPath = dirname(full);
	const parent = parentPath === full ? null : parentPath;
	if (!existsSync(full)) return { ...base, path: full, parent, directories: [], error: '目录不存在' };
	try {
		const directories = readdirSync(full, { withFileTypes: true })
			.filter(entry => entry.isDirectory() && !hidden(entry.name))
			.map(entry => ({ name: entry.name, path: join(full, entry.name) }))
			.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN', { sensitivity: 'base' }));
		return { ...base, path: full, parent, directories };
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return { ...base, path: full, parent, directories: [], error: code === 'EPERM' || code === 'EACCES' ? '没有权限读取该目录' : code === 'ENOTDIR' ? '该路径不是目录' : '无法读取该目录' };
	}
}

function hidden(name: string): boolean {
	return name.startsWith('.') || process.platform === 'win32' && (name.startsWith('$') || name === 'System Volume Information');
}

function roots(): string[] {
	if (process.platform !== 'win32') return ['/'];
	return [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map(letter => `${letter}:\\`).filter(drive => existsSync(drive));
}
