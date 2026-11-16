import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { invalid } from '../common/errors.ts';

/**
 * 模型写的路径转成绝对路径。去掉两端引号，支持 file:// 网址；Windows 上把 /e/a、/cygdrive/e/a 这类 bash 写法转成 E:\a。
 * 相对路径相对于工作目录。
 */
export function resolveToolPath(workingDirectory: string, raw: string): string {
	let path = raw.trim();
	if (path.length >= 2 && (path[0] === '"' || path[0] === '\'') && path.at(-1) === path[0]) path = path.slice(1, -1).trim();
	if (!path) throw invalid('文件路径不能为空');
	if (path.toLowerCase().startsWith('file://')) {
		try {
			path = fileURLToPath(new URL(path));
		} catch {
			throw invalid(`file:// 路径格式有误：${raw}`);
		}
	}
	if (process.platform === 'win32') {
		const drive = /^(?:\/cygdrive)?\/([a-zA-Z])(?:\/(.*))?$/i.exec(path);
		if (drive) return win32.normalize(`${drive[1]!.toUpperCase()}:\\${drive[2] ?? ''}`);
		if (/^[\\/][a-zA-Z]:[\\/]/.test(path)) path = path.slice(1);
	}
	return resolve(workingDirectory, path);
}

/** 路径是否在工作目录里。除了按路径比较，还要按真实路径比较，防止通过符号链接指到外面。 */
export async function isInside(workingDirectory: string, path: string): Promise<boolean> {
	if (!contains(workingDirectory, path)) return false;
	let realRoot: string;
	try {
		realRoot = await realpath(workingDirectory);
	} catch {
		return true;
	}
	// 文件可能还不存在：找到最近一个存在的上级目录来比较。
	for (let current = path; ; current = dirname(current)) {
		try {
			return contains(realRoot, await realpath(current));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(current) === current) return false;
		}
	}
}

/** 只按路径比较，path 是不是 root 本身或在它里面。 */
export function contains(root: string, path: string): boolean {
	const relativePath = relative(root, path);
	return relativePath === '' || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
}
