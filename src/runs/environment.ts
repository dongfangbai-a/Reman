import type { Terminals } from '../terminals/terminals.ts';
import type { ShellLocator } from '../shells/shells.ts';
import type { Workspaces } from '../members/workspaces.ts';

/** shell 工具和终端用的 shell：名字、命令按什么语法写，Windows 上的 bash 还写明路径的写法。 */
export interface IShellInfo {
	readonly label: string;
	readonly syntax: string;
	readonly hint: string | undefined;
}

/**
 * 告诉模型它在什么环境里：操作系统、shell、工作目录，以及它建的终端。这些放在开头的快照里。
 * 不写时间：时间由收到的内容带着，收到时写下就不改（运行时设计第 5 部分「时间」）。
 */
export class Environment {
	private readonly workspaces: Workspaces;
	private readonly shells: ShellLocator;
	private readonly terminals: Terminals;

	constructor(workspaces: Workspaces, shells: ShellLocator, terminals: Terminals) {
		this.workspaces = workspaces;
		this.shells = shells;
		this.terminals = terminals;
	}

	workingDirectory(memberId: string): string {
		return this.workspaces.directory(memberId);
	}

	shell(): IShellInfo {
		const shell = this.shells.current();
		return {
			label: shell.label,
			syntax: shell.kind === 'pwsh' || shell.kind === 'powershell' ? 'PowerShell' : shell.kind,
			hint: process.platform === 'win32' && shell.kind === 'bash' ? '在 bash 中，Windows 路径 E:\\a\\b 应写作 /e/a/b。' : undefined,
		};
	}

	/** 开头快照里的运行环境。不写时间（见类的说明）。终端只列 ID 和标题：状态变得快，写进快照会过时，用终端时结果里都有。 */
	describe(memberId: string): string {
		const shell = this.shell();
		const lines = [
			'# 运行环境',
			`- 操作系统：${OS_NAMES[process.platform] ?? process.platform}`,
			`- shell 工具和终端使用 ${shell.label}，命令采用 ${shell.syntax} 语法。`,
		];
		if (shell.hint) lines.push(`- ${shell.hint}`);
		lines.push(`- 工作目录：${this.workingDirectory(memberId)}。shell 命令在此目录中执行，write_file、edit_file 的相对路径也以此目录为基准。`);
		// 列出自己建的终端，压缩之后也不会忘了终端 ID。
		const terminals = this.terminals.list().filter(terminal => terminal.createdBy === memberId);
		if (terminals.length > 0) {
			lines.push('- 你创建的终端：');
			for (const terminal of terminals) lines.push(`  - ${terminal.terminalId}（${terminal.title}）`);
		}
		return lines.join('\n');
	}
}

const OS_NAMES: Partial<Record<NodeJS.Platform, string>> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };
