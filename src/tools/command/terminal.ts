import { invalid, RuntimeError } from '../../common/errors.ts';
import type { ShellLocator } from '../../shells/shells.ts';
import type { ITerminalReading, Terminals } from '../../terminals/terminals.ts';
import type { DataProtection } from '../protection.ts';
import type { ITool, TaskDelivery } from '../tools.ts';
import { checkCommand, commandLanguage } from './commandApproval.ts';
import type { CommandParser } from './commandParser.ts';
import { refusedCommandReason } from './refusal.ts';

/**
 * 时间只管这一次调用什么时候返回，到时程序照常运行（终端要主动关闭才结束），和 shell 的 timeout_ms 不是一回事。
 * 一次调用最长等多久不给模型定：有这个参数，工具在模型眼里就是一个可以设定时长的等待手段，它一遍遍地调用来「再等一会儿」，
 * 设的值也不合适。调用等到输出告一段落为止，超过转后台的时间就转为后台任务，在后台最多等 TERMINAL_WAIT_MS：
 * 这是「最长多久回来看一次」，半小时够了。
 * idle_ms 默认 3 秒：2 秒时命令行智能体这类程序中途停顿一下调用就返回，成员拿到半截内容只能再读；再大则平常往终端里输入一条命令，输出结束后要等这么久才返回。
 * 一直没有新输出时也按 idle_ms 等，不单独等得更久：两种情形对成员是一回事，都是输入了内容、终端没有反应；等得越久它越晚知道。
 * 见设计文档「终端」的「长时间的等待」。
 */
export const TERMINAL_WAIT_MS = 30 * 60 * 1000;
const DEFAULT_IDLE_MS = 3_000;
/**
 * idle_ms 的上限。不能和转后台的时间（30 秒）持平：两边同时到点时，这次调用是返回还是转后台就不确定了。
 * 留出的这 10 秒也是 background 的余量：它等完 idle_ms 自己转后台，总赶在执行器的 30 秒之前。
 * 再长的等待本来也该交给 background，让它转成后台任务去等。
 */
const MAX_IDLE_MS = 20_000;
/** idle_ms 的下限：比这更短连一次调度、管道刷新的抖动都盖不住，只会提前返回半截内容。 */
const MIN_IDLE_MS = 1_000;
const MAX_REQUEST_LENGTH = 200;
/** 同一次运行里对同一个终端连续只读不输入达到这么多次、程序还在跑，就提示改成等待一次。 */
const READS_BEFORE_HINT = 3;

/** 终端的状态和读到的输出；关闭终端时只返回一句说明。 */
interface ITerminalResult {
	readonly terminalId: string;
	readonly running: boolean;
	readonly exitCode: number | null;
	/** 用户接管了终端，这时只能读不能输入。 */
	readonly userControlling: boolean;
	/** 这次调用请了用户接管。 */
	readonly askedUser: boolean;
	/** 等待期间终端被关闭了：user 是用户，否则是关闭它的成员 ID；没被关闭时是 null。 */
	readonly closedBy: string | null;
	/** 等待被中止了（运行停止），没等输出告一段落就返回。 */
	readonly interrupted: boolean;
	readonly output: string;
	/** 等待为什么结束：转为后台任务的写输出停了多久、等了多久，一直没有新输出的写等了多久；别的情况没有。 */
	readonly ended?: string;
	/** 这个成员正在等这个终端的后台任务的编号；没有时不写。 */
	readonly waitingTask?: string;
	/** 这次输入的内容没有以回车结尾（见 endsWithoutEnter）；别的情况不写。 */
	readonly noEnter?: boolean;
}

/** 一次可能转为后台任务的等待：一个成员对一个终端最多一个。 */
interface IWait {
	readonly terminalId: string;
	readonly idleMs: number;
	readonly mode: 'new' | 'screen';
	/** 这次输入的内容没有以回车结尾，转后台时的结果里也要写。 */
	readonly noEnter: boolean;
	/** 转后台之前这次调用已经读到的输出：它属于这次调用的结果，转后台时要接在说明里，不能丢。 */
	pendingOutput?: string;
	/** 最晚等到什么时刻。这个成员再调用这个终端时，顺延到那次调用之后的 maxWaitMs。 */
	deadline: number;
	/** 转为后台任务以后才有。 */
	taskId: string | undefined;
	/** 任务结束时结果怎么交给成员，等待结束时定下。 */
	delivery: TaskDelivery;
	/** 最近一次就这个等待给成员追加系统提示是在哪次运行里：同一次运行里最多一条。 */
	noticedRunId: number | undefined;
}

/**
 * backgroundAfterMs 是调用执行多久转为后台任务，和执行器用的是同一个值：转不了后台的调用（已经有后台任务在等这个终端、
 * 脚本里的调用）最多等到这么久。maxWaitMs 是转为后台任务的等待最多等多久。
 * notify 在成员的时间线里追加一条系统提示（不唤醒）：等待任务会怎样、不必反复读取这些话不写在工具结果里，
 * 接在终端画面后面会被模型当成终端里的内容。见设计文档「终端」的「长时间的等待」里的「系统提示」。
 */
export function createTerminalTool(
	terminals: Terminals, shells: ShellLocator, parser: CommandParser, protection: DataProtection, backgroundAfterMs: number, maxWaitMs: number,
	notify: (memberId: string, text: string) => void,
): ITool<ITerminalResult | string> {
	/** 输入执行时的当前目录：新建的终端是工作目录，已有的终端是它报出的当前目录。 */
	const directory = async (workingDirectory: string, args: Record<string, unknown>) => {
		const terminalId = args['terminal_id'];
		return typeof terminalId === 'string' ? terminals.currentDirectory(terminalId) : workingDirectory;
	};
	/** 在等的（可能转后台、或者已经转了的）等待，按成员和终端记；等待结束就去掉。 */
	const waits = new Map<string, IWait>();
	/** 按调用的参数找到它的等待：转后台、任务结束时执行器只带着参数来问。 */
	const waitsByArgs = new WeakMap<Record<string, unknown>, IWait>();
	const waitKey = (memberId: string, terminalId: string) => `${memberId}\n${terminalId}`;
	const afterText = durationText(backgroundAfterMs);
	const description = `操作交互式终端：新建终端、输入内容、读取输出，用户也能看到这些终端。用于需要交互或持续运行的程序（如开发服务器、REPL、ssh、会提问的安装脚本），或用户要求使用终端时。
- 新建终端的起始目录为工作目录。终端可与其他成员共用，知道终端 ID 即可操作。
- 每次调用在以下任一情况下返回：出现新输出后连续 idle_ms 无新输出；一直没有新输出时同样等满 idle_ms；程序退出。返回不影响程序，程序会继续运行。
- 调用超过 ${afterText}未返回时会转到后台继续执行，结束时结果会自动推送给你，在此之前可以结束本轮回复或处理其他事情。
- 要等的程序可能长时间没有任何输出时，把 background 设为 true。
- 程序需要运行较长时间时（如另一个命令行智能体、耗时的构建），不要反复读取：调用一次，并将 idle_ms 设为略大于程序中途停顿的时间。
- 使用完毕后，用 close 关闭终端。
- 遇到需要输入密码、验证码，或需要用户本人确认的提示时，不要猜测，也不要让用户把密码发给你：用 ask_user 请用户接管该终端自行输入，并写明需要用户做什么。用户操作期间你只能读取输出，调用会立即返回；用户交还终端后你会收到通知。`;
	/**
	 * 在后台执行的那次调用会怎样，接在开头那一句后面，写任务的实际数值。给模型的话里不说「等待转为后台任务」「唤醒」：
	 * 那是运行时里的说法，模型只认得工具调用、工具结果和收到的内容，所以说「调用转到后台继续执行」「结果推送给你」。
	 * 在后台继续的是这次调用，不是终端里的程序，所以写明这次调用什么时候结束；写明出错退出也算：模型反复查看，
	 * 一是怕中途出错没人发现，二是以为自己得留在这一轮里盯着，所以也要说明本轮回复结束不影响后台任务。
	 * 不写「请结束本轮回复」：成员可能还有别的事要做。不写最晚什么时候结束、收到结果后该做什么、怎样取消，
	 * 见设计文档「终端」的「长时间的等待」里的「系统提示」。
	 */
	const waitText = (wait: IWait) => `终端 ${wait.terminalId} 的输出停止 ${durationText(wait.idleMs)}后，或程序退出（包括出错退出）时，该调用结束，结果会自动推送给你。`
		+ '在此期间无需为此终端调用 terminal 工具。你可以继续处理其他工作；若无其他工作，等待结果推送即可，本轮回复结束不影响后台任务。';
	// 连着读了几次都很快返回，是 idle_ms 比程序中途的停顿短。这时还没有后台任务在等，要告诉它怎样得到一个：
	// 再调用一次并设 background，一句话说清之后什么时候会收到结果。不教它调 idle_ms（那是「等多久」，会变成轮询）。
	const readsText = (terminalId: string) => `系统提示：你已连续 ${READS_BEFORE_HINT} 次读取终端 ${terminalId}，程序仍在运行。如果是在等它完成，无需反复读取：`
		+ '再调用一次并把 background 设为 true，这次调用会在 idle_ms 之后转为后台任务，终端出现新输出或程序退出时结果自动推送给你。';

	return {
		name: 'terminal',
		label: '使用终端',
		description,
		parameters: {
			type: 'object',
			properties: {
				terminal_id: { type: 'string', description: '要操作的终端 ID；不填时新建终端' },
				input: { type: 'string', description: '要输入的内容，换行表示回车；控制键用 JSON 转义表示，如 Ctrl+C 为 \\u0003，Ctrl+D 为 \\u0004；不填时读取新输出' },
				idle_ms: { type: 'integer', minimum: MIN_IDLE_MS, maximum: MAX_IDLE_MS, description: `输出告一段落的时间（毫秒）：出现新输出后，连续该时长无新输出即视为告一段落并返回；一直没有新输出时，等满该时长也返回。应略大于程序中途停顿的时间：过小会在程序停顿时提前返回，过大则程序结束后要等同样长的时间才返回。默认 ${DEFAULT_IDLE_MS}，最大 ${MAX_IDLE_MS}` },
				background: { type: 'boolean', description: `为 true 时，等到 idle_ms 之后如果终端没有新输出，这次调用直接转为后台任务：之后的新输出、或程序退出时，结果会自动推送给你，在此之前可以结束本轮回复或处理其他事情。一直没有新输出时，这个后台任务最多等 ${durationText(maxWaitMs)}，到时会自动完成，结果同样推送给你。程序已经结束的直接返回结果` },
				output: { type: 'string', enum: ['new', 'screen'], description: 'new：上次读取之后的输出（默认）；screen：当前整屏内容，适用于 top、vim 等全屏程序' },
				close: { type: 'boolean', description: '为 true 时关闭该终端' },
				ask_user: { type: 'string', description: `请用户接管该终端时，写明需要用户做什么，如「输入 sudo 密码」，网页端会向用户显示；最多 ${MAX_REQUEST_LENGTH} 字。用户交还终端时会通知你` },
			},
			additionalProperties: false,
		},
		returns: '{ terminalId: string; running: boolean; exitCode: number | null; userControlling: boolean; askedUser: boolean; closedBy: string | null; interrupted: boolean; output: string; ended?: string; waitingTask?: string; noEnter?: boolean } | string',
		defaultPolicy: 'auto',
		enabledByDefault: false,
		autoPolicy: { label: '安全命令免审批', description: '新建终端时输入的查看类命令直接执行，向已有终端输入须审批；审批时可选择允许该终端中的所有输入' },
		// 转后台的是「等待」，不是程序：等得久的调用转为后台任务，等待结束时唤醒成员，见设计文档「终端」的「长时间的等待」。
		background: true,
		// 只关闭或只请用户接管的，照普通调用执行。这个成员已经有一个在等这个终端的，也不再转：
		// 一个成员对一个终端最多一个等待任务。
		staysForeground: (context, args) => {
			// 要等它输出（background）的调用走转后台那条路：执行器要给它「现在就转」的机会，不能当成普通调用一次性跑完。
			if (args['background'] === true) return false;
			if (args['close'] === true || (typeof args['ask_user'] === 'string' && !args['input'])) return true;
			const terminalId = args['terminal_id'];
			return typeof terminalId === 'string' && waits.has(waitKey(context.memberId, terminalId));
		},
		// 新建、读取和关闭不用审批。输入内容时，只有新建终端的第一条完整命令能按规则自动判断：
		// 往已有终端里输入，无法知道终端里正在运行什么，输入可能是在回答程序的提问，都要审批；
		// 用户审批时选了「这个终端里都允许」的除外。
		needsApproval: async (context, args) => {
			const input = args['input'];
			if (typeof input !== 'string' || !input || args['close'] === true) return undefined;
			const terminalId = args['terminal_id'];
			if (typeof terminalId === 'string') return terminals.trusts(terminalId, context.memberId) ? undefined : '向已有终端输入';
			if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(input)) return '输入含有控制字符';
			if (!/[\r\n]$/.test(input)) return '输入不是以回车结尾的完整命令';
			const options = { directory: context.workingDirectory, workingDirectory: context.workingDirectory, protection };
			return (await checkCommand(parser, shells.current(), input.replace(/[\r\n]+$/, ''), options)).reasons;
		},
		// 灾难级的命令不管审批方式，直接拒绝。往已有终端里输入时也检查。bash 整段一起看，前一行的 cd 对后一行也算；
		// 其他 shell 每一行单独看。
		refuseReason: async (context, args) => {
			const input = args['input'];
			if (typeof input !== 'string' || !input || args['close'] === true) return undefined;
			const language = commandLanguage(shells.current());
			const current = await directory(context.workingDirectory, args);
			const text = commandText(input);
			for (const line of language === 'bash' ? [text] : text.split('\n')) {
				const reason = await refusedCommandReason(parser, language, line, current);
				if (reason) return reason;
			}
			return undefined;
		},
		// 相对路径按终端现在的当前目录解析。
		protectedReasons: async (context, args) => {
			const input = args['input'];
			if (typeof input !== 'string' || !input || args['close'] === true) return [];
			const options = { directory: await directory(context.workingDirectory, args), workingDirectory: context.workingDirectory, protection };
			return (await checkCommand(parser, shells.current(), commandText(input), options)).protectedReasons;
		},
		execute: async (context, args) => {
			const terminalId = optionalString(args, 'terminal_id');
			const input = optionalString(args, 'input');
			const idleMs = idleOf(args);
			const wantedBackground = args['background'] === true;
			if (args['output'] !== undefined && args['output'] !== 'new' && args['output'] !== 'screen') throw invalid('output 只能是 new 或 screen');
			const mode: 'new' | 'screen' = args['output'] === 'screen' ? 'screen' : 'new';
			if (args['close'] !== undefined && typeof args['close'] !== 'boolean') throw invalid('close 只能是 true 或 false');
			if (args['background'] !== undefined && typeof args['background'] !== 'boolean') throw invalid('background 只能是 true 或 false');
			const askUser = optionalString(args, 'ask_user')?.trim();
			if (askUser !== undefined && (!askUser || askUser.length > MAX_REQUEST_LENGTH)) throw invalid(`ask_user 须写明需要用户做什么，最多 ${MAX_REQUEST_LENGTH} 字`);
			const { memberId } = context;

			if (args['close'] === true) {
				if (!terminalId) throw invalid('关闭终端须提供 terminal_id');
				// 它自己在等这个终端的后台任务随之结束，不另发结果、不唤醒（见下面的 delivery），在这里说一声。
				const waiting = waits.get(waitKey(memberId, terminalId));
				terminals.close(terminalId, { memberId });
				return waiting?.taskId ? `已关闭终端 ${terminalId}，等待该终端的后台任务 ${waiting.taskId} 随之结束` : `已关闭终端 ${terminalId}`;
			}
			// 从这里到开始等待之间不让出：登记等待要赶在同时发出的另一个调用之前，见 ITool.staysForeground。
			const id = terminalId ?? terminals.create(memberId, context.workingDirectory).terminalId;
			if (context.trustTerminal) terminals.trust(id, memberId);
			if (input) terminals.input(id, input, { memberId });
			// 输入表示成员把终端拿回来自己用了，不再等用户接管；只读是边等边看，请求留着。
			// 放在输入之后：用户正占用时输入会被拒绝，这时它还在等，不该撤销。
			if (input && !askUser) terminals.cancelTakeover(id, memberId);
			const noEnter = !!input && endsWithoutEnter(input);
			const key = waitKey(memberId, id);
			const startedAt = Date.now();
			// 已经有一个在等这个终端的：这次照常读，最多等到转后台的时间，不再转；那个等待最晚结束的时刻从这次调用重新算。
			// 只顺延最晚的时刻，「输出停了多久」不重新算，它的 idle_ms 也不跟着这次调用改。
			const existing = waits.get(key);
			if (existing) existing.deadline = startedAt + maxWaitMs;
			const own: IWait | undefined = !existing && context.mayBackground
				? { terminalId: id, idleMs, mode, noEnter, deadline: startedAt + maxWaitMs, taskId: undefined, delivery: 'wake', noticedRunId: undefined }
				: undefined;
			if (own) {
				waits.set(key, own);
				waitsByArgs.set(args, own);
			}
			// 转不了后台的调用最多等到转后台的时间。只请用户接管、没有输入时不等新输出：接下来是用户操作，读一次现在的输出就返回。
			const until = startedAt + (askUser && !input ? 0 : backgroundAfterMs);
			// 运行停止、终端被关闭时也照常返回终端 ID 和读到的输出，之后还能找回这个终端。
			const options = { idleMs, deadline: () => own ? own.deadline : until, mode, signal: context.signal };
			let reading: ITerminalReading;
			try {
				reading = await terminals.waitAndRead(id, memberId, options);
				// background：第一次等待结束（输入后该出来的反应已经看到了）时程序还在跑，就现在转后台任务，不等 30 秒；
				// 自己接着等下一次输出。这次调用的结果只是一句说明，所以先把它读到的输出记在等待上，转后台时接进说明里。
				// 请用户接管的调用不转：接下来是用户操作，等多久由用户决定，转后台反而不对（接管请求要等任务结束才发出去）。
				if (wantedBackground && own && own.taskId === undefined && context.backgroundNow && !askUser
					&& !reading.interrupted && reading.closedBy === undefined && reading.info.status === 'running'
					&& reading.ended !== 'user' && reading.ended !== 'deadline') {
					own.pendingOutput = reading.output;
					// 30 分钟从转后台这一刻算，不是从调用开始算。
					own.deadline = Date.now() + maxWaitMs;
					context.backgroundNow();
					// 转后台以后等的是「下一次」输出：一直没有新输出不算告一段落，否则刚转过去就又结束了。
					reading = await terminals.waitAndRead(id, memberId, { ...options, untilOutput: true });
				}
			} finally {
				if (own && waits.get(key) === own) waits.delete(key);
			}
			if (askUser && reading.closedBy === undefined && reading.info.status === 'running') terminals.requestTakeover(id, memberId, askUser);
			const { info } = reading;
			const closedBy = reading.closedBy === undefined ? null : reading.closedBy === 'user' ? 'user' : reading.closedBy.memberId;
			const running = closedBy === null && info.status === 'running';
			const backgrounded = own?.taskId !== undefined;
			// 后台任务的结果怎么交给成员。它自己关的终端：不另发、不唤醒，关闭的结果里已经说了。用户接管了：进时间线但不唤醒，
			// 它已经记为在等这个终端，交还时会唤醒；接管时就唤醒，它只能得知用户在操作，交还时还要再唤醒一次。
			if (own) own.delivery = closedBy === memberId ? 'none' : reading.ended === 'user' ? 'noWake' : 'wake';
			// 连着只读了几次：输入过、这次等待转成了后台任务（正是要它这样做），都从头数。
			const reads = context.call && !context.inScript ? terminals.countRead(id, memberId, context.call.runId, !input && !backgrounded) : 0;
			// 这次调用等的时候那个任务可能已经结束了，还在才算。
			const waitingTask = existing?.taskId && running && waits.get(key) === existing ? existing.taskId : undefined;
			const runId = context.call?.runId;
			if (existing && waitingTask) {
				// 结果的第一行只写状态；要说的话追加一条系统提示，同一次运行里针对这个任务最多一条（转后台的那次运行里已经有了）。
				if (runId !== undefined && existing.noticedRunId !== runId) {
					existing.noticedRunId = runId;
					notify(memberId, `系统提示：你此前对终端 ${id} 的 terminal 调用仍在后台执行（后台任务 ${waitingTask}）。${waitText(existing)}`);
				}
			} else if (!existing && reads >= READS_BEFORE_HINT && running && info.controller === 'ai' && runId !== undefined && terminals.claimReadsHint(id, memberId, runId)) {
				// 只靠工具说明，较弱的模型往往还是一遍遍地看；连着只读了几次程序还在跑，就提示一次。
				notify(memberId, readsText(id));
			}
			return {
				terminalId: id, running, exitCode: info.exitCode, userControlling: info.controller === 'user',
				askedUser: !!askUser && running,
				closedBy, interrupted: reading.interrupted, output: reading.output,
				...backgrounded && reading.ended === 'idle' && { ended: `输出已停止 ${durationText(idleMs)}` },
				...reading.ended === 'silent' && { ended: `${durationText(idleMs)}内无新输出` },
				...backgrounded && reading.ended === 'deadline' && { ended: `已等待 ${durationText(Date.now() - startedAt)}` },
				...waitingTask && { waitingTask },
				...noEnter && running && { noEnter },
			};
		},
		// 转后台时就要给终端 ID（新建的终端，等待结束前成员要靠它找到这个终端）和到这时的输出；之后结束时只给这以后的。
		// 第一行和平常的结果一样，网页端从里面认终端 ID，状态里多一项「本次调用已转到后台」：不写的话这条结果单看和正常返回没有区别。
		// 输出后面不再接任何话：接在终端画面后面会被模型当成终端里的内容。之后会怎样追加一条系统提示。
		backgroundNotice: async (context, args, taskId) => {
			const wait = waitsByArgs.get(args);
			if (!wait) return undefined;
			wait.taskId = taskId;
			let status = '运行中';
			let output = '';
			try {
				const reading = await terminals.readNow(wait.terminalId, context.memberId, wait.mode);
				status = reading.info.status === 'running' ? '运行中' : `已退出，退出码 ${reading.info.exitCode}`;
				// 转后台之前读到的（输入后那一段）和之后又出来的，都算这次调用的输出。
				output = (wait.pendingOutput ?? '') + reading.output;
			} catch (error) {
				// 终端恰好在这时被关闭了：任务马上结束，结果里会写明。
				if (!(error instanceof RuntimeError)) throw error;
			}
			wait.noticedRunId = context.call?.runId;
			notify(context.memberId, `系统提示：本次 terminal 调用尚未结束，已转到后台继续执行（后台任务 ${taskId}）。${waitText(wait)}`);
			return `[终端 ${wait.terminalId}，${status}${wait.noEnter ? `，${NO_ENTER_TEXT}` : ''}，本次调用已转到后台]\n${output || '（无输出）'}`;
		},
		taskDelivery: args => waitsByArgs.get(args)?.delivery ?? 'wake',
		taskStatus: taskId => {
			for (const wait of waits.values()) {
				if (wait.taskId === taskId) return { summary: `等待终端 ${wait.terminalId}：出现新输出后停止 ${durationText(wait.idleMs)}或程序退出时结束`, returnsAt: wait.deadline };
			}
			return undefined;
		},
		format(result) {
			if (typeof result === 'string') return result;
			const status = result.closedBy !== null
				? [result.closedBy === 'user' ? '已被用户关闭' : `已被成员 ${result.closedBy} 关闭`]
				: [
					result.running ? '运行中' : `已退出，退出码 ${result.exitCode}`,
					...result.noEnter ? [NO_ENTER_TEXT] : [],
					...result.ended ? [result.ended] : [],
					...result.waitingTask ? [`后台任务 ${result.waitingTask} 结束时自动推送结果`] : [],
					...result.userControlling ? ['用户正在操作，交还时会通知你'] : result.askedUser ? ['已请用户接管，交还时会通知你'] : [],
					...result.interrupted && result.running ? ['等待已中止，命令可能仍在运行'] : [],
				];
			return `[终端 ${result.terminalId}，${status.join('，')}]\n${result.output || '（无输出）'}`;
		},
	};
}

/**
 * 输入的内容没有以回车结尾时，结果第一行的状态里写的话。只说事实，不说「命令没有执行」：有的程序按单个键操作，不用回车。
 * 模型往终端里输入命令时会漏掉末尾的换行，命令只是打在提示符后面；不告诉它，它以为程序已经在运行，接着去等输出。
 */
const NO_ENTER_TEXT = '本次输入未以回车结尾';

/** 输入的内容没有以回车结尾。含控制字符的不算：那是在按键（Ctrl+C、方向键），本来就不带回车。 */
function endsWithoutEnter(input: string): boolean {
	return !/[\r\n]$/.test(input) && !/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(input);
}

/** 时长写成「500 毫秒」「45 秒」「30 分钟」「29 分 30 秒」。 */
function durationText(ms: number): string {
	if (ms < 1000) return `${ms} 毫秒`;
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds} 秒`;
	const minutes = Math.floor(seconds / 60);
	return seconds % 60 === 0 ? `${minutes} 分钟` : `${minutes} 分 ${seconds % 60} 秒`;
}

function optionalString(args: Record<string, unknown>, name: string): string | undefined {
	const value = args[name];
	if (value === undefined) return undefined;
	if (typeof value !== 'string') throw invalid(`${name} 必须是字符串`);
	return value;
}

function idleOf(args: Record<string, unknown>): number {
	const value = args['idle_ms'] ?? DEFAULT_IDLE_MS;
	if (typeof value === 'number' && Number.isInteger(value) && value >= MIN_IDLE_MS && value <= MAX_IDLE_MS) return value;
	throw invalid(`idle_ms 必须是 ${MIN_IDLE_MS} 到 ${MAX_IDLE_MS} 之间的整数；要等更久用 background`);
}

/** 输入里的命令：回车都换成换行，去掉其他控制字符。 */
function commandText(input: string): string {
	return input.replace(/\r\n?/g, '\n').replace(/[\x00-\x09\x0B-\x1F\x7F]/g, '');
}
