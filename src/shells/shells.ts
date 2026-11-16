import { existsSync } from 'node:fs';
import { posix, win32 } from 'node:path';

/** 不用分页器：分页器会等按键，模型容易卡住；需要翻页的内容让程序直接输出。shell 工具和终端都设。 */
export const NO_PAGER: Readonly<Record<string, string>> = {
	PAGER: 'cat',
	GIT_PAGER: 'cat',
	GH_PAGER: 'cat',
	MANPAGER: 'cat',
	SYSTEMD_PAGER: 'cat',
	LESS: 'FRX',
};

type ShellKind ='bash' | 'zsh' | 'sh' | 'pwsh' | 'powershell';

export interface IShell {
	readonly kind: ShellKind;
	readonly executable: string;
	/** 给人和模型看的名字，例如 Git Bash。 */
	readonly label: string;
}

/**
 * 找 shell 工具用的 shell。Windows 优先 Git Bash：模型对 bash 最熟，命令也和 macOS、Linux 一致；
 * 依次是系统里装的 Git Bash、运行时自己装的 PortableGit、其他 bash（MSYS2、Cygwin）、pwsh、Windows PowerShell。
 * 不能直接在 PATH 里找 bash.exe：System32 和 WindowsApps 下的 bash.exe 是 WSL。
 * macOS 优先 zsh，Linux 优先 bash。
 */
export class ShellLocator {
	private readonly portableGitBash: () => string | undefined;
	private readonly system: ISystem;
	private cached: IShell | undefined;
	private cachedGit: { readonly path: string | undefined } | undefined;

	constructor(portableGitBash: () => string | undefined, system: ISystem = { platform: process.platform, env: process.env, exists: existsSync }) {
		this.portableGitBash = portableGitBash;
		this.system = system;
	}

	current(): IShell {
		this.cached ??= this.detect();
		return this.cached;
	}

	/** 装好 PortableGit 等变化之后重新检测。 */
	refresh(): IShell {
		this.cached = undefined;
		this.cachedGit = undefined;
		return this.current();
	}

	/**
	 * git 命令，网页端的 Git 面板用：PATH 里的 git；Windows 上再看 Git for Windows 的安装目录（和找 Git Bash 的地方一样）
	 * 和运行时装的 PortableGit，git.exe 都在 cmd 下。找不到时是 undefined。
	 */
	git(): string | undefined {
		this.cachedGit ??= { path: this.detectGit() };
		return this.cachedGit.path;
	}

	private detectGit(): string | undefined {
		const { platform, exists } = this.system;
		if (platform !== 'win32') return this.findOnPath('git') ?? ['/usr/bin/git', '/usr/local/bin/git', '/opt/homebrew/bin/git'].find(path => exists(path));
		const portable = this.portableGitBash();
		const roots = [...this.gitForWindowsRoots(), ...portable ? [win32.dirname(win32.dirname(portable))] : []];
		return this.findOnPath('git.exe') ?? roots.map(root => win32.join(root, 'cmd', 'git.exe')).find(path => exists(path));
	}

	private detect(): IShell {
		const { platform, env, exists } = this.system;
		const existing = (path: string) => exists(path) ? path : undefined;
		if (platform === 'win32') {
			const gitBash = this.findGitBash();
			if (gitBash) return { kind: 'bash', executable: gitBash, label: 'Git Bash' };
			const portable = this.portableGitBash();
			if (portable && exists(portable)) return { kind: 'bash', executable: portable, label: 'Git Bash' };
			const otherBash = ['C:\\msys64\\usr\\bin\\bash.exe', 'C:\\cygwin64\\bin\\bash.exe'].find(path => exists(path));
			if (otherBash) return { kind: 'bash', executable: otherBash, label: 'bash' };
			const pwsh = this.findOnPath('pwsh.exe') ?? existing(win32.join(env['ProgramFiles'] ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'));
			if (pwsh) return { kind: 'pwsh', executable: pwsh, label: 'PowerShell 7' };
			const systemRoot = env['SystemRoot'] ?? 'C:\\Windows';
			return { kind: 'powershell', executable: win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), label: 'Windows PowerShell' };
		}
		const order: readonly ShellKind[] = platform === 'darwin' ? ['zsh', 'bash', 'sh'] : ['bash', 'zsh', 'sh'];
		for (const kind of order) {
			const executable = this.findOnPath(kind) ?? existing(`/bin/${kind}`);
			if (executable) return { kind, executable, label: kind };
		}
		return { kind: 'sh', executable: '/bin/sh', label: 'sh' };
	}

	/** 系统里装的 Git for Windows：先看常见安装位置，再从 PATH 里的 git.exe 往上找安装目录。 */
	private findGitBash(): string | undefined {
		return this.gitForWindowsRoots().map(root => win32.join(root, 'bin', 'bash.exe')).find(path => this.system.exists(path));
	}

	/** Git for Windows 可能的安装目录：常见安装位置，和 PATH 里 git.exe 往上的目录。 */
	private gitForWindowsRoots(): string[] {
		const env = this.system.env;
		const roots = [
			win32.join(env['ProgramFiles'] ?? 'C:\\Program Files', 'Git'),
			win32.join(env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Git'),
			...env['LOCALAPPDATA'] ? [win32.join(env['LOCALAPPDATA'], 'Programs', 'Git')] : [],
		];
		const git = this.findOnPath('git.exe');
		if (git) {
			// git.exe 在安装目录下的 cmd、bin 或 mingw64/bin 里。
			const parent = win32.dirname(git);
			roots.push(win32.dirname(parent), win32.dirname(win32.dirname(parent)));
		}
		return roots;
	}

	private findOnPath(name: string): string | undefined {
		const path = this.system.platform === 'win32' ? win32 : posix;
		const value = Object.entries(this.system.env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
		return value.split(path.delimiter).filter(Boolean).map(directory => path.join(directory, name)).find(candidate => this.system.exists(candidate));
	}
}

/** 检测时用到的系统信息，测试时可以换成假的。 */
interface ISystem {
	readonly platform: NodeJS.Platform;
	readonly env: NodeJS.ProcessEnv;
	readonly exists: (path: string) => boolean;
}
