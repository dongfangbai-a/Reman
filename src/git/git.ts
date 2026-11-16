import { spawn } from 'node:child_process';
import { lstat, open, readlink, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { RuntimeError, invalid, notFound } from '../common/errors.ts';
import { killProcessTree } from '../common/process.ts';

/** 每条 git 命令最多多久。 */
const TIMEOUT_MS = 15_000;
/** diff 最多这么多字节、这么多行，超出的截掉。 */
const MAX_DIFF_BYTES = 1024 * 1024;
const MAX_DIFF_LINES = 5000;
/** 改动每组最多列这么多个。 */
const MAX_CHANGES = 1000;
/** 提交历史一次最多取这么多个。 */
export const MAX_LOG = 200;
/** 其他命令输出的上限：status 之类超过这么多说明仓库大得异常，报错而不是一直读。 */
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
/** 未跟踪的文件看开头这么多字节有没有 NUL，有就当二进制，和 git 的判断一样。 */
const BINARY_SNIFF_BYTES = 8000;

export type GitChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'typeChanged';

/** 改了的一个文件。未跟踪的文件没有行数；二进制文件没有行数，binary 为 true。 */
export interface IGitChange {
	readonly path: string;
	readonly oldPath?: string;
	readonly status: GitChangeStatus;
	readonly added?: number;
	readonly removed?: number;
	readonly binary?: boolean;
}

export type GitState = 'merging' | 'rebasing' | 'cherry-picking' | 'reverting' | 'bisecting';

export interface IGitStatus {
	readonly root: string;
	/** 当前分支名；不在任何分支上时是 null。 */
	readonly branch: string | null;
	/** 当前提交；空仓库时是 null。 */
	readonly head: { readonly hash: string; readonly subject: string } | null;
	/** 跟踪的远程分支，领先、落后是和上次获取远程时比的。 */
	readonly upstream: { readonly name: string; readonly ahead: number; readonly behind: number } | null;
	/** 上次获取远程的时间（FETCH_HEAD 的修改时间），没获取过是 null。 */
	readonly fetchedAt: number | null;
	readonly state: GitState | null;
	readonly changes: {
		readonly conflicted: readonly IGitChange[];
		readonly staged: readonly IGitChange[];
		readonly unstaged: readonly IGitChange[];
		readonly untracked: readonly IGitChange[];
	};
	/** 有哪一组超过了上限、没列全。 */
	readonly truncated: boolean;
}

export interface IGitCommit {
	readonly hash: string;
	readonly parents: readonly string[];
	readonly author: string;
	readonly email: string;
	readonly authoredAt: number;
	readonly subject: string;
}

export interface IGitCommitDetail extends IGitCommit {
	readonly message: string;
	readonly files: readonly IGitChange[];
}

export type GitDiffArea = 'staged' | 'unstaged' | 'untracked' | 'commit';

export interface IGitDiff {
	/** 统一 diff 的文字；未跟踪的文件只有一段 @@ 和全部新增的行。 */
	readonly diff: string;
	readonly binary: boolean;
	readonly truncated: boolean;
}

export interface IGitRepositoryInfo {
	/** 找不到 git 时是 false。 */
	readonly available: boolean;
	readonly repository: { readonly root: string; readonly branch: string | null } | null;
	/** 是仓库但 git 报错时（如目录的所有者不对）的原话。 */
	readonly error?: string;
}

interface IRunOptions {
	/** 除了 0 以外也算正常的退出码。 */
	readonly allowExit?: readonly number[];
	/** 输出最多读这么多字节，超出的截掉、结束进程，truncated 为 true；不给时超过上限报错。 */
	readonly maxBytes?: number;
	/** 加在命令行配置后面的配置（GIT_CONFIG_COUNT 那一套），关掉仓库里配的过滤器用。 */
	readonly config?: readonly (readonly [string, string])[];
}

interface IRunResult {
	readonly stdout: string;
	readonly code: number;
	readonly truncated: boolean;
}

/**
 * 网页端 Git 面板用的只读查询（API.md「Git 仓库」）。用命令行的 git，参数逐个传，不经过 shell。
 * 这些命令在沙箱外、以使用者的身份运行，而成员在沙箱里能改仓库的配置，所以：
 * - 不执行仓库里配置的程序：关掉 fsmonitor、外部 diff、textconv、过滤器（clean、smudge、process），不验证签名，不进子模块的工作区；
 * - 不连网：部分克隆缺对象时 git 会去远程取，可能执行仓库配置的 ssh 命令或凭据助手，关掉；
 * - 不碰锁（--no-optional-locks），成员同时在用 git 时不让它报「另一个 git 进程在运行」；
 * - 不等输入，每条命令最多 15 秒。
 */
export class GitReader {
	private readonly locate: () => string | undefined;

	constructor(locate: () => string | undefined) {
		this.locate = locate;
	}

	/** 目录在不在 Git 仓库里，和当前分支。目录卡片用，只跑两条很快的命令。 */
	async repository(path: string): Promise<IGitRepositoryInfo> {
		if (!this.locate()) return { available: false, repository: null };
		const directory = await stat(path).then(stats => stats.isDirectory(), () => false);
		if (!directory) return { available: true, repository: null };
		const top = await this.run(path, ['rev-parse', '--show-toplevel'], { allowExit: [128] });
		if (top.code !== 0) {
			const message = top.stdout;
			// 不是仓库、在 .git 里面、裸仓库：都不算仓库。别的错（目录的所有者不对等）照原话给出去。
			return /not a git repository|must be run in a work tree/i.test(message) || !message
				? { available: true, repository: null }
				: { available: true, repository: null, error: message };
		}
		const root = resolve(top.stdout.trim());
		return { available: true, repository: { root, branch: await this.branch(root) } };
	}

	async status(root: string): Promise<IGitStatus> {
		const config = await this.filterOverrides(root);
		const diffOptions = ['--no-ext-diff', '--no-textconv', '--no-color', '--ignore-submodules=dirty', '--numstat', '-z'];
		const [status, staged, unstaged, paths] = await allFinished([
			this.run(root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all', '--ignore-submodules=dirty', '--renames'], { config }),
			this.run(root, ['diff', '--cached', '-M', ...diffOptions], { config }).then(result => parseNumstat(result.stdout), () => new Map<string, ICounts>()),
			this.run(root, ['diff', ...diffOptions], { config }).then(result => parseNumstat(result.stdout), () => new Map<string, ICounts>()),
			this.run(root, ['rev-parse', ...GIT_PATHS.flatMap(name => ['--git-path', name])]),
		]);
		const parsed = parseStatus(status.stdout);
		// rev-parse --git-path 按给的顺序一行一个，相对仓库根目录。
		const located = paths.stdout.split('\n').slice(0, GIT_PATHS.length).map(line => resolve(root, line.trim()));
		const [fetch, merge, rebaseMerge, rebaseApply, cherryPick, revert, bisect] = await Promise.all(located.map(path => stat(path).then(stats => stats, () => undefined)));
		const state: GitState | null = rebaseMerge || rebaseApply ? 'rebasing' : merge ? 'merging' : cherryPick ? 'cherry-picking' : revert ? 'reverting' : bisect ? 'bisecting' : null;
		const head = parsed.oid ? { hash: parsed.oid, subject: (await this.run(root, ['log', '-1', '--format=%s', parsed.oid, '--'])).stdout.trim() } : null;
		const withCounts = (changes: readonly IGitChange[], counts: ReadonlyMap<string, ICounts>) => changes.map(change => ({ ...change, ...counts.get(change.path) }));
		const groups = {
			conflicted: parsed.conflicted,
			staged: withCounts(parsed.staged, staged),
			unstaged: withCounts(parsed.unstaged, unstaged),
			untracked: parsed.untracked,
		};
		const truncated = Object.values(groups).some(group => group.length > MAX_CHANGES);
		return {
			root,
			branch: parsed.branch,
			head,
			upstream: parsed.upstream,
			fetchedAt: fetch ? fetch.mtimeMs : null,
			state,
			changes: {
				conflicted: groups.conflicted.slice(0, MAX_CHANGES),
				staged: groups.staged.slice(0, MAX_CHANGES),
				unstaged: groups.unstaged.slice(0, MAX_CHANGES),
				untracked: groups.untracked.slice(0, MAX_CHANGES),
			},
			truncated,
		};
	}

	/**
	 * 当前分支的提交，从新到旧，只沿第一个父提交走：一条线，翻页用上一页最后一个提交接着往下取，不会漏也不会重复。
	 * 空仓库时没有提交。
	 */
	async log(root: string, before: string | undefined, limit: number): Promise<IGitCommit[]> {
		if (before !== undefined) checkHash(before);
		const count = Math.max(1, Math.min(MAX_LOG, Math.floor(limit) || 50));
		const start = before ?? 'HEAD';
		if ((await this.run(root, ['rev-parse', '-q', '--verify', `${start}^{commit}`], { allowExit: [1] })).code !== 0) {
			if (before === undefined) return [];
			throw invalid(`不存在提交 ${before}`);
		}
		const result = await this.run(root, ['log', '--first-parent', '-z', `--format=${COMMIT_FORMAT}`, '-n', String(before ? count + 1 : count), start, '--']);
		const commits = result.stdout.split('\0').filter(Boolean).map(parseCommit);
		return before ? commits.slice(1) : commits;
	}

	/** 一个提交：完整的提交说明，和它相对第一个父提交改了哪些文件（第一个提交和空的比）。 */
	async commit(root: string, hash: string): Promise<IGitCommitDetail> {
		checkHash(hash);
		const info = await this.run(root, ['log', '-1', `--format=${COMMIT_FORMAT}%x1f%B`, hash, '--']);
		const fields = info.stdout.split('\x1f');
		const commit = parseCommit(fields.slice(0, 6).join('\x1f'));
		const message = fields.slice(6).join('\x1f').replace(/\s+$/, '');
		const range = this.commitRange(commit);
		const [names, counts] = await allFinished([
			this.run(root, ['diff-tree', '-r', '-z', '-M', '--no-commit-id', '--no-ext-diff', '--name-status', ...range]),
			this.run(root, ['diff-tree', '-r', '-z', '-M', '--no-commit-id', '--no-ext-diff', '--numstat', ...range]),
		]);
		const numbers = parseNumstat(counts.stdout);
		const files = parseNameStatus(names.stdout).map(change => ({ ...change, ...numbers.get(change.path) }));
		return { ...commit, message, files };
	}

	/** 一个文件的 diff。改名时带上 oldPath，两个路径一起比，才看得出是改名。 */
	async diff(root: string, request: { readonly file: string; readonly oldPath?: string; readonly area: GitDiffArea; readonly commit?: string }): Promise<IGitDiff> {
		const { file, oldPath, area } = request;
		for (const path of [file, ...oldPath ? [oldPath] : []]) checkRelative(path);
		if (area === 'untracked') return untrackedDiff(resolve(root, file));
		const paths = ['--', ...oldPath ? [oldPath] : [], file];
		const options = ['-M', '--no-ext-diff', '--no-textconv', '--no-color', '--ignore-submodules=dirty'];
		let result: IRunResult;
		if (area === 'commit') {
			if (!request.commit) throw invalid('缺少 commit');
			checkHash(request.commit);
			const parents = (await this.run(root, ['rev-list', '--parents', '-n', '1', request.commit, '--'])).stdout.trim().split(' ').slice(1);
			result = await this.run(root, ['diff-tree', '-p', '-r', '--no-commit-id', ...options, ...this.commitRange({ hash: request.commit, parents }), ...paths], { maxBytes: MAX_DIFF_BYTES });
		} else if (area === 'staged' || area === 'unstaged') {
			const config = await this.filterOverrides(root);
			result = await this.run(root, ['diff', ...area === 'staged' ? ['--cached'] : [], ...options, ...paths], { maxBytes: MAX_DIFF_BYTES, config });
		} else {
			throw invalid('area 必须是 staged、unstaged、untracked、commit 之一');
		}
		const binary = /^Binary files .* differ$/m.test(result.stdout) || result.stdout.includes('GIT binary patch');
		const limited = limitLines(result.stdout);
		return { diff: limited.text, binary, truncated: result.truncated || limited.truncated };
	}

	/** 和第一个父提交比；第一个提交和空的比。 */
	private commitRange(commit: Pick<IGitCommit, 'hash' | 'parents'>): string[] {
		return commit.parents.length > 0 ? [commit.parents[0]!, commit.hash] : ['--root', commit.hash];
	}

	private async branch(root: string): Promise<string | null> {
		const result = await this.run(root, ['symbolic-ref', '--short', '-q', 'HEAD'], { allowExit: [1] });
		return result.code === 0 ? result.stdout.trim() || null : null;
	}

	/**
	 * 仓库里配的过滤器（filter.<名字>.clean 等）在 status、diff 读工作区的文件时会执行，全部换成空的。
	 * 配置里的名字要先读出来才知道换哪些；required 也关掉，不然没执行过滤器 git 会报错。
	 */
	private async filterOverrides(root: string): Promise<(readonly [string, string])[]> {
		const result = await this.run(root, ['config', '-z', '--name-only', '--get-regexp', '^filter\\.'], { allowExit: [1] });
		const drivers = new Set(result.stdout.split('\0').map(entry => entry.split('\n')[0]!).filter(Boolean)
			.map(name => name.slice('filter.'.length, name.lastIndexOf('.'))).filter(Boolean));
		return [...drivers].flatMap(driver => [[`filter.${driver}.clean`, ''], [`filter.${driver}.smudge`, ''], [`filter.${driver}.process`, ''], [`filter.${driver}.required`, 'false']] as const);
	}

	/** 跑一条 git 命令。退出码不对时用 git 的报错原话报错；allowExit 里的退出码照常返回，stdout 换成报错的原话。 */
	private async run(cwd: string, args: readonly string[], options: IRunOptions = {}): Promise<IRunResult> {
		const git = this.locate();
		if (!git) throw new RuntimeError('git_unavailable', '未找到 git');
		// 开着的标签，仓库可能已经被删了、改名了：先说清楚，不然只有 git 启动失败的退出码。
		const directory = await stat(cwd).catch(() => undefined);
		if (!directory) throw notFound('仓库文件夹已不存在');
		if (!directory.isDirectory()) throw invalid('仓库路径不是文件夹');
		const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_LITERAL_PATHSPECS: '1', GIT_PAGER: 'cat', GIT_NO_LAZY_FETCH: '1' };
		// 运行时自己可能是从 git 的钩子里启动的，这些变量会让 git 去看别的仓库。
		for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CEILING_DIRECTORIES', 'GIT_CONFIG_PARAMETERS']) delete env[name];
		const config = options.config ?? [];
		env['GIT_CONFIG_COUNT'] = String(config.length);
		config.forEach(([key, value], index) => {
			env[`GIT_CONFIG_KEY_${index}`] = key;
			env[`GIT_CONFIG_VALUE_${index}`] = value;
		});
		const fullArgs = ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.quotepath=false', '-c', 'log.showSignature=false', '-c', 'color.ui=false', '-c', 'protocol.allow=never', ...args];
		return new Promise((resolvePromise, reject) => {
			const child = spawn(git, fullArgs, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
			const chunks: Buffer[] = [];
			const errors: Buffer[] = [];
			let size = 0;
			let errorSize = 0;
			let truncated = false;
			let failure: RuntimeError | undefined;
			const timer = setTimeout(() => {
				failure = new RuntimeError('git_timeout', `git 命令超过 ${TIMEOUT_MS / 1000} 秒仍未结束，仓库可能过大`);
				killProcessTree(child);
			}, TIMEOUT_MS);
			child.stdout.on('data', (chunk: Buffer) => {
				if (truncated || failure) return;
				const limit = options.maxBytes ?? MAX_OUTPUT_BYTES;
				if (size + chunk.length > limit) {
					chunks.push(chunk.subarray(0, limit - size));
					size = limit;
					if (options.maxBytes === undefined) failure = new RuntimeError('git_output_too_large', 'git 的输出过多，仓库可能过大');
					else truncated = true;
					killProcessTree(child);
					return;
				}
				chunks.push(chunk);
				size += chunk.length;
			});
			child.stderr.on('data', (chunk: Buffer) => {
				if (errorSize < 64 * 1024) errors.push(chunk);
				errorSize += chunk.length;
			});
			child.on('error', error => {
				clearTimeout(timer);
				reject((error as NodeJS.ErrnoException).code === 'ENOENT' ? new RuntimeError('git_unavailable', '未找到 git') : error);
			});
			child.on('close', code => {
				clearTimeout(timer);
				if (failure) return reject(failure);
				const stdout = Buffer.concat(chunks).toString('utf8');
				const stderr = Buffer.concat(errors).toString('utf8').trim();
				if (truncated || code === 0) return resolvePromise({ stdout, code: 0, truncated });
				if (code !== null && options.allowExit?.includes(code)) return resolvePromise({ stdout: stderr, code, truncated: false });
				reject(new RuntimeError('git_error', stderr || `git 执行出错（退出码 ${code}）`));
			});
		});
	}
}

/**
 * 同时跑的几条 git 命令都结束了才返回，有失败的再报第一个错：不让还在跑的 git 留在后面，
 * 它们的工作目录还占着仓库（Windows 上删不掉文件夹）。
 */
async function allFinished<T extends readonly unknown[]>(promises: { readonly [K in keyof T]: Promise<T[K]> }): Promise<T> {
	const results = await Promise.allSettled(promises);
	const failed = results.find(result => result.status === 'rejected');
	if (failed) throw failed.reason;
	return results.map(result => (result as PromiseFulfilledResult<unknown>).value) as unknown as T;
}

/** status 里要看的几个文件：上次获取远程，和正在合并、变基、拣选、还原、二分的标记。 */
const GIT_PATHS = ['FETCH_HEAD', 'MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG'] as const;

/** 提交的几项，用 \x1f 隔开：哈希、父提交、作者、邮箱、时间（秒）、提交说明的第一行。 */
const COMMIT_FORMAT = '%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s';

function parseCommit(text: string): IGitCommit {
	const [hash, parents, author, email, at, subject] = text.replace(/^\n/, '').split('\x1f');
	return { hash: hash!, parents: parents ? parents.split(' ') : [], author: author ?? '', email: email ?? '', authoredAt: Number(at) * 1000, subject: subject ?? '' };
}

interface ICounts {
	readonly added?: number;
	readonly removed?: number;
	readonly binary?: boolean;
}

interface IParsedStatus {
	readonly oid: string | null;
	readonly branch: string | null;
	readonly upstream: IGitStatus['upstream'];
	readonly conflicted: IGitChange[];
	readonly staged: IGitChange[];
	readonly unstaged: IGitChange[];
	readonly untracked: IGitChange[];
}

/** git status --porcelain=v2 --branch -z 的输出。改名的那一项后面多一段原来的路径。 */
export function parseStatus(output: string): IParsedStatus {
	const parsed = { oid: null as string | null, branch: null as string | null, upstream: null as IGitStatus['upstream'], conflicted: [] as IGitChange[], staged: [] as IGitChange[], unstaged: [] as IGitChange[], untracked: [] as IGitChange[] };
	let upstreamName: string | undefined;
	let ahead = 0;
	let behind = 0;
	const fields = output.split('\0');
	for (let index = 0; index < fields.length; index++) {
		const field = fields[index]!;
		if (!field) continue;
		if (field.startsWith('# ')) {
			const [, key, ...rest] = field.split(' ');
			const value = rest.join(' ');
			if (key === 'branch.oid') parsed.oid = value === '(initial)' ? null : value;
			else if (key === 'branch.head') parsed.branch = value === '(detached)' ? null : value;
			else if (key === 'branch.upstream') upstreamName = value;
			else if (key === 'branch.ab') {
				const match = /^\+(\d+) -(\d+)$/.exec(value);
				if (match) [ahead, behind] = [Number(match[1]), Number(match[2])];
			}
			continue;
		}
		const kind = field[0];
		if (kind === '?') {
			parsed.untracked.push({ path: field.slice(2), status: 'added' });
		} else if (kind === 'u') {
			// u XY sub m1 m2 m3 mW h1 h2 h3 path
			parsed.conflicted.push({ path: afterSpaces(field, 10), status: 'modified' });
		} else if (kind === '1' || kind === '2') {
			// 1 XY sub mH mI mW hH hI path；2 XY sub mH mI mW hH hI Xscore path，后面一段是原来的路径。
			const xy = field.slice(2, 4);
			const path = afterSpaces(field, kind === '1' ? 8 : 9);
			const oldPath = kind === '2' ? fields[++index] : undefined;
			const indexStatus = changeStatus(xy[0]!);
			const workStatus = changeStatus(xy[1]!);
			if (indexStatus) parsed.staged.push({ path, ...oldPath ? { oldPath } : {}, status: indexStatus });
			if (workStatus) parsed.unstaged.push({ path, status: workStatus });
		}
	}
	if (upstreamName) parsed.upstream = { name: upstreamName, ahead, behind };
	for (const group of [parsed.conflicted, parsed.staged, parsed.unstaged, parsed.untracked]) group.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
	return parsed;
}

/** 跳过开头这么多个用空格隔开的字段，剩下的是路径（路径里可以有空格）。 */
function afterSpaces(field: string, count: number): string {
	let position = 0;
	for (let skipped = 0; skipped < count; skipped++) position = field.indexOf(' ', position) + 1;
	return field.slice(position);
}

function changeStatus(code: string): GitChangeStatus | undefined {
	switch (code) {
		case 'A': return 'added';
		case 'M': return 'modified';
		case 'D': return 'deleted';
		case 'R': return 'renamed';
		case 'C': return 'copied';
		case 'T': return 'typeChanged';
		default: return undefined;
	}
}

/** --numstat -z：「增\t删\t路径」；改名时路径是空的，后面两段是原来的和现在的路径。二进制文件的行数是「-」。按现在的路径记。 */
export function parseNumstat(output: string): Map<string, ICounts> {
	const counts = new Map<string, ICounts>();
	const fields = output.split('\0');
	for (let index = 0; index < fields.length; index++) {
		const field = fields[index]!.replace(/^\n/, '');
		if (!field) continue;
		const first = field.indexOf('\t');
		const second = field.indexOf('\t', first + 1);
		if (first < 0 || second < 0) continue;
		const added = field.slice(0, first);
		const removed = field.slice(first + 1, second);
		let path = field.slice(second + 1);
		if (!path) {
			index++;
			path = fields[++index] ?? '';
		}
		counts.set(path, added === '-' ? { binary: true } : { added: Number(added), removed: Number(removed) });
	}
	return counts;
}

/** --name-status -z：状态字母（改名、复制带相似度）一段，路径一段，改名、复制多一段原来的路径在前。 */
export function parseNameStatus(output: string): IGitChange[] {
	const changes: IGitChange[] = [];
	const fields = output.split('\0');
	for (let index = 0; index < fields.length; index++) {
		const code = fields[index]!.replace(/^\n/, '');
		if (!code) continue;
		const status = changeStatus(code[0]!) ?? 'modified';
		if (status === 'renamed' || status === 'copied') {
			const oldPath = fields[++index]!;
			changes.push({ path: fields[++index]!, oldPath, status });
		} else {
			changes.push({ path: fields[++index]!, status });
		}
	}
	return changes;
}

/**
 * 未跟踪的文件：整个文件都是新增，自己读出来写成一段 diff，不让 git 去读（读工作区文件会经过过滤器）。
 * 符号链接和 git 一样只显示指向的路径；文件夹（比如里面套着的仓库）不显示内容。
 */
async function untrackedDiff(path: string): Promise<IGitDiff> {
	const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
		throw error.code === 'ENOENT' ? notFound('文件不存在') : error;
	});
	if (info.isDirectory()) throw invalid('该路径是文件夹，不显示内容');
	if (info.isSymbolicLink()) return { diff: `@@ -0,0 +1,1 @@\n+${await readlink(path)}`, binary: false, truncated: false };
	const file = await open(path, 'r');
	try {
		const buffer = Buffer.alloc(MAX_DIFF_BYTES);
		const { bytesRead } = await file.read(buffer, 0, MAX_DIFF_BYTES, 0);
		const content = buffer.subarray(0, bytesRead);
		if (content.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return { diff: '', binary: true, truncated: false };
		const size = (await file.stat()).size;
		const text = content.toString('utf8');
		const lines = text ? text.replace(/\n$/, '').split('\n') : [];
		const kept = lines.slice(0, MAX_DIFF_LINES);
		const diff = lines.length > 0 ? [`@@ -0,0 +1,${lines.length} @@`, ...kept.map(line => `+${line}`)].join('\n') : '';
		return { diff, binary: false, truncated: size > bytesRead || lines.length > kept.length };
	} finally {
		await file.close();
	}
}

/** 最多留 MAX_DIFF_LINES 行。 */
function limitLines(text: string): { text: string; truncated: boolean } {
	let position = -1;
	for (let line = 0; line < MAX_DIFF_LINES; line++) {
		position = text.indexOf('\n', position + 1);
		if (position < 0) return { text, truncated: false };
	}
	return position < text.length - 1 ? { text: text.slice(0, position), truncated: true } : { text, truncated: false };
}

function checkHash(hash: string): void {
	if (!/^[0-9a-f]{4,64}$/i.test(hash)) throw invalid('提交须为哈希值');
}

/** diff 的文件要写仓库里的相对路径，不能跑出仓库。 */
function checkRelative(path: string): void {
	if (!path || isAbsolute(path) || relative('/repo', resolve('/repo', path)).split(/[\\/]/)[0] === '..') throw invalid('file 须为仓库中的相对路径');
}
