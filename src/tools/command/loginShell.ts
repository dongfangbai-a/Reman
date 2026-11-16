/**
 * bash 登录一次，记下登录改了哪些环境变量；之后的命令不登录（-c），开头带上这些改动。
 * Git Bash 每条命令都登录（-lc）要多跑一遍 /etc/profile，每条多约 0.3 秒。见 RUNTIME_DESIGN.md「命令的执行环境」。
 */
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, win32 } from 'node:path';
import { killProcessTree } from '../../common/process.ts';

/** 放登录改动的环境变量：命令开头读入后删掉。 */
export const LOGIN_VARIABLE = 'REMAN_SHELL_LOGIN';
const CAPTURE_TIMEOUT_MS = 10_000;
/** 每次都不同、或者是 shell 自己维护的，不算登录的改动。 */
const SKIPPED = new Set(['PWD', 'OLDPWD', 'SHLVL', '_', LOGIN_VARIABLE]);
/** 隔开登录时配置文件输出的内容（如 echo），只取它后面的。 */
const MARK = '__REMAN_EXPORTED__';
/** 列出全部导出的变量：名字、值后面各跟一个 NUL，值里可能有换行。 */
const LIST_EXPORTED = `printf '%s\\0' ${MARK}; for name in $(compgen -e); do printf '%s\\0%s\\0' "$name" "\${!name}"; done`;
/** 家目录下 bash 登录时会读的配置。 */
const HOME_FILES = ['.bash_profile', '.bash_login', '.profile', '.bashrc'];

export class LoginShells {
	private readonly entries = new Map<string, { readonly stamp: string; readonly changes: Promise<string | undefined> }>();

	/**
	 * 这个 bash 登录改动的环境，写成 export、unset 的脚本，没有改动时是空字符串；记不下来时是 undefined，这时照旧登录执行。
	 * env 是命令执行时的环境。配置文件的修改时间变了就重新记；记不下来的，配置文件没变就不再试。
	 */
	changes(executable: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
		const stamp = configStamp(executable, env);
		const entry = this.entries.get(executable);
		if (entry?.stamp === stamp) return entry.changes;
		const changes = capture(executable, env);
		this.entries.set(executable, { stamp, changes });
		return changes;
	}
}

async function capture(executable: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
	const [login, plain] = await Promise.all([listExported(executable, '-lc', env), listExported(executable, '-c', env)]);
	if (!login || !plain) return undefined;
	const lines: string[] = [];
	for (const [name, value] of login) {
		if (!SKIPPED.has(name) && plain.get(name) !== value) lines.push(`export ${name}=${quote(value)}`);
	}
	for (const name of plain.keys()) {
		if (!SKIPPED.has(name) && !login.has(name)) lines.push(`unset ${name}`);
	}
	return lines.join('\n');
}

/** 跑一次 bash，列出导出的变量。启动不了、超时、输出不对时是 undefined。 */
function listExported(executable: string, flag: '-lc' | '-c', env: NodeJS.ProcessEnv): Promise<Map<string, string> | undefined> {
	return new Promise(resolve => {
		const child = spawn(executable, [flag, LIST_EXPORTED], {
			cwd: homedir(), env, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, detached: process.platform !== 'win32',
		});
		const chunks: Buffer[] = [];
		const timer = setTimeout(() => killProcessTree(child), CAPTURE_TIMEOUT_MS);
		child.stdout!.on('data', (chunk: Buffer) => chunks.push(chunk));
		child.on('error', () => {
			clearTimeout(timer);
			resolve(undefined);
		});
		child.on('close', code => {
			clearTimeout(timer);
			const output = Buffer.concat(chunks).toString('utf8');
			const start = output.indexOf(`${MARK}\0`);
			if (code !== 0 || start < 0) return resolve(undefined);
			const parts = output.slice(start + MARK.length + 1).split('\0');
			// 最后一项后面也有 NUL，拆出来多一个空串。
			if (parts.pop() !== '' || parts.length % 2 !== 0) return resolve(undefined);
			const exported = new Map<string, string>();
			for (let index = 0; index < parts.length; index += 2) exported.set(parts[index]!, parts[index + 1]!);
			resolve(exported);
		});
	});
}

function quote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** bash 和它登录时读的配置文件的修改时间，变了就要重新记。 */
function configStamp(executable: string, env: NodeJS.ProcessEnv): string {
	const etc = etcDirectory(executable);
	const home = env['HOME'] || homedir();
	const files = [executable, join(etc, 'profile'), join(etc, 'profile.d'), join(etc, 'bash.bashrc'), ...HOME_FILES.map(file => join(home, file))];
	return files.map(file => statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? '-').join(',');
}

/**
 * bash 看到的 /etc 在哪。Windows 上在安装目录里：Git 的 bin\bash.exe、usr\bin\bash.exe 都是 Git\etc，
 * MSYS2 的 usr\bin\bash.exe 是 msys64\etc，Cygwin 的 bin\bash.exe 是 cygwin64\etc。
 */
function etcDirectory(executable: string): string {
	if (process.platform !== 'win32') return '/etc';
	const directory = win32.dirname(executable);
	const candidates = [win32.resolve(directory, '..', 'etc'), win32.resolve(directory, '..', '..', 'etc')];
	return candidates.find(candidate => existsSync(win32.join(candidate, 'profile'))) ?? candidates[0]!;
}
