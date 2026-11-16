import { spawn as spawnProcess } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, win32 } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import serializeAddon from '@xterm/addon-serialize';
import xterm from '@xterm/headless';
import { spawn, type IPty } from 'node-pty';
import type { EventHub } from '../common/events.ts';
import { invalid, notFound } from '../common/errors.ts';
import { newId, wrongKind } from '../common/ids.ts';
import { clipMiddle } from '../common/text.ts';
import type { Members } from '../members/members.ts';
import { NO_PAGER, type IShell, type ShellLocator } from '../shells/shells.ts';
import type { Timeline } from '../timeline/timeline.ts';

/** 最多同时有多少个运行中的终端。已退出的只剩画面，留到有人关闭，不算在内。 */
const MAX_TERMINALS = 16;
/** 运行时退出时最多等终端里的进程结束多久。 */
const SHUTDOWN_WAIT_MS = 5000;
/**
 * node-pty 自带的小程序：取附着在 shell 的控制台上的全部进程。一个进程只能附着一个控制台，所以要在另一个进程里取。
 * 只在 Windows 上用。
 */
const CONSOLE_LIST_AGENT = join(dirname(createRequire(import.meta.url).resolve('node-pty')), 'conpty_console_list_agent.js');
const CONSOLE_LIST_TIMEOUT_MS = 5000;
/** 结束终端后最多等里面的进程退出多久。 */
const KILL_WAIT_MS = 3000;
const SCROLLBACK_LINES = 5000;
/** AI 成员建的终端一直是这个尺寸；用户建的先用它，再由前端按终端区域改。为什么固定、为什么是这个大小，见设计文档的终端尺寸。 */
const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 30;
/** 给模型的输出太长时保留开头和结尾。 */
const HEAD_CHARS = 4_000;
const TAIL_CHARS = 16_000;
/** 新版 ConPTY 启动时自己输出的查询和模式设置，不算 shell 的输出。 */
const CONPTY_STARTUP = /\x1b\[1t|\x1b\[c|\x1b\[\?1004h|\x1b\[\?9001h/g;
/** shell 一直没有输出时，最多攒着输入等多久。 */
const STARTUP_INPUT_HOLD_MS = 3000;
/**
 * 运行时的屏幕和前端的 xterm.js 都用这个 windowsPty。xterm.js 按 ConPTY 的版本决定改大小时自己要不要重排：
 * 21376 起的 ConPTY 交给终端重排，更早的不用。用的是 node-pty 自带的新版 ConPTY，这里却故意写更早的版本，让 xterm.js 不重排。
 *
 * 排查记录：写 21376 时，网页里跑着 Claude Code，把浏览器拖到另一块显示器或缩放页面，每改一次大小回滚区就多一份
 * Claude Code 的标题和分隔线。不经过网页（node-pty 直接接无界面的 xterm，两边同时改大小）也能复现，所以不是网页的问题。
 * 原因：Claude Code 的分隔线正好占满一行，窄一列时 xterm.js 重排把它折成两行，屏幕内容变高，顶上几行被挤进回滚区；
 * 而改大小后程序（经 ConPTY）只清掉屏幕重画，回滚区里的旧内容留了下来。换显示器、缩放页面时大小常常只差一两列，正好触发。
 * 写更早的版本后，同样的步骤不再堆叠。
 *
 * 不重排的代价：变窄时长行超出的部分看不到，变宽时之前折开的行不合回去；新的输出不受影响。不重排时 xterm.js 变窄也不截掉行尾，
 * 运行时的屏幕要自己截，见 trimLines；它这时还会猜哪些行是折行，猜错会让快照出错，也要关掉，见 disableWrapGuess。
 * 要改回 21376，先按上面的步骤验证：shell 里先输出几十行，再启动 claude，宽度来回差一列改几次，看回滚区有没有多出旧画面。
 */
const WINDOWS_PTY: IWindowsPty | null = process.platform === 'win32' ? { backend: 'conpty', buildNumber: 19045 } : null;

/** ai：AI 成员可以输入；user：用户接管了，AI 只能读。 */
type TerminalController = 'ai' | 'user';

export interface ITerminalInfo {
	readonly terminalId: string;
	/** 建这个终端的 AI 成员；null 表示用户在前端建的。 */
	readonly createdBy: string | null;
	readonly title: string;
	readonly cwd: string;
	readonly status: 'running' | 'exited';
	readonly exitCode: number | null;
	readonly controller: TerminalController;
	readonly cols: number;
	readonly rows: number;
	readonly createdAt: number;
	readonly exitedAt: number | null;
	/** 成员请用户接管、写了要用户做什么的，交还后清掉。 */
	readonly takeoverRequests: readonly ITakeoverRequest[];
}

interface ITakeoverRequest {
	readonly memberId: string;
	readonly request: string;
	readonly requestedAt: number;
}

interface IWindowsPty {
	readonly backend: 'conpty';
	/** ConPTY 的行为相当于哪个 Windows 版本的。 */
	readonly buildNumber: number;
}

export interface ITerminalScreen {
	/** 快照包含到这个序号为止的输出；前端丢掉序号不大于它的增量。 */
	readonly seq: number;
	/** 序列化的屏幕内容，写进前端的 xterm.js 即可还原。 */
	readonly data: string;
	readonly cols: number;
	readonly rows: number;
	/** 运行时在 Windows 上时伪终端的信息，前端的 xterm.js 设成 windowsPty；其他系统是 null。 */
	readonly windowsPty: IWindowsPty | null;
}

/** 谁在操作：AI 成员，或者前端的用户。 */
type TerminalActor = { readonly memberId: string } | 'user';

/**
 * 等待为什么结束：idle 是出现新输出后停够了 idleMs；silent 是一直没有新输出、等满了 idleMs；deadline 是等到了最晚的时刻；
 * exited 是程序退出了；closed 是终端被关闭了；user 是用户在操作（一开始就是，或者中途接管了）。
 */
export type TerminalWaitEnd = 'idle' | 'silent' | 'deadline' | 'exited' | 'closed' | 'user';

/** 等待后读到的内容和终端当时的状态。 */
export interface ITerminalReading {
	readonly info: ITerminalInfo;
	readonly output: string;
	/** 等待期间终端被关闭了：谁关的。 */
	readonly closedBy: TerminalActor | undefined;
	/** 等待被中止了，没等输出告一段落就读了。 */
	readonly interrupted: boolean;
	/** 等待为什么结束；被中止时是 undefined。 */
	readonly ended: TerminalWaitEnd | undefined;
}

interface ISession {
	info: ITerminalInfo;
	readonly pty: IPty;
	readonly screen: xterm.Terminal;
	readonly serializer: serializeAddon.SerializeAddon;
	/** 收到的输出块的序号，以及屏幕已经处理到的序号。 */
	seq: number;
	renderedSeq: number;
	/** 最近一次有输出或输入的时间，用来判断输出是否停下来了。 */
	lastActivityAt: number;
	/**
	 * 每个成员读到哪一行（终端是共享的，各读各的）和读到哪个序号。行号从终端开始算起，不随缓冲区裁掉旧行而变；
	 * 不用 xterm 的 marker：清屏会把屏幕上的 marker 一起清掉。
	 */
	readonly readLines: Map<string, number>;
	/** 上一次读到的最后一行当时的内容：这一行可能还没写完，下次读时变了才再给一遍。 */
	readonly readText: Map<string, string>;
	readonly readSeq: Map<string, number>;
	/** 缓冲区开头被裁掉了多少行（滚出回滚上限，或者被清除）。 */
	trimmedLines: number;
	closedBy: TerminalActor | undefined;
	/** 正在等待读取的调用数。终端被移除时还有调用在等，屏幕留到它们读完再释放。 */
	waiters: number;
	/**
	 * 在等的调用怎么被叫醒（见 wait）。stateWakers：状态变了（退出、被接管、被移除）时叫；
	 * outputWakers：还没等到新输出的，出现输出或输入时叫。等待可以长达半小时，不靠隔一会儿查一次。
	 */
	readonly stateWakers: Set<() => void>;
	readonly outputWakers: Set<() => void>;
	/** 每个成员在同一次运行里连续只读不输入了几次、这次运行里提示过没有，见 countRead、claimReadsHint。 */
	readonly reads: Map<string, { readonly runId: number; readonly count: number; readonly hinted: boolean }>;
	/**
	 * shell 第一次输出之前收到的输入，输出后再写入；null 表示已经写入了。Git Bash 在新版 ConPTY 里启动时，
	 * 提前收到的输入偶尔会打乱顺序（echo hello 变成 hecho ello），而 AI 新建终端时常常马上就输入命令。
	 */
	startupInput: string | null;
	/**
	 * 在等用户交还的成员：请用户接管过的记下请求，用户操作期间调用过这个终端的是 null。交还时唤醒它们，
	 * 没人在等时不唤醒，见设计文档的终端的接管。
	 */
	readonly waiting: Map<string, string | null>;
	/**
	 * shell 现在的当前目录，判断命令时用。bash 每条命令结束后由提示符钩子报出来；一直没收到报告（别的 shell，
	 * 或者用户的配置覆盖了钩子）时，输入过内容以后就看不清了，是 undefined。
	 */
	directory: string | undefined;
	directoryReported: boolean;
	/** 审批时用户选了「这个终端里都允许」的成员：它们往这个终端里的输入不用审批，到终端关闭为止。 */
	readonly trusted: Set<string>;
}

/**
 * 交互式终端：伪终端里跑一个交互 shell，运行时里用无界面的 xterm 维护屏幕。
 * 终端由 AI 成员共享，用户可以在前端接管（例如输入密码），交还时唤醒在等的成员。
 * 终端只在内存里，运行时重启后就没有了。
 */
export class Terminals {
	private readonly events: EventHub;
	private readonly shells: ShellLocator;
	private readonly members: Members;
	private readonly timeline: Timeline;
	private readonly sessions = new Map<string, ISession>();
	/** 正在结束的终端：运行时退出时等它们结束。 */
	private readonly killing = new Set<Promise<void>>();

	constructor(events: EventHub, shells: ShellLocator, members: Members, timeline: Timeline) {
		this.events = events;
		this.shells = shells;
		this.members = members;
		this.timeline = timeline;
	}

	create(createdBy: string | null, cwd: string): ITerminalInfo {
		if (!isAbsolute(cwd) || !existsSync(cwd) || !statSync(cwd).isDirectory()) throw invalid(`起始目录不存在：${cwd}`);
		if ([...this.sessions.values()].filter(session => session.info.status === 'running').length >= MAX_TERMINALS) throw invalid(`运行中的终端最多 ${MAX_TERMINALS} 个，请先关闭不再使用的终端`);
		const shell = this.shells.current();
		const terminalId = newId('T', id => this.sessions.has(id));
		// Windows 上用 node-pty 自带的新版 ConPTY（conpty.dll 和 OpenConsole.exe），不用系统的；node-pty 把这个选项标为实验性。
		// Windows 10 自带的很旧：程序清屏重画时（例如改大小后 Claude Code 重画界面）会把整屏推进回滚区，每改一次大小就多一份画面。
		// 新版和系统的不同之处：启动时先查询终端（ESC[c），等到回复才开始工作，回复见下面的 screen.onData；
		// Git Bash 启动前收到的输入会乱序，见 startupInput；改大小时要终端自己重排，这里故意不让 xterm.js 重排，见 WINDOWS_PTY。
		const pty = spawn(shell.executable, interactiveArguments(shell), {
			name: 'xterm-256color', cols: DEFAULT_COLS, rows: DEFAULT_ROWS, cwd, env: terminalEnvironment(shell), useConptyDll: true,
		});
		// 终端关掉时还没送出去的输入会写入失败。node-pty 在 Windows 上没处理这个错误，不处理的话整个运行时会退出。
		windowsAgent(pty)?._inSocket?.on('error', () => undefined);
		const screen = new xterm.Terminal({
			cols: DEFAULT_COLS, rows: DEFAULT_ROWS, scrollback: SCROLLBACK_LINES, allowProposedApi: true, ...WINDOWS_PTY && { windowsPty: WINDOWS_PTY },
		});
		if (WINDOWS_PTY) disableWrapGuess(screen);
		const serializer = new serializeAddon.SerializeAddon();
		screen.loadAddon(serializer);
		const session: ISession = {
			info: {
				terminalId, createdBy, title: shell.label, cwd, status: 'running', exitCode: null,
				// 用户在前端建的终端一开始由用户操作。
				controller: createdBy === null ? 'user' : 'ai',
				cols: DEFAULT_COLS, rows: DEFAULT_ROWS, createdAt: Date.now(), exitedAt: null, takeoverRequests: [],
			},
			pty, screen, serializer, seq: 0, renderedSeq: 0, lastActivityAt: Date.now(),
			readLines: new Map(), readText: new Map(), readSeq: new Map(), trimmedLines: 0, closedBy: undefined, waiters: 0,
			stateWakers: new Set(), outputWakers: new Set(), reads: new Map(),
			startupInput: '',
			waiting: new Map(),
			directory: cwd,
			directoryReported: false,
			trusted: new Set(),
		};
		screen.parser.registerOscHandler(DIRECTORY_OSC, data => {
			if (!data.startsWith(DIRECTORY_PREFIX)) return false;
			session.directory = reportedDirectory(data.slice(DIRECTORY_PREFIX.length));
			session.directoryReported = true;
			return true;
		});
		onTrim(screen, count => session.trimmedLines += count);
		// 终端查询由这里统一回复：程序会问「你是什么终端」「光标在哪」「某个模式开没开」，终端要自动回一串字符，用户看不到。
		// 只靠网页里的 xterm.js 回复的话，没人开着网页时（例如 AI 在用终端）没人回复：新版 ConPTY 启动时干等约 3 秒，
		// 有的程序会卡住或判断错终端。前端的 xterm.js 拦下这些查询不回复，否则程序收到两份，多出来的一份被当成键盘输入。
		// 颜色查询这里答不了（不知道配色），仍由前端回复。
		screen.onData(data => {
			if (session.info.status === 'running') pty.write(data);
		});
		this.sessions.set(terminalId, session);
		const releaseInput = () => {
			clearTimeout(holdTimer);
			if (session.startupInput && session.info.status === 'running') pty.write(session.startupInput);
			session.startupInput = null;
		};
		const holdTimer = setTimeout(releaseInput, STARTUP_INPUT_HOLD_MS).unref();
		pty.onData(data => {
			if (session.startupInput !== null && data.replace(CONPTY_STARTUP, '')) releaseInput();
			const seq = ++session.seq;
			session.lastActivityAt = Date.now();
			wakeAll(session.outputWakers);
			screen.write(data, () => session.renderedSeq = seq);
			this.events.delta({ type: 'terminal.output', terminalId, seq, data });
		});
		pty.onExit(({ exitCode }) => {
			releaseWindowsHandles(pty);
			if (this.sessions.get(terminalId) !== session) return;
			this.update(session, { status: 'exited', exitCode, exitedAt: Date.now() });
			this.notifyWaiting(session, { event: 'exited', exitCode });
		});
		this.events.emit({ type: 'terminal.changed', terminalId });
		return session.info;
	}

	list(): ITerminalInfo[] {
		return [...this.sessions.values()].map(session => session.info);
	}

	get(terminalId: string): ITerminalInfo {
		return this.require(terminalId).info;
	}

	/** 输入内容。AI 的输入里换行表示回车；用户在前端的输入原样写入，并自动接管终端。用户的输入不记录。 */
	input(terminalId: string, data: string, actor: TerminalActor): void {
		const session = this.require(terminalId);
		if (session.info.status === 'exited') throw invalid(`终端 ${terminalId} 中的程序已退出`);
		if (actor === 'user') {
			if (session.info.controller === 'ai') this.update(session, { controller: 'user' });
		} else {
			if (session.info.controller === 'user') {
				this.markWaiting(session, actor.memberId);
				throw invalid(`用户正在操作终端 ${terminalId}，当前无法输入；用户交还时会通知你`);
			}
			data = data.replace(/\r?\n/g, '\r');
		}
		if (!session.directoryReported) session.directory = undefined;
		if (session.startupInput !== null) session.startupInput += data;
		else session.pty.write(data);
		session.lastActivityAt = Date.now();
		wakeAll(session.outputWakers);
	}

	/** 用户允许这个成员往这个终端里输入不用审批，到终端关闭为止。 */
	trust(terminalId: string, memberId: string): void {
		this.require(terminalId).trusted.add(memberId);
	}

	trusts(terminalId: string, memberId: string): boolean {
		return this.sessions.get(terminalId)?.trusted.has(memberId) ?? false;
	}

	/** 终端里 shell 现在的当前目录；看不清时是 undefined。 */
	async currentDirectory(terminalId: string): Promise<string | undefined> {
		const session = this.require(terminalId);
		await flush(session);
		return session.directory;
	}

	/** 改尺寸，只用于用户建的终端。AI 成员建的尺寸固定：改了之后输出按不同的宽度换行，成员前后读到的对不上。 */
	resize(terminalId: string, cols: number, rows: number): ITerminalInfo {
		const session = this.require(terminalId);
		if (session.info.createdBy !== null) throw invalid(`终端 ${terminalId} 由 AI 成员创建，尺寸固定，不能修改`);
		if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 20 || rows < 5 || cols > 500 || rows > 200) {
			throw invalid('终端大小有误：列数须为 20 到 500，行数须为 5 到 200');
		}
		// 已知问题，还没解决：Git Bash 改大小之后，下一个输入的字符偶尔会丢（echo 变成 cho），换系统自带的 ConPTY 也一样。
		// 前端在自己的大小变了时就发，可能和终端现在的一样，这时不用再改。
		if (cols === session.info.cols && rows === session.info.rows) return session.info;
		const narrower = cols < session.info.cols;
		if (session.info.status === 'running') session.pty.resize(cols, rows);
		session.screen.resize(cols, rows);
		if (WINDOWS_PTY && narrower) trimLines(session.screen, cols);
		return this.update(session, { cols, rows });
	}

	takeover(terminalId: string): ITerminalInfo {
		const session = this.require(terminalId);
		return session.info.controller === 'user' ? session.info : this.update(session, { controller: 'user' });
	}

	/** 成员请用户接管，request 是要用户做什么。交还时唤醒它。 */
	requestTakeover(terminalId: string, memberId: string, request: string): ITerminalInfo {
		const session = this.require(terminalId);
		session.waiting.set(memberId, request);
		return this.update(session, { takeoverRequests: [...session.info.takeoverRequests.filter(item => item.memberId !== memberId), { memberId, request, requestedAt: Date.now() }] });
	}

	/**
	 * 用户交还终端：唤醒在等的成员，写明为什么在等。没人在等时不唤醒，只给建终端的成员记一条：
	 * 用户可能接管后什么都没做，唤醒了它也不知道要做什么。
	 */
	release(terminalId: string): ITerminalInfo {
		const session = this.require(terminalId);
		if (session.info.controller === 'ai') return session.info;
		const waiting = [...session.waiting].filter(([memberId]) => this.members.get(memberId)?.deleted === false);
		session.waiting.clear();
		const info = this.update(session, { controller: 'ai', takeoverRequests: [] });
		for (const [memberId, request] of waiting) this.timeline.appendTerminalEvent(memberId, { terminalId, event: 'released', request, waiting: true });
		const creator = info.createdBy ? this.members.get(info.createdBy) : undefined;
		if (waiting.length === 0 && creator && !creator.deleted) {
			this.timeline.appendTerminalEvent(creator.memberId, { terminalId, event: 'released', request: null, waiting: false });
		}
		return info;
	}

	close(terminalId: string, actor: TerminalActor): void {
		const session = this.require(terminalId);
		if (actor !== 'user' && session.info.controller === 'user') throw invalid(`用户正在操作终端 ${terminalId}，不能关闭`);
		session.closedBy = actor;
		if (session.info.status === 'running') this.kill(session);
		this.remove(terminalId);
		this.notifyWaiting(session, { event: 'closed', closedBy: actor === 'user' ? 'user' : actor.memberId }, actor === 'user' ? undefined : actor.memberId);
	}

	/**
	 * 终端被关闭、里面的程序退出了：在等用户交还的成员等不到交还了，告诉它们并唤醒。不告诉的话，它们停在
	 * 「交还时会通知你」上，没有别的事就再也不会运行。except 是关闭终端的成员自己，不用告诉。
	 */
	private notifyWaiting(session: ISession, event: { readonly event: 'closed'; readonly closedBy: string } | { readonly event: 'exited'; readonly exitCode: number }, except?: string): void {
		const waiting = [...session.waiting].filter(([memberId]) => memberId !== except && this.members.get(memberId)?.deleted === false);
		session.waiting.clear();
		for (const [memberId, request] of waiting) {
			this.timeline.appendTerminalEvent(memberId, { terminalId: session.info.terminalId, request, waiting: true, ...event });
		}
	}

	/** 屏幕快照，给前端初始化用。 */
	async screen(terminalId: string): Promise<ITerminalScreen> {
		const session = this.require(terminalId);
		await flush(session);
		// SerializeAddon 不保存光标是否隐藏，这里补上。Claude Code 隐藏终端的光标、自己画一个；快照里没有这一条时，
		// 刷新网页后 xterm.js 的光标又显示出来，和 Claude Code 画的同时出现，直到程序因为别的原因重画。
		const data = session.serializer.serialize() + (cursorHidden(session.screen) ? '\x1b[?25l' : '');
		return { seq: session.renderedSeq, data, cols: session.info.cols, rows: session.info.rows, windowsPty: WINDOWS_PTY };
	}

	/**
	 * 等输出告一段落后读这个成员的输出（mode 见 read）。等待被中止时不再等，照常读出已有的输出；
	 * 等待期间终端被关闭时，读出关闭前的输出。
	 * deadline 给出最晚等到什么时刻，每次要用时现取：转为后台任务的等待，成员再调用这个终端时会顺延。
	 */
	async waitAndRead(
		terminalId: string, memberId: string,
		options: { readonly idleMs: number; readonly deadline: () => number; readonly mode: 'new' | 'screen'; readonly signal: AbortSignal; readonly untilOutput?: boolean },
	): Promise<ITerminalReading> {
		const session = this.require(terminalId);
		session.waiters++;
		try {
			let ended: TerminalWaitEnd | undefined;
			try {
				ended = await this.wait(session, memberId, options.idleMs, options.deadline, options.signal, options.untilOutput === true);
			} catch (error) {
				if (!options.signal.aborted) throw error;
			}
			// 用户在操作时不等新输出，马上返回，记下它在等；等的中途用户接管了也一样。
			if (session.info.controller === 'user') this.markWaiting(session, memberId);
			const output = await this.read(session, memberId, options.mode);
			return { info: session.info, output, closedBy: session.closedBy, interrupted: ended === undefined, ended };
		} finally {
			session.waiters--;
			if (session.waiters === 0 && this.sessions.get(terminalId) !== session) session.screen.dispose();
		}
	}

	/** 不等，读这个成员现在的输出（mode 见 read）。 */
	async readNow(terminalId: string, memberId: string, mode: 'new' | 'screen'): Promise<{ readonly info: ITerminalInfo; readonly output: string }> {
		const session = this.require(terminalId);
		session.waiters++;
		try {
			return { output: await this.read(session, memberId, mode), info: session.info };
		} finally {
			session.waiters--;
			if (session.waiters === 0 && this.sessions.get(terminalId) !== session) session.screen.dispose();
		}
	}

	/**
	 * 记一次成员对终端的调用，返回它在这次运行里连续只读不输入了几次：输入过就从头数，换了一次运行也从头数。
	 * 连着读了几次程序还在跑，多半是在反复看它做完没有，调用方据此提示它改成等待一次。
	 */
	countRead(terminalId: string, memberId: string, runId: number, readOnly: boolean): number {
		const session = this.sessions.get(terminalId);
		if (!session) return 0;
		const last = session.reads.get(memberId);
		const same = last?.runId === runId;
		const count = readOnly ? (same ? last.count : 0) + 1 : 0;
		session.reads.set(memberId, { runId, count, hinted: same && last.hinted });
		return count;
	}

	/** 这次运行里还没有就连续读取提示过这个成员时返回 true 并记下：同一次运行里对同一个终端最多提示一次。 */
	claimReadsHint(terminalId: string, memberId: string, runId: number): boolean {
		const session = this.sessions.get(terminalId);
		const last = session?.reads.get(memberId);
		if (!session || !last || last.runId !== runId || last.hinted) return false;
		session.reads.set(memberId, { ...last, hinted: true });
		return true;
	}

	/**
	 * 等输出告一段落：从最近一次新输出（没有新输出时从这次等待开始）算起，idleMs 内没有新输出就返回，
	 * 一直没有新输出的返回 silent。最晚等到 deadline()，程序退出、终端被移除、用户在操作也返回。
	 * 终端里可能根本没有程序在运行（输入的命令漏了回车），不单独等得更久：等满 idleMs 就返回，成员当场知道没有新输出。
	 * 不隔一会儿查一次：算出条件最早什么时候可能满足，睡到那时；状态变了、等的新输出出现了，由 stateWakers、outputWakers 叫醒。
	 * untilOutput 为 true 时（已经转为后台任务在等它的输出）一直没有新输出不算告一段落：一直等到 deadline，免得刚转后台就因为「停了 idleMs」结束。
	 */
	private async wait(session: ISession, memberId: string, idleMs: number, deadline: () => number, signal: AbortSignal, untilOutput = false): Promise<TerminalWaitEnd> {
		const startedAt = Date.now();
		const hasNews = () => session.seq > (session.readSeq.get(memberId) ?? 0) || session.lastActivityAt >= startedAt;
		// 有过新输出就一直算有：等的中途这个成员又读过（转为后台任务时读一次，已有等待任务时它再调用这个终端），
		// 未读的输出读掉了，「输出停了多久」照样接着算，不然只能等到最晚的时刻。
		let news = false;
		for (;;) {
			if (this.sessions.get(session.info.terminalId) !== session) return 'closed';
			if (session.info.status !== 'running') return 'exited';
			if (session.info.controller !== 'ai') return 'user';
			const now = Date.now();
			const latest = deadline();
			if (now >= latest) return 'deadline';
			news ||= hasNews();
			// 有新输出时从最近一次输出算，一直没有新输出时从这次等待开始算；两种都是 idleMs 内再没有新输出就返回。
			const quietAt = Math.max(session.lastActivityAt, startedAt) + idleMs;
			if (now >= quietAt) {
				if (news) return 'idle';
				if (!untilOutput) return 'silent';
			}
			// 睡到「再没有输出就算停够了」的时刻，中间又有输出，醒来再算；还没有新输出时也睡到那时。
			// 等它的输出（untilOutput）时，一直没有新输出就一直睡到最晚时刻：这期间不会有「告一段落」。
			const wakeAt = !news && untilOutput ? latest : Math.min(latest, quietAt);
			await sleep(session, wakeAt - now, !news, signal);
		}
	}

	/** 读输出：new 是这个成员上次读到之后的内容（按渲染后的行），screen 是当前整屏。全屏程序总是返回整屏。 */
	private async read(session: ISession, memberId: string, mode: 'new' | 'screen'): Promise<string> {
		await flush(session);
		session.readSeq.set(memberId, session.seq);
		const buffer = session.screen.buffer.active;
		if (mode === 'screen' || buffer.type === 'alternate') {
			return clip(renderLines(buffer, buffer.baseY, buffer.baseY + session.info.rows - 1));
		}
		const position = session.readLines.get(memberId) ?? 0;
		const cursorLine = buffer.baseY + buffer.cursorY;
		const start = position - session.trimmedLines;
		// 第一次读时从屏幕上第一行有内容的地方开始：缓冲区开头那些空白是还没写过的地方，不是程序的输出
		// （ConPTY 启动时首行是空的，从第 0 行读会让结果以空行开头）。程序自己输出的空行在第一个非空行之下，不受影响。
		const lines = renderLineList(buffer, start > 0 ? start : firstWrittenRow(buffer), cursorLine);
		// 从光标所在行开始记：这一行可能还没写完（例如提示符），下次读时会完整地再给一次。
		// 但那一行没变就不再给：转后台时，通知和后台任务的结果是两次读，共用这个游标，重复给成员会看到两遍同一段。
		const given = session.readText.get(memberId);
		if (start >= 0 && given !== undefined && lines.length > 0 && lines[0] === given) lines.shift();
		const text = trimTrailingBlanks(lines).join('\n');
		session.readLines.set(memberId, session.trimmedLines + cursorLine);
		session.readText.set(memberId, rowText(buffer, cursorLine));
		return clip(position < session.trimmedLines ? `……（更早的输出已超出缓冲区）\n${text}` : text);
	}

	/** 运行时退出时关闭全部终端，等里面的进程（包括之前关闭的终端里的）结束，最多等 SHUTDOWN_WAIT_MS。 */
	async shutdown(): Promise<void> {
		for (const session of this.sessions.values()) {
			if (session.info.status === 'running') this.kill(session);
		}
		for (const terminalId of [...this.sessions.keys()]) this.remove(terminalId);
		await Promise.race([Promise.all(this.killing), delay(SHUTDOWN_WAIT_MS, undefined, { ref: false })]);
	}

	private kill(session: ISession): void {
		// 结束时出错也不影响关闭终端。
		const killing = killPty(session.pty).catch(() => undefined).finally(() => this.killing.delete(killing));
		this.killing.add(killing);
	}

	/** 用户操作期间成员调用了这个终端：记下它在等，已经请过用户接管的保留请求。 */
	private markWaiting(session: ISession, memberId: string): void {
		if (!session.waiting.has(memberId)) session.waiting.set(memberId, null);
	}

	private require(terminalId: string): ISession {
		const session = this.sessions.get(terminalId);
		if (!session) throw notFound(wrongKind(terminalId, 'T') ?? `终端 ${terminalId} 不存在（可能已关闭，或运行时已重启）`);
		return session;
	}

	private update(session: ISession, changes: Partial<ITerminalInfo>): ITerminalInfo {
		session.info = { ...session.info, ...changes };
		wakeAll(session.stateWakers);
		this.events.emit({ type: 'terminal.changed', terminalId: session.info.terminalId });
		return session.info;
	}

	private remove(terminalId: string): void {
		const session = this.sessions.get(terminalId);
		if (!session) return;
		this.sessions.delete(terminalId);
		wakeAll(session.stateWakers);
		if (session.waiters === 0) session.screen.dispose();
		this.events.emit({ type: 'terminal.changed', terminalId });
	}
}

/** 叫醒在等的调用。它们醒来时把自己从集合里去掉，所以先复制一份再叫。 */
function wakeAll(wakers: Set<() => void>): void {
	if (wakers.size === 0) return;
	for (const wake of [...wakers]) wake();
}

/** 睡 ms 毫秒，终端状态变了提前醒；untilOutput 时出现输出或输入也提前醒。signal 中止时抛出。 */
function sleep(session: ISession, ms: number, untilOutput: boolean, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason);
			return;
		}
		const stop = () => {
			clearTimeout(timer);
			session.stateWakers.delete(wake);
			session.outputWakers.delete(wake);
			signal.removeEventListener('abort', abort);
		};
		const wake = () => {
			stop();
			resolve();
		};
		const abort = () => {
			stop();
			reject(signal.reason);
		};
		const timer = setTimeout(wake, ms);
		session.stateWakers.add(wake);
		if (untilOutput) session.outputWakers.add(wake);
		signal.addEventListener('abort', abort, { once: true });
	});
}

function interactiveArguments(shell: IShell): string[] {
	switch (shell.kind) {
		case 'bash': return ['--login', '-i'];
		case 'zsh': return ['-l', '-i'];
		case 'sh': return ['-i'];
		case 'pwsh':
		case 'powershell': return ['-NoLogo'];
	}
}

function terminalEnvironment(shell: IShell): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	return {
		...env,
		// 每条命令结束、显示提示符之前报出当前目录，见 Terminals.currentDirectory。
		...shell.kind === 'bash' && { PROMPT_COMMAND: [env['PROMPT_COMMAND'], DIRECTORY_HOOK].filter(Boolean).join(';') },
		TERM: 'xterm-256color',
		COLORTERM: 'truecolor',
		...NO_PAGER,
		// MSYS2 的登录 shell 默认会切到家目录，设置这个才留在起始目录。
		CHERE_INVOKING: '1',
	};
}

/** 报当前目录用的 OSC 序列（iTerm2 的写法）：ESC ] 1337 ; CurrentDir=路径 BEL。 */
const DIRECTORY_OSC = 1337;
const DIRECTORY_PREFIX = 'CurrentDir=';
/**
 * Windows 上 $PWD 是 /e/work、/tmp/x 这种写法，/tmp 这类挂载的目录不知道对应哪里，所以用 Git Bash 的 pwd -W 报 E:/work。
 * 不支持 -W 的 bash 报空的，当成看不清。不用 $(...)：它要新开进程，每个提示符都慢一截。
 */
const DIRECTORY_HOOK = process.platform === 'win32'
	? `printf '\\033]${DIRECTORY_OSC};${DIRECTORY_PREFIX}'; pwd -W 2>/dev/null; printf '\\007'`
	: `printf '\\033]${DIRECTORY_OSC};${DIRECTORY_PREFIX}%s\\007' "$PWD"`;

/** 报出来的目录；不是绝对路径（包括空的）时是 undefined。 */
function reportedDirectory(text: string): string | undefined {
	const path = text.replace(/[\r\n]+$/, '');
	if (process.platform !== 'win32') return isAbsolute(path) ? path : undefined;
	return /^[a-zA-Z]:[\\/]/.test(path) ? win32.normalize(path) : undefined;
}

/**
 * 主缓冲区开头的行被裁掉时通知（滚出回滚上限，或者 ESC[3J 清除回滚）。xterm 没有公开这个事件，用的是内部的行列表；
 * 取不到时不计数，只是滚出去的旧行会被当成没读过的内容。
 */
function onTrim(screen: xterm.Terminal, listener: (count: number) => void): void {
	const lines = (screen as unknown as { _core?: { buffers?: { normal?: { lines?: { onTrim?: (listener: (count: number) => void) => unknown } } } } })
		._core?.buffers?.normal?.lines;
	if (typeof lines?.onTrim === 'function') lines.onTrim(listener);
}

/** 等屏幕处理完已经收到的输出。 */
function flush(session: ISession): Promise<void> {
	return new Promise(resolve => session.screen.write('', resolve));
}

/** 把缓冲区里 [start, end] 这些行转成文字：折行接回一行，去掉末尾的空行。 */
function renderLines(buffer: xterm.IBuffer, start: number, end: number): string {
	return trimTrailingBlanks(renderLineList(buffer, start, end)).join('\n');
}

/** 缓冲区里 [start, end] 这些行的文字：折行接回一行。 */
function renderLineList(buffer: xterm.IBuffer, start: number, end: number): string[] {
	const lines: string[] = [];
	for (let index = Math.max(0, start); index <= Math.min(end, buffer.length - 1); index++) {
		const line = buffer.getLine(index);
		if (!line) continue;
		const text = line.translateToString(true);
		if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
		else lines.push(text);
	}
	return lines;
}

/** 去掉末尾的空行：缓冲区底下那些没写过的是整行空白。 */
function trimTrailingBlanks(lines: string[]): string[] {
	while (lines.length > 0 && !lines.at(-1)!.trim()) lines.pop();
	return lines;
}

/** 缓冲区里第一行有内容的位置：之前那些空白行是还没写过的地方。 */
function firstWrittenRow(buffer: xterm.IBuffer): number {
	for (let index = 0; index < buffer.length; index++) {
		const line = buffer.getLine(index);
		if (line && line.translateToString(true).trim()) return index;
	}
	return buffer.length;
}

/** 这一行现在的内容。 */
function rowText(buffer: xterm.IBuffer, index: number): string {
	return buffer.getLine(index)?.translateToString(true) ?? '';
}

function clip(text: string): string {
	return clipMiddle(text, HEAD_CHARS, TAIL_CHARS);
}

/**
 * 结束伪终端和里面的全部进程。
 * Windows 上只关伪控制台不够：bash 这类 MSYS 程序在控制台关掉后常常不退出，它们启动的程序也跟着留下。
 * 所以先取控制台上的进程列表，结束 shell 以外的进程，再关伪控制台，最后结束 shell。
 * shell 要最后结束：它一结束，node-pty 就丢掉伪控制台的句柄，伪控制台就关不掉了。
 * 取到列表之后才启动的进程（关闭时命令恰好在启动新程序）会漏掉，所以取到列表马上结束进程，不先关伪控制台（要几十毫秒）。
 * 不用 node-pty 的 kill()：它取列表和关伪控制台同时进行，常常取不到列表（报 AttachConsole failed），取列表的进程也没有隐藏窗口。
 * 取不到内部对象时退回 kill()。
 */
async function killPty(pty: IPty): Promise<void> {
	const agent = windowsAgent(pty);
	if (!agent) {
		pty.kill();
		return;
	}
	const processes = (await consoleProcesses(pty.pid)).filter(pid => pid !== pty.pid);
	processes.forEach(killProcess);
	agent._ptyNative.kill(agent._pty, agent._useConptyDll);
	killProcess(pty.pid);
	// 结束进程要一点时间，等它们结束。之后系统还要一会儿才放开它们打开的文件和工作目录。
	const all = [pty.pid, ...processes];
	for (let waited = 0; waited < KILL_WAIT_MS && all.some(isAlive); waited += 50) await delay(50);
}

function killProcess(pid: number): void {
	try {
		process.kill(pid);
	} catch {
		// 已经结束了。
	}
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** 附着在 shell 的控制台上的全部进程；取不到时是空的。 */
function consoleProcesses(shellPid: number): Promise<number[]> {
	return new Promise(resolve => {
		const child = spawnProcess(process.execPath, [CONSOLE_LIST_AGENT, String(shellPid)], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
		const timer = setTimeout(() => child.kill(), CONSOLE_LIST_TIMEOUT_MS);
		const done = (list: number[]) => {
			clearTimeout(timer);
			resolve(list);
		};
		child.once('message', message => done((message as { consoleProcessList?: number[] }).consoleProcessList ?? []));
		child.once('exit', () => done([]));
		child.once('error', () => done([]));
	});
}

/**
 * 进程退出后 node-pty 在 Windows 上留着输入管道和读输出的线程，不释放的话进程退不出、也会泄漏。
 */
function releaseWindowsHandles(pty: IPty): void {
	const agent = windowsAgent(pty);
	agent?._conoutSocketWorker?.dispose();
	agent?._inSocket?.destroy();
}

interface IWindowsAgent {
	readonly _ptyNative: { kill(pty: number, useConptyDll: boolean): void };
	readonly _pty: number;
	readonly _useConptyDll: boolean;
	readonly _conoutSocketWorker?: { dispose(): void };
	readonly _inSocket?: { destroy(): void; on(event: 'error', listener: () => void): unknown };
}

/** xterm.js 内部的屏幕，下面几处用到的部分。 */
interface IScreenCore {
	readonly coreService: { readonly isCursorHidden: boolean };
	readonly buffers: { readonly normal: IScreenBuffer; readonly alt: IScreenBuffer };
	readonly _windowsWrappingHeuristics: { clear(): void };
}

interface IScreenBuffer {
	readonly lines: { readonly length: number; get(index: number): { resize(cols: number, fill: unknown): unknown } | undefined };
	getNullCell(): unknown;
}

function screenCore(screen: xterm.Terminal): IScreenCore {
	return (screen as unknown as { _core: IScreenCore })._core;
}

/**
 * 关掉 xterm.js 不重排时（见 WINDOWS_PTY）自带的折行猜测：某一行写满后换行，就把下一行标成这一行折过来的接续。
 * 这是给旧版 ConPTY 准备的，它输出长行时用换行代替折行；新版的长行是真的折行，xterm.js 自己会标。
 * 排查记录：猜测会把 Claude Code 占满一行的分隔线和下一行标成同一行。AI 读屏幕时这两行连在了一起；生成快照的 SerializeAddon
 * 还原这种折行时，下一行开头的空格没有输出成真正的折行，刷新网页后那一行往前挪到了上一行末尾（分隔线最后多出一个「T」，
 * 下一行变成「ranscript saving is off」）。xterm.js 没有公开开关，用的是内部的字段。
 */
function disableWrapGuess(screen: xterm.Terminal): void {
	screenCore(screen)._windowsWrappingHeuristics.clear();
}

/** 程序隐藏了光标（ESC[?25l）。xterm.js 没有公开这个状态。 */
function cursorHidden(screen: xterm.Terminal): boolean {
	return screenCore(screen).coreService.isCursorHidden;
}

/**
 * 把屏幕上的每一行截到 cols 列。xterm.js 不重排时（见 WINDOWS_PTY）变窄不截掉行尾，旧内容留在看不到的地方，
 * 而生成快照的 SerializeAddon 按行的实际长度输出、前端按终端的列数显示，多出来的部分会折到下一行。
 * 排查记录：窗口变窄后刷新网页，Claude Code 的输入行后面多出一串灰色的「-」，光标也恢复到错的位置。原因是分隔线
 * 正好占满一行，不重排时 xterm.js 会把下一行标成折行的接续；SerializeAddon 要还原这种折行，先按行的实际长度补「-」
 * 把光标挤到下一行再擦掉，行比终端宽时补多了、擦不掉。AI 读到的屏幕也会带上看不到的旧内容。
 * xterm.js 没有公开截断的接口，用的是内部的缓冲区。
 */
function trimLines(screen: xterm.Terminal, cols: number): void {
	const { normal, alt } = screenCore(screen).buffers;
	for (const buffer of [normal, alt]) {
		for (let index = 0; index < buffer.lines.length; index++) buffer.lines.get(index)?.resize(cols, buffer.getNullCell());
	}
}

function windowsAgent(pty: IPty): IWindowsAgent | undefined {
	if (process.platform !== 'win32') return undefined;
	const agent = (pty as unknown as { _agent?: Partial<IWindowsAgent> })._agent;
	return agent && typeof agent._ptyNative?.kill === 'function' && typeof agent._pty === 'number' ? agent as IWindowsAgent : undefined;
}
