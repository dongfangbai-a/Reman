import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { errorMessage, invalid } from '../../common/errors.ts';
import { killProcessTree } from '../../common/process.ts';
import { NETWORK_DENIED } from '../../sandbox/network.ts';
import type { ISandboxCommand, Sandbox } from '../../sandbox/sandbox.ts';
import { NO_PAGER, type IShell, type ShellLocator } from '../../shells/shells.ts';
import { BACKGROUND_AFTER_MS, EARLY_BACKGROUND_AFTER_MS } from '../executor.ts';
import type { DataProtection } from '../protection.ts';
import type { ITool, IToolContext } from '../tools.ts';
import { checkCommand, commandLanguage } from './commandApproval.ts';
import type { CommandParser } from './commandParser.ts';
import { LOGIN_VARIABLE, LoginShells } from './loginShell.ts';
import { refusedCommandReason } from './refusal.ts';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_TIMEOUT_MS = 2 * 60 * 60 * 1000;
/** 输出太长时保留开头和结尾，中间省略。结尾通常是结果和报错，留得多一些。 */
const HEAD_CHARS = 8_000;
const TAIL_CHARS = 12_000;

/** 命令的结果。cancelled 只在运行中止、任务取消时出现，这时代码也已经停了，所以不写进代码里的声明。 */
interface ICommandResult {
	/** stdout 和 stderr 合在一起；太长时中间省略。 */
	readonly output: string;
	/** 正常退出时的退出码；被信号终止、超时、取消时是 null。 */
	readonly exitCode: number | null;
	/** 被信号终止时的信号名。 */
	readonly signal: string | null;
	readonly timedOut: boolean;
	/** 被中止时是中止的原因（「运行已停止」「已取消」「运行时退出」），写进结果的最后一行。 */
	readonly cancelled?: string;
	/** 在沙箱里失败、看起来是被沙箱挡住时的提示。 */
	readonly hint?: string;
}

/** 让命令按非交互方式工作：不分页、不用颜色和交互提示。沙箱里是全新的环境，写在命令前面用 export 设。 */
const NONINTERACTIVE: Readonly<Record<string, string>> = {
	CI: '1',
	TERM: 'dumb',
	NO_COLOR: '1',
	...NO_PAGER,
	GIT_TERMINAL_PROMPT: '0',
};

/** 命令在哪里执行：沙箱里、到沙箱外（成员要求的，要审批）、沙箱用不了时在本机直接执行。 */
type Placement = 'sandbox' | 'outside' | 'local';

const BASE_DESCRIPTION = [
	'在工作目录中执行一条 shell 命令，返回输出（stdout 与 stderr 合并）和退出码。',
	'命令以非交互方式执行，没有标准输入：不要运行等待输入的命令；需要确认的命令，加上 -y 等参数。',
	`执行超过 ${BACKGROUND_AFTER_MS / 1000} 秒的命令会自动转为后台任务，完成后结果会送达给你。`,
	`已知无需等待的命令（如启动开发服务器、耗时较长的构建和测试），将 background 设为 true，等待 ${EARLY_BACKGROUND_AFTER_MS / 1000} 秒后即转为后台任务。`,
	'转为后台任务的命令到达 timeout_ms 时仍会被终止：需要运行一段时间的程序，将 timeout_ms 设为预计所需的时长；需要更长时间运行的程序，使用终端。',
].join('');

/** 沙箱里执行的规矩。沙箱后来才能用时，工具列表是快照，变动说明里照这段写。 */
export const SANDBOX_RULES = [
	'只能写入工作目录，部分文件无法读取；命令结束时，其启动的进程都会随之结束，',
	'因此需要持续运行的程序（如开发服务器）不要用 &、nohup 放到后台，应直接执行并将 background 设为 true，使其转为后台任务。',
	'命令因沙箱限制而失败（权限被拒绝）时，可将 outside_sandbox 设为 true 重试，此时需经用户批准。',
].join('');

const SANDBOX_DESCRIPTION = `命令在沙箱中执行：${SANDBOX_RULES}`;

const PARAMETERS = {
	command: { type: 'string', description: '要执行的命令' },
	timeout_ms: { type: 'integer', minimum: 1, maximum: MAX_TIMEOUT_MS, description: `命令的最长执行时间（毫秒），到时即终止命令，转为后台任务后同样适用。默认 ${DEFAULT_TIMEOUT_MS}（10 分钟），最大 ${MAX_TIMEOUT_MS}（2 小时）` },
	background: {
		type: 'boolean',
		description: `为 true 时只等待 ${EARLY_BACKGROUND_AFTER_MS / 1000} 秒：届时未结束则转为后台任务，返回后台任务 ID 和截至当时的输出；已结束的（如启动即报错）照常返回结果。用于启动开发服务器、耗时较长的构建和测试等无需等待的命令`,
	},
};

/** 沙箱里失败时，输出里有这些就提示可能是被沙箱挡住了。Windows 上 srt 只记下被挡的网络连接，读写文件被挡只能看输出。 */
const BLOCKED = /permission denied|access is denied|operation not permitted|拒绝访问/i;
/** srt 记下的被网络设置挡住的连接，取出主机和端口。 */
const NETWORK_DENIED_LINE = new RegExp(`network-outbound (\\S+) \\(${NETWORK_DENIED}\\)`);

export function createShellTool(shells: ShellLocator, parser: CommandParser, protection: DataProtection, sandbox: Sandbox): ITool<ICommandResult> {
	const check = (workingDirectory: string, command: string) => checkCommand(parser, shells.current(), command, { directory: workingDirectory, workingDirectory, protection });
	const sandboxReady = () => sandbox.state().kind === 'ready';
	const logins = new LoginShells();
	// 审批前就要定下在哪里执行，执行时照这个来：沙箱进程在审批之后出了问题，也不会不经审批改到沙箱外执行。
	const placements = new WeakMap<Record<string, unknown>, Promise<Placement>>();
	const placement = (context: IToolContext, args: Record<string, unknown>): Promise<Placement> => {
		let decided = placements.get(args);
		if (!decided) {
			decided = sandbox.placement(context.workingDirectory, shells.current())
				.then(where => !where.sandboxed ? 'local' : args['outside_sandbox'] === true ? 'outside' : 'sandbox');
			placements.set(args, decided);
		}
		return decided;
	};
	return {
		name: 'shell',
		label: '执行命令',
		description: BASE_DESCRIPTION,
		describe: () => sandboxReady() ? `${BASE_DESCRIPTION}${SANDBOX_DESCRIPTION}` : BASE_DESCRIPTION,
		get parameters() {
			return {
				type: 'object',
				properties: sandboxReady()
					? { ...PARAMETERS, outside_sandbox: { type: 'boolean', description: '为 true 时在沙箱外执行，须经用户批准。仅在命令因沙箱限制而失败时使用' } }
					: PARAMETERS,
				required: ['command'],
				additionalProperties: false,
			};
		},
		returns: '{ output: string; exitCode: number | null; signal: string | null; timedOut: boolean; hint?: string }',
		defaultPolicy: 'auto',
		get autoPolicy() {
			return sandboxReady()
				? { label: '沙箱内执行免审批', description: '在沙箱中执行的命令直接执行，在沙箱外执行的命令均须审批' }
				: { label: '安全命令免审批', description: '查看类命令（如 ls、cat、git status）和只写入工作目录的命令直接执行，其他命令均须审批' };
		},
		background: true,
		backgroundSoon: args => args['background'] === true,
		timeoutMs: args => {
			const timeoutMs = args['timeout_ms'];
			return typeof timeoutMs === 'number' && Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= MAX_TIMEOUT_MS ? timeoutMs : DEFAULT_TIMEOUT_MS;
		},
		// 灾难级的命令不管审批方式，直接拒绝，沙箱里也一样：成员的失误先拒绝、说明原因更好。
		refuseReason: (context, args) => {
			const command = args['command'];
			return typeof command === 'string' && command.trim()
				? refusedCommandReason(parser, commandLanguage(shells.current()), command, context.workingDirectory)
				: undefined;
		},
		// 沙箱里执行的不用审批。到沙箱外、沙箱用不了时按命令文字判断：只读命令、写入工作目录里的命令不用审批，其余要审批。
		needsApproval: async (context, args) => {
			const command = requireCommand(args);
			if (await placement(context, args) === 'sandbox') return undefined;
			return (await check(context.workingDirectory, command)).reasons;
		},
		// 到沙箱外执行：auto 策略下写进审批原因，让用户知道这次是在宿主上跑；免审批（allow）不看这条，直接执行。
		alwaysReasons: async (context, args) => {
			requireCommand(args);
			return await placement(context, args) === 'outside' ? ['在沙箱外执行'] : [];
		},
		// 沙箱里由沙箱保护运行时的数据，沙箱外按命令文字检查。
		protectedReasons: async (context, args) => {
			const command = requireCommand(args);
			if (await placement(context, args) === 'sandbox') return [];
			return (await check(context.workingDirectory, command)).protectedReasons;
		},
		execute: async (context, args) => {
			const command = requireCommand(args);
			const timeoutMs = args['timeout_ms'] ?? DEFAULT_TIMEOUT_MS;
			if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
				throw invalid(`timeout_ms 必须是 1 到 ${MAX_TIMEOUT_MS} 之间的整数`);
			}
			const workingDirectory = context.workingDirectory;
			if (!existsSync(workingDirectory) || !statSync(workingDirectory).isDirectory()) throw invalid(`工作目录不存在：${workingDirectory}`);
			const shell = shells.current();
			if (await placement(context, args) !== 'sandbox') return runCommand(shell, command, workingDirectory, timeoutMs, context.signal, context.liveOutput, logins);
			const where = await sandbox.placement(workingDirectory, shell);
			if (!where.sandboxed) throw invalid(`${where.reason}。确有需要时，将 outside_sandbox 设为 true 在沙箱外执行，此时需经用户批准`);
			const result = await collect(onOutput => {
				let running: ISandboxCommand;
				try {
					running = sandbox.run(workingDirectory, shell.executable, `export ${Object.entries(NONINTERACTIVE).map(([name, value]) => `${name}=${value}`).join(' ')}\n${command}`, onOutput);
				} catch (error) {
					throw invalid(`沙箱出错：${errorMessage(error)}`);
				}
				return {
					exited: running.exited.then(exit => {
						if (exit.error !== undefined) throw invalid(`无法在沙箱中执行：${exit.error}`);
						return exit;
					}),
					kill: () => running.kill(),
				};
			}, timeoutMs, context.signal, context.liveOutput);
			// 被网络设置挡住时不一定失败（curl 拿到 403 也算成功），只要有就写明。
			const denied = [...new Set(result.violations.flatMap(line => NETWORK_DENIED_LINE.exec(line)?.[1] ?? []))];
			if (denied.length) {
				const hint = `${NETWORK_DENIED}沙箱中的命令连接 ${denied.join('、')}。确有需要时，将 outside_sandbox 设为 true 重试，此时需经用户批准。`;
				return { ...withoutViolations(result), hint };
			}
			const failed = result.exitCode !== null && result.exitCode !== 0;
			if (!failed || (!result.violations.length && !BLOCKED.test(result.output))) return withoutViolations(result);
			const hint = [
				'可能受到沙箱限制：沙箱中只能写入工作目录，部分文件无法读取。确有需要时，将 outside_sandbox 设为 true 重试，此时需经用户批准。',
				...result.violations.length ? [`拦截记录：${result.violations.join('；')}`] : [],
			].join('');
			return { ...withoutViolations(result), hint };
		},
		format: formatCommand,
	};
}

function requireCommand(args: Record<string, unknown>): string {
	const command = args['command'];
	if (typeof command !== 'string' || !command.trim()) throw invalid('command 必须是非空字符串');
	return command;
}

/** 直接调用时的文字：输出，下一行写怎么结束的，有提示时再写提示。 */
export function formatCommand(result: ICommandResult): string {
	const status = result.cancelled ? `${result.cancelled}，命令已终止`
		: result.timedOut ? '超时，已终止'
			: result.exitCode !== null ? `退出码 ${result.exitCode}` : `被信号 ${result.signal} 终止`;
	return `${result.output || '（无输出）'}\n\n[${status}]${result.hint ? `\n${result.hint}` : ''}`;
}

/**
 * 执行命令直到结束、超时或被取消；超时和取消都会结束整个进程树。启动不了时报错。
 * 给了 logins 时 bash 不每条都登录，带上记下的登录环境；没给时每条都登录。
 */
export async function runCommand(
	shell: IShell, command: string, cwd: string, timeoutMs: number, signal: AbortSignal, liveOutput?: IToolContext['liveOutput'], logins?: LoginShells,
): Promise<ICommandResult> {
	// MSYS2 的登录 shell 默认会切到家目录，设置 CHERE_INVOKING 才留在当前目录。
	const env: NodeJS.ProcessEnv = { ...process.env, ...NONINTERACTIVE, CHERE_INVOKING: '1' };
	const login = shell.kind === 'bash' && logins ? await logins.changes(shell.executable, env) : undefined;
	if (login) env[LOGIN_VARIABLE] = login;
	// 第一条命令要先登录记下环境，这时被取消的和执行中被取消的一样。
	if (signal.aborted) return { output: '', exitCode: null, signal: null, timedOut: false, cancelled: cancelledReason(signal) };
	return withoutViolations(await collect(onOutput => startLocal(shell, shellArguments(shell, command, login), cwd, env, onOutput), timeoutMs, signal, liveOutput));
}

/** 正在执行的命令：本机的进程，或者沙箱里的。exited 在启动不了时 reject。 */
interface IRunning {
	readonly exited: Promise<{ readonly exitCode: number | null; readonly signal: string | null; readonly violations?: readonly string[] }>;
	kill(): void;
}

/** 收集输出，等命令结束；超时、取消时结束它。给了 liveOutput 时执行中也看得到收集到的输出。 */
async function collect(
	start: (onOutput: (text: string) => void) => IRunning, timeoutMs: number, signal: AbortSignal, liveOutput?: IToolContext['liveOutput'],
): Promise<ICommandResult & { readonly violations: readonly string[] }> {
	signal.throwIfAborted();
	const output = new OutputCollector();
	const live = liveOutput?.(() => output.text());
	let running: IRunning;
	try {
		running = start(text => {
			if (!text) return;
			output.append(text);
			live?.changed();
		});
	} catch (error) {
		live?.close();
		throw error;
	}
	let stopped: 'timeout' | 'cancelled' | undefined;
	const stop = (reason: 'timeout' | 'cancelled') => {
		if (stopped) return;
		stopped = reason;
		running.kill();
	};
	const timer = setTimeout(() => stop('timeout'), timeoutMs);
	const onAbort = () => stop('cancelled');
	signal.addEventListener('abort', onAbort, { once: true });
	try {
		const exit = await running.exited;
		return {
			output: output.text().trimEnd(),
			exitCode: stopped ? null : exit.exitCode,
			signal: stopped ? null : exit.signal,
			timedOut: stopped === 'timeout',
			...stopped === 'cancelled' && { cancelled: cancelledReason(signal) },
			violations: exit.violations ?? [],
		};
	} finally {
		clearTimeout(timer);
		signal.removeEventListener('abort', onAbort);
		live?.close();
	}
}

/** 被中止的原因（「运行已停止」「已取消」「运行时退出」）。 */
function cancelledReason(signal: AbortSignal): string {
	return signal.reason instanceof Error && signal.reason.message ? signal.reason.message : '已取消';
}

function withoutViolations({ violations: _, ...result }: ICommandResult & { readonly violations: readonly string[] }): ICommandResult {
	return result;
}

/** 在本机直接执行。 */
function startLocal(shell: IShell, args: string[], cwd: string, env: NodeJS.ProcessEnv, onOutput: (text: string) => void): IRunning {
	const child = spawn(shell.executable, args, {
		cwd,
		env,
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true,
		// POSIX 上让命令自成一个进程组，结束时可以连同子进程一起结束。
		detached: process.platform !== 'win32',
	});
	for (const stream of [child.stdout!, child.stderr!]) {
		const decoder = new TextDecoder();
		stream.on('data', (chunk: Buffer) => onOutput(decoder.decode(chunk, { stream: true })));
		stream.on('end', () => onOutput(decoder.decode()));
	}
	const exited = new Promise<{ exitCode: number | null; signal: string | null }>((resolve, reject) => {
		let finished = false;
		const finish = (code: number | null, signalName: NodeJS.Signals | null) => {
			if (finished) return;
			finished = true;
			resolve({ exitCode: code, signal: signalName });
		};
		child.on('error', error => {
			if (finished) return;
			finished = true;
			reject(invalid(`无法启动 ${shell.label}：${error.message}`));
		});
		child.on('close', finish);
		// 命令放到后台的子进程可能一直占着输出管道；命令本身退出后最多再等一会儿。
		child.on('exit', (code, signalName) => setTimeout(() => {
			if (finished) return;
			child.stdout!.destroy();
			child.stderr!.destroy();
			finish(code, signalName);
		}, 2000).unref());
	});
	return { exited, kill: () => killProcessTree(child) };
}

/** login 是记下的登录环境（见 loginShell.ts）：bash 有它时不登录，开头读入；没有时登录执行。 */
function shellArguments(shell: IShell, command: string, login: string | undefined): string[] {
	switch (shell.kind) {
		case 'bash':
			if (login === undefined) return ['-lc', command];
			// 和命令写在同一行：报错里的行号还是命令自己的。
			return ['-c', login ? `eval "$${LOGIN_VARIABLE}"; unset ${LOGIN_VARIABLE}; ${command}` : command];
		case 'zsh':
			return ['-lc', command];
		case 'sh':
			return ['-c', command];
		case 'pwsh':
		case 'powershell':
			return ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `${POWERSHELL_UTF8}${command}`];
	}
}

const POWERSHELL_UTF8 = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;$OutputEncoding=[System.Text.Encoding]::UTF8;';

/** 收集输出：开头和结尾各留一段，中间只记省略了多少字。 */
class OutputCollector {
	private head = '';
	private tail = '';
	private omitted = 0;

	append(text: string): void {
		if (!text) return;
		if (this.head.length < HEAD_CHARS) {
			const take = HEAD_CHARS - this.head.length;
			this.head += text.slice(0, take);
			text = text.slice(take);
		}
		this.tail += text;
		if (this.tail.length > TAIL_CHARS * 2) this.trimTail();
	}

	text(): string {
		this.trimTail();
		return this.omitted > 0 ? `${this.head}\n\n……（中间省略 ${this.omitted} 字）……\n\n${this.tail}` : this.head + this.tail;
	}

	private trimTail(): void {
		if (this.tail.length <= TAIL_CHARS) return;
		this.omitted += this.tail.length - TAIL_CHARS;
		this.tail = this.tail.slice(-TAIL_CHARS);
	}
}
