/** 运行时所在的系统（Node 的 process.platform），认路径时用。 */
export type Platform = string;

const DRIVE_PATH = /^[A-Za-z]:[\\/]/;
/** 有协议的地址：http:、mailto: 这类。盘符（E:）只有一个字母，不算。 */
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]+:/;

/** 是不是完整路径：Windows 的盘符路径总是认；/ 开头的只在运行时不在 Windows 上时认，免得把 /v1/state 这类接口路径当成文件。 */
export function isFullPath(text: string, platform: Platform | undefined): boolean {
	if (DRIVE_PATH.test(text)) return true;
	return platform !== undefined && platform !== 'win32' && /^\/[^/\s]/.test(text);
}

/** 链接指向的本机文件；网址和相对路径是 undefined。file: 网址也认。地址里的 %20 这类编码先解开。 */
export function linkedFile(href: string, platform: Platform | undefined): string | undefined {
	let path = href;
	if (/^file:/i.test(path)) {
		path = path.replace(/^file:\/*/i, DRIVE_PATH.test(path.replace(/^file:\/*/i, '')) ? '' : '/');
	} else if (SCHEME.test(path)) {
		return undefined;
	}
	try {
		path = decodeURI(path);
	} catch {
		// 编码不完整时按原样。
	}
	return isFullPath(path, platform) ? path : undefined;
}

/**
 * 工具参数里的文件路径算成完整路径，和运行时执行工具时一样（运行时的 resolveToolPath）：去掉两端的引号，认 file: 网址，
 * 运行时在 Windows 上时 /c/a、/cygdrive/c/a 这类 bash 写法换成 C:\a；相对路径按工作目录算。算不出来时是 undefined。
 */
export function toolFilePath(raw: string, workingDirectory: string | undefined, platform: Platform | undefined): string | undefined {
	let path = raw.trim();
	if (path.length >= 2 && (path[0] === '"' || path[0] === '\'') && path.at(-1) === path[0]) path = path.slice(1, -1).trim();
	if (!path) return undefined;
	if (/^file:/i.test(path)) return linkedFile(path, platform);
	if (platform === 'win32') {
		const drive = /^(?:\/cygdrive)?\/([a-zA-Z])(?:\/(.*))?$/i.exec(path);
		if (drive) return `${drive[1]!.toUpperCase()}:\\${(drive[2] ?? '').replace(/\//g, '\\')}`;
		if (/^[\\/][a-zA-Z]:[\\/]/.test(path)) path = path.slice(1);
	}
	if (isFullPath(path, platform)) return path;
	if (!workingDirectory || platform === undefined) return undefined;
	if (/^[\\/]/.test(path)) {
		// Windows 上 \a 这样的是工作目录所在盘的根目录下；\\ 开头的网络路径不认。
		return platform === 'win32' && !/^[\\/]{2}/.test(path) && DRIVE_PATH.test(workingDirectory) ? resolvePath(workingDirectory.slice(0, 3), path.slice(1)) : undefined;
	}
	return resolvePath(workingDirectory, path);
}

/** 是不是网址这类有协议的地址（盘符路径不算）。 */
export function isWebLink(href: string): boolean {
	return SCHEME.test(href) && !/^file:/i.test(href);
}

/** 文件所在的目录。 */
export function directoryOf(path: string): string {
	const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
	return index <= 0 ? path.slice(0, index + 1) : DRIVE_PATH.test(path) && index === 2 ? path.slice(0, 3) : path.slice(0, index);
}

/** 文件名。 */
export function fileName(path: string): string {
	return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

/** 相对路径按 directory 算出完整路径，分隔符跟着 directory。已经是完整路径的原样返回。 */
export function resolvePath(directory: string, relative: string): string {
	if (DRIVE_PATH.test(relative) || relative.startsWith('/')) return relative;
	const separator = directory.includes('\\') ? '\\' : '/';
	const parts = directory.split(/[\\/]/);
	if (parts.at(-1) === '') parts.pop();
	for (const part of relative.split(/[\\/]/)) {
		if (part === '' || part === '.') continue;
		if (part === '..') {
			if (parts.length > 1) parts.pop();
		} else {
			parts.push(part);
		}
	}
	return parts.length === 1 ? `${parts[0]}${separator}` : parts.join(separator);
}

/**
 * 链接地址是有空格的完整路径时（[报告](E:/My Docs/a.md)），Markdown 认不出是链接：补成 <...>。
 * 不要求模型写得完全规范。
 */
export function fixSpacedLinks(markdown: string): string {
	return markdown.replace(/\]\(((?:[A-Za-z]:[\\/]|\/)[^()<>\n]*\s[^()<>\n]*)\)/g, (_, path: string) => `](<${path.trim()}>)`);
}
