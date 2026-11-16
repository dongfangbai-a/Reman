import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EventHub } from '../common/events.ts';
import { errorMessage, invalid, notFound, RuntimeError } from '../common/errors.ts';
import { isRecord, readJsonFile } from '../common/json.ts';
import { CUSTOM_POLICIES, CUSTOM_PREFIX, folderNameProblem } from '../customTools/definition.ts';
import type { Database } from '../database/database.ts';
import type { IToolNames } from '../members/folders.ts';
import type { Members } from '../members/members.ts';
import { MCP_PREFIX } from '../mcp/config.ts';
import type { IFunctionTool } from '../models/client.ts';
import { imageResourceId, type IInputImage } from '../resources/resources.ts';
import type { ExecutionClock } from './clock.ts';
import type { ILiveOutput } from './liveOutputs.ts';
import { clipToFile } from './toolOutputs.ts';

/**
 * 所有工具结果的保底上限：超过 3 万字时保留开头和结尾，完整内容存成文件，防止漏了截断的工具一次占满上下文。
 * 它是最后一道，所以最宽：各工具自己的限制都比它小，正常碰不到，不会截两次、各存一份文件。
 */
const OUTPUT_HEAD_CHARS = 25_000;
const OUTPUT_TAIL_CHARS = 5_000;

export interface IToolContext {
	readonly memberId: string;
	/** 成员的工作目录，相对路径都相对于它。 */
	readonly workingDirectory: string;
	/** 运行被中止、或者后台任务被取消时触发。 */
	readonly signal: AbortSignal;
	/**
	 * 这次调用属于哪次运行、哪个调用，itemId 是这个调用在时间线里的条目。模型发起的调用都有；
	 * 脚本里的调用用的是外层 run_tool_script 的。测试里直接调用工具时没有。
	 */
	readonly call?: { readonly runId: number; readonly callId: string; readonly itemId: number };
	/** 在 run_tool_script 的脚本里调用时为 true：这时 call 是外层的 run_tool_script，上下文里看到的是脚本，不一定有这次调用的参数原文。 */
	readonly inScript?: true;
	/** 只计执行时间的时钟，等审批时暂停。可能转后台的工具才有。 */
	readonly clock?: ExecutionClock;
	/** 等用户审批时调用，返回等完时调用的函数：运行用时不算只在等审批的时间。模型发起的调用都有。 */
	readonly waitingApproval?: () => () => void;
	/**
	 * 这次运行里用户选了「本次运行中允许此工具」的工具（按 Tools.approvalKey 记）。一次运行一份，脚本里的调用共用；
	 * 运行结束就不再用，脚本转为后台后还在执行的，用到脚本结束。
	 */
	readonly runAllowed?: Set<string>;
	/** 用户审批这次终端调用时选了「这个终端里都允许」。 */
	readonly trustTerminal?: boolean;
	/** 这次调用执行太久会转为后台任务。可能转后台的工具、又是模型直接发起的调用才有；脚本里的调用、staysForeground 的没有。 */
	readonly mayBackground?: true;
	/**
	 * 现在就把这次调用转为后台任务（如 terminal 的 background 参数）：不必等满转后台的时间，工具执行到一半自己决定。
	 * 调用之后工具的 promise 继续跑，它结束时的结果就是任务的结果；这次调用拿到的是一句说明。转不了后台的调用没有这个。
	 */
	readonly backgroundNow?: () => void;
	/** 让执行中的输出看得到：read 读到目前为止的输出。只有模型直接发起的调用有，脚本里的调用没有。 */
	readonly liveOutput?: (read: () => string) => ILiveOutput;
}

/**
 * 审批方式，由用户设置。ask：每次调用都要用户审批；auto：工具自己判断这次调用要不要审批
 * （只有提供了 needsApproval 的工具能用）；allow：直接执行。成员有没有这个工具由成员文件夹决定。
 */
export type ToolPolicy = 'ask' | 'auto' | 'allow';

/**
 * 一个工具只定义一次：直接调用的函数定义和 run_tool_script 脚本里的函数声明都从这里生成。
 * execute 返回结构化的结果：脚本里调用时原样交给脚本；直接调用时用 format 写成文字和图片交给模型。
 */
export interface ITool<T = unknown> {
	readonly name: string;
	/** 给用户看的短说明，网页端显示在工具名后面，如「执行命令」。内置工具都写。 */
	readonly label?: string;
	readonly description: string;
	readonly parameters: Record<string, unknown>;
	/** 说明随成员设置变化时提供，例如 run_tool_script 要列出这个成员能用的工具。 */
	describe?(memberId: string): string;
	/** 可设置的工具给出默认审批方式：成员文件里可以不给这个工具，用户可以改审批方式。不给的工具总是可用、直接执行。 */
	readonly defaultPolicy?: ToolPolicy;
	/** 可设置的工具里，新成员内置默认不启用的写 false。 */
	readonly enabledByDefault?: false;
	/** 可设置的工具里，只能开关、不用审批的写 false：总是直接执行，不能设审批方式。 */
	readonly approvable?: false;
	/** 属于哪个工具组（内置的如 files，MCP 服务器如 mcp:github）：成员按组开关、按组设审批方式。 */
	readonly group?: string;
	/** 不常用的工具渐进式提供：不直接发给模型，只在 more_tools 的说明里列出名字和用途，模型用 more_tools 查看完整定义。 */
	readonly progressive?: boolean;
	/** 可能耗时很久：超过等待时间就转为后台任务。 */
	readonly background?: boolean;
	/** 转后台的工具：这次调用要早点转后台时返回 true（如 shell 的 background 参数），只等几秒。只管直接调用，脚本里的调用不单独转后台。 */
	backgroundSoon?(args: Record<string, unknown>): boolean;
	/** 转后台的工具：这次调用最多运行多久（毫秒），到时会被结束。转后台时写进返回，查看后台任务时算还剩多久。 */
	timeoutMs?(args: Record<string, unknown>): number;
	/**
	 * 转后台的工具：这次调用不转后台、照普通调用执行时返回 true（如 terminal 等待的时间不超过转后台的时间）。
	 * 紧挨着开始执行之前问一次，中间不让出：返回 false 的调用，execute 一开始就能据此登记，不会被同时发出的另一个调用抢先。
	 */
	staysForeground?(context: IToolContext, args: Record<string, unknown>): boolean;
	/**
	 * 转后台的工具：转为后台任务时交给模型的内容。不提供、返回 undefined 时用通用的写法（后台任务 ID、最多运行多久、最近的输出）。
	 * terminal 转后台的是「等待」，要写终端 ID、到这时的输出和什么时候结束等待。
	 */
	backgroundNotice?(context: IToolContext, args: Record<string, unknown>, taskId: string): string | undefined | Promise<string | undefined>;
	/**
	 * 转后台的工具：后台任务结束时结果怎么交给成员。wake 是进时间线并唤醒它（不提供时都是这样）；
	 * noWake 是进时间线、不唤醒；none 是不进时间线。被取消的任务不问，照取消的规则。
	 */
	taskDelivery?(args: Record<string, unknown>): TaskDelivery;
	/**
	 * 转后台的工具：查看后台任务时，这个任务在做什么、最晚什么时刻结束。不提供、返回 undefined 时按参数和 timeoutMs 写。
	 * terminal 的等待最晚结束的时刻会顺延，到时只是不再等。
	 */
	taskStatus?(taskId: string): { readonly summary: string; readonly returnsAt: number } | undefined;
	/** 提供了 needsApproval 的工具写明 auto 这种方式的名字和规则说明。 */
	readonly autoPolicy?: IAutoPolicy;
	/**
	 * auto 策略下判断这次调用要不要审批：要审批时返回原因（给用户看），不要时返回 undefined。原因要短，一条说一件事，
	 * 不复述调用要做什么（网页端按参数显示），如「不在免审批范围内：node」。
	 */
	needsApproval?(context: IToolContext, args: Record<string, unknown>): string | readonly string[] | undefined | Promise<string | readonly string[] | undefined>;
	/**
	 * 到沙箱外执行命令：审批方式是 allow 时也直接执行（用户明确选了免审批，表示信任），只有受保护的原因仍须审批。
	 */
	alwaysReasons?(context: IToolContext, args: Record<string, unknown>): readonly string[] | Promise<readonly string[]>;
	/**
	 * 受保护的原因，每处一个；没有时返回空数组：改运行时的数据、读令牌和密钥（见 protection.ts）。
	 * 有原因时不管审批方式都要审批，也不算在「这段脚本里都允许」「本次运行中允许此工具」里，每次单独审批。
	 */
	protectedReasons?(context: IToolContext, args: Record<string, unknown>): readonly string[] | Promise<readonly string[]>;
	/** 审批之前检查：这次调用不能做时返回原因，直接报错，不请求审批。例如成员的浏览器禁止打开的网址。 */
	refuseReason?(context: IToolContext, args: Record<string, unknown>): string | undefined | Promise<string | undefined>;
	/** 脚本里调用时返回值的 TypeScript 类型；不写就是 string。图片写成 InputImage。 */
	readonly returns?: string;
	execute(context: IToolContext, args: Record<string, unknown>): T | Promise<T>;
	/** 把 execute 的结果写成直接调用时交给模型的内容。不写时 execute 返回的就是这个内容（string 或 IToolText）。 */
	format?(value: T): string | IToolText;
}

/** 后台任务结束时结果怎么交给成员，见 ITool.taskDelivery。 */
export type TaskDelivery = 'wake' | 'noWake' | 'none';

/** 交给模型的工具结果：文字，以及跟在后面的图片。 */
export interface IToolText {
	readonly text: string;
	readonly images: readonly IInputImage[];
}

export interface IToolCallResult {
	readonly output: string;
	readonly isError: boolean;
	/** 图片的资源 ID。 */
	readonly images?: readonly string[];
	/** 运行停止时这次调用没做完：before 是还没开始执行（排队中、等审批时），during 是执行到一半。 */
	readonly stopped?: 'before' | 'during';
}

/** auto 这种审批方式在这个工具上的名字和规则说明，给用户看。规则写在 needsApproval 里，用户不能改。 */
export interface IAutoPolicy {
	readonly label: string;
	readonly description: string;
}

export interface IToolInfo {
	readonly name: string;
	/** 给用户看的短说明；MCP 服务器是 null。 */
	readonly label: string | null;
	readonly description: string;
	/** false 表示总是可用、直接执行，不能设置。 */
	readonly configurable: boolean;
	/** 这个成员有没有这个工具（由成员文件夹决定）；不给成员时是新成员默认是否启用。 */
	readonly enabled: boolean;
	/** 内置默认是否启用。 */
	readonly builtinEnabled: boolean;
	readonly progressive: boolean;
	/** 这个成员的审批方式；不给成员时是新成员的默认审批方式。 */
	readonly policy: ToolPolicy;
	/** 内置的默认审批方式。 */
	readonly builtinPolicy: ToolPolicy;
	/** 这个工具可以选的审批方式；不能设审批方式时为空。 */
	readonly policies: readonly ToolPolicy[];
	/** 可以选 auto 时，这种方式的名字和规则说明。 */
	readonly autoPolicy: IAutoPolicy | null;
	/** 改运行时的数据等操作不管审批方式都要审批，「不用审批」也不例外。 */
	readonly protectsData: boolean;
	/** 这一项是一个 MCP 服务器的全部工具时，是服务器名；其他是 null。 */
	readonly mcpServer: string | null;
	/** 这一项是一个自定义工具时：文件夹名、内置的还是自己写的（包括覆盖内置的）、停用了没有、未配置的原因；其他是 null。 */
	readonly customTool: ICustomToolState | null;
	/** MCP 服务器还没有工具：没连上过，或者只推外部事件。成员页不列，成员的设置照样保留。 */
	readonly withoutTools: boolean;
	/** 这一项是内置工具组或自定义工具时，里面的工具和短说明，网页端按工具名找短说明用；其他是空数组。 */
	readonly groupTools: readonly { readonly name: string; readonly label: string | null }[];
}

/**
 * 几个内置工具在设置里是一项，如 files（写文件和改文件）：按组开关、按组设审批方式和新成员的默认值。
 * 组里的工具 group 写组名，审批方式和默认值按组里第一个工具算。
 */
export interface IBuiltinToolGroup {
	readonly name: string;
	readonly label: string;
	/** 给用户看的说明。 */
	readonly description: string;
	readonly tools: readonly ITool[];
}

/** 设置里的一项：一个内置工具，或一个内置工具组。 */
interface IEntry {
	readonly name: string;
	readonly label: string | undefined;
	readonly description: string;
	readonly tools: readonly ITool[];
	/** 开关、审批方式和默认值按它算：单个工具是它自己，工具组是组里第一个。 */
	readonly tool: ITool;
	readonly group: boolean;
}

export interface ICustomToolState {
	readonly folder: string;
	readonly origin: 'builtin' | 'own';
	/** 停用和未配置只影响调用的结果（调用时返回错误），成员照常有这些工具，见运行时设计「自定义工具」。 */
	readonly disabled: boolean;
	/** 配置不全、用不了的原因；配置好了是 null。 */
	readonly problem: string | null;
}

export interface IToolsOptions {
	/** 新成员的默认设置存在这个文件里；不给时只在内存里（测试用）。 */
	readonly defaultsPath?: string;
	/** 动态提供的工具组（自定义工具、MCP 服务器），每次用到时取。 */
	readonly groups?: () => readonly IToolGroup[];
	/** 过长的工具结果存在这个目录下，按工具分子目录。 */
	readonly outputsDirectory: string;
}

/** 一组按组开关、按组设审批方式的工具：一个 MCP 服务器的全部工具，或者一个自定义工具。新成员默认不启用。 */
export interface IToolGroup {
	/** 写在成员文件 tools 里的名字，审批方式也记在这个名字下，如 mcp:github、custom:web。 */
	readonly name: string;
	/** 给用户看的短说明；MCP 服务器没有。 */
	readonly label: string | null;
	readonly description: string;
	readonly policies: readonly ToolPolicy[];
	readonly defaultPolicy: ToolPolicy;
	readonly autoPolicy: IAutoPolicy | null;
	readonly tools: readonly ITool[];
	/** MCP 服务器名；自定义工具没有。 */
	readonly mcpServer: string | null;
	readonly customTool: ICustomToolState | null;
}

export const MORE_TOOLS_NAME = 'more_tools';

/** 工具说明的第一句，用在只列名字和用途的地方。 */
export function toolSummary(tool: ITool): string {
	return /^[^\n]*?(?:。|$)/m.exec(tool.description)?.[0].trim() ?? '';
}

/** 解析好的一次调用；解析失败时直接给出要交给模型的错误结果。 */
export type ParsedCall =
	| { readonly ok: true; readonly tool: ITool; readonly args: Record<string, unknown> }
	| { readonly ok: false; readonly result: IToolCallResult };

/** 新成员的默认设置里和内置默认不同的项。 */
interface IToolDefault {
	readonly enabled?: boolean;
	readonly policy?: ToolPolicy;
}

/** 全部工具，以及每个成员对它们的设置。 */
export class Tools {
	private readonly db: Database;
	private readonly events: EventHub;
	private readonly members: Members;
	/** 随运行时提供的工具。 */
	private readonly builtin: ReadonlyMap<string, ITool>;
	/** 内置工具在设置里的各项，按名字。新成员的默认设置只管它们。 */
	private readonly entries: ReadonlyMap<string, IEntry>;
	/** 动态提供的工具组（自定义工具、MCP 服务器），每次用到时取。 */
	private readonly groups: () => readonly IToolGroup[];
	/** 新成员的默认设置存在这个文件里；不给时只在内存里（测试用）。 */
	private readonly defaultsPath: string | undefined;
	private defaults: ReadonlyMap<string, IToolDefault>;
	/** 过长的工具结果存在这个目录下，按工具分子目录。 */
	private readonly outputsDirectory: string;

	constructor(
		db: Database, events: EventHub, members: Members, tools: readonly (ITool | IBuiltinToolGroup)[], options: IToolsOptions,
	) {
		this.db = db;
		this.events = events;
		this.members = members;
		const entries = tools.map((item): IEntry => 'tools' in item
			? { name: item.name, label: item.label, description: item.description, tools: item.tools, tool: item.tools[0]!, group: true }
			: { name: item.name, label: item.label, description: item.description, tools: [item], tool: item, group: false });
		this.entries = new Map(entries.map(entry => [entry.name, entry]));
		this.builtin = new Map(entries.flatMap(entry => entry.tools).map(tool => [tool.name, tool]));
		this.groups = options.groups ?? (() => []);
		this.defaultsPath = options.defaultsPath;
		this.defaults = this.readDefaults();
		this.outputsDirectory = options.outputsDirectory;
	}

	/** 内置工具的名字：自定义工具不能和它们重名。 */
	builtinNames(): ReadonlySet<string> {
		return new Set(this.builtin.keys());
	}

	/** 全部工具：内置的和工具组里的。 */
	private get tools(): ReadonlyMap<string, ITool> {
		const groups = this.groups();
		if (groups.length === 0) return this.builtin;
		const all = new Map(this.builtin);
		for (const group of groups) for (const tool of group.tools) if (!all.has(tool.name)) all.set(tool.name, tool);
		return all;
	}

	/** 成员文件里能写的工具名：可设置的内置工具、内置工具组、MCP 服务器和自定义工具的名字。 */
	names(): IToolNames {
		const entries = [...this.entries.values()];
		const groups = this.groups().map(group => group.name);
		return {
			configurable: new Set([...entries.filter(entry => entry.tool.defaultPolicy !== undefined).map(entry => entry.name), ...groups]),
			all: new Set([...entries.map(entry => entry.name), ...groups]),
		};
	}

	/** 按现在的设置生成的工具定义：这个成员有的、不是渐进式提供的工具；有渐进式工具时加上 more_tools。请求用的是快照，见 runs/snapshots.ts。 */
	definitions(memberId: string): IFunctionTool[] {
		const available = this.available(memberId);
		const hasProgressive = available.some(tool => tool.progressive);
		return available.filter(tool => !tool.progressive && (tool.name !== MORE_TOOLS_NAME || hasProgressive)).map(tool => ({
			type: 'function', name: tool.name, description: tool.describe?.(memberId) ?? tool.description, parameters: tool.parameters, strict: false,
		}));
	}

	/** 这个成员有的工具，只看成员设置。自定义工具停用、未配置时照常给，调用时才返回错误。 */
	available(memberId: string): ITool[] {
		const configured = this.members.get(memberId)?.tools;
		return [...this.tools.values()].filter(tool => this.enabledFor(configured, tool));
	}

	enabled(memberId: string, tool: ITool): boolean {
		return this.enabledFor(this.members.get(memberId)?.tools, tool);
	}

	/** 成员文件的 tools 字段没写时有新成员默认启用的工具，写了就只有列出的；不能设置的工具总是有。 */
	private enabledFor(configured: readonly string[] | null | undefined, tool: ITool): boolean {
		if (tool.defaultPolicy === undefined) return true;
		return configured ? configured.includes(tool.group ?? tool.name) : this.defaultEnabled(tool);
	}

	get(name: string): ITool | undefined {
		return this.tools.get(name);
	}

	/** 工具和这个成员的设置；不给成员时是新成员的默认设置。内置工具组和 MCP 服务器只列一项，组里的工具不单独列出。 */
	list(memberId?: string): IToolInfo[] {
		const tools = [...this.entries.values()].map(({ name, label, description, tools, tool, group }): IToolInfo => ({
			name,
			label: label ?? null,
			description,
			configurable: tool.defaultPolicy !== undefined,
			enabled: memberId === undefined ? this.defaultEnabled(tool) : this.enabled(memberId, tool),
			builtinEnabled: builtinEnabled(tool),
			progressive: tool.progressive === true,
			policy: memberId === undefined ? this.defaultPolicy(tool) : this.policy(memberId, tool),
			builtinPolicy: tool.defaultPolicy ?? 'allow',
			policies: policiesOf(tool),
			autoPolicy: tool.defaultPolicy !== undefined && tool.needsApproval ? tool.autoPolicy ?? null : null,
			protectsData: tool.protectedReasons !== undefined,
			mcpServer: null,
			customTool: null,
			withoutTools: false,
			groupTools: group ? tools.map(item => ({ name: item.name, label: item.label ?? null })) : [],
		}));
		const groups = this.groups().map((group): IToolInfo => ({
			name: group.name,
			label: group.label,
			description: group.description,
			configurable: true,
			enabled: this.groupEnabled(memberId, group.name),
			builtinEnabled: false,
			progressive: group.tools.every(tool => tool.progressive === true),
			policy: (memberId === undefined ? undefined : this.storedPolicy(memberId, group.name)) ?? this.groupDefaultPolicy(group),
			builtinPolicy: group.defaultPolicy,
			policies: group.policies,
			autoPolicy: group.autoPolicy,
			protectsData: false,
			mcpServer: group.mcpServer,
			customTool: group.customTool,
			// MCP 服务器的工具在连上时取到，断开后沿用。
			withoutTools: group.mcpServer !== null && group.tools.length === 0,
			groupTools: group.customTool ? group.tools.map(item => ({ name: item.name, label: item.label ?? null })) : [],
		}));
		return [...tools, ...groups];
	}

	/** 检查能不能给这一项（工具、内置工具组、MCP 服务器或自定义工具）设这个审批方式，不能时报错。 */
	checkPolicy(toolName: string, policy: ToolPolicy): void {
		const group = this.groups().find(item => item.name === toolName);
		if (group) {
			if (!group.policies.includes(policy)) throw invalid(`${toolName} 的审批方式只能是 ${group.policies.join('、')}`);
			return;
		}
		const tool = this.entries.get(toolName)?.tool;
		if (!tool) {
			const owner = this.tools.get(toolName)?.group;
			if (owner) throw invalid(`${toolName} 的审批方式由 ${owner} 统一设置`);
			throw notFound(`不存在工具 ${toolName}`);
		}
		if (tool.defaultPolicy === undefined) throw invalid(`${toolName} 不支持该设置`);
		const policies = policiesOf(tool);
		if (policies.length === 0) throw invalid(`${toolName} 无需审批，不能设置审批方式`);
		if (!policies.includes(policy)) throw invalid(`${toolName} 的审批方式只能是 ${policies.join('、')}`);
	}

	setPolicy(memberId: string, toolName: string, policy: ToolPolicy): void {
		this.checkPolicy(toolName, policy);
		this.db.transaction(() => {
			this.db.run(`
				INSERT INTO tool_policies (member_id, tool_name, policy) VALUES (?, ?, ?)
				ON CONFLICT (member_id, tool_name) DO UPDATE SET policy = excluded.policy
			`, memberId, toolName, policy);
			this.events.emit({ type: 'tools.changed', memberId });
		});
	}

	policy(memberId: string, tool: ITool): ToolPolicy {
		if (policiesOf(tool).length === 0) return 'allow';
		return this.storedPolicy(memberId, tool.group ?? tool.name) ?? this.defaultPolicy(tool);
	}

	/** 用户给这个成员设过的审批方式。 */
	private storedPolicy(memberId: string, name: string): ToolPolicy | undefined {
		return this.db.get<{ policy: ToolPolicy }>('SELECT policy FROM tool_policies WHERE member_id = ? AND tool_name = ?', memberId, name)?.policy;
	}

	/**
	 * 新成员默认是否启用这个工具。内置工具组里的按组；MCP 工具和自定义工具按所在的工具组，内置默认不启用，
	 * 自定义工具可以在默认设置里改，MCP 服务器不能（默认设置里只有 custom: 开头的工具组）。
	 */
	defaultEnabled(tool: ITool): boolean {
		if (this.fromGroup(tool)) return this.defaults.get(tool.group!)?.enabled ?? false;
		return tool.defaultPolicy === undefined || (this.defaults.get(tool.group ?? tool.name)?.enabled ?? builtinEnabled(tool));
	}

	/** 「本次运行中允许此工具」按什么记：内置工具组里的工具在设置里是一项，记工具组的名字（写入文件和修改文件算一起）；其他的记工具名。 */
	approvalKey(tool: ITool): string {
		return tool.group !== undefined && !this.fromGroup(tool) ? tool.group : tool.name;
	}

	/** 新成员默认的审批方式。内置工具组里的按组；MCP 工具和自定义工具按所在的工具组，内置默认是工具组自己的默认值。 */
	defaultPolicy(tool: ITool): ToolPolicy {
		if (policiesOf(tool).length === 0) return 'allow';
		return this.defaults.get(tool.group ?? tool.name)?.policy ?? tool.defaultPolicy!;
	}

	/** 成员有没有打开这个工具组；不给成员，或者成员文件没写 tools 时，是新成员的默认设置。 */
	private groupEnabled(memberId: string | undefined, name: string): boolean {
		const configured = memberId === undefined ? null : this.members.get(memberId)?.tools;
		return configured ? configured.includes(name) : this.defaults.get(name)?.enabled ?? false;
	}

	/** 工具组给新成员的默认审批方式。 */
	private groupDefaultPolicy(group: IToolGroup): ToolPolicy {
		return this.defaults.get(group.name)?.policy ?? group.defaultPolicy;
	}

	/** MCP 工具和自定义工具：属于动态提供的工具组。 */
	private fromGroup(tool: ITool): boolean {
		return tool.group !== undefined && !this.entries.has(tool.group);
	}

	/** 新成员默认启用的可设置工具、内置工具组和自定义工具，写进成员文件用。 */
	defaultEnabledNames(): string[] {
		return [
			...[...this.entries.values()].filter(entry => entry.tool.defaultPolicy !== undefined && this.defaultEnabled(entry.tool)).map(entry => entry.name),
			...this.groups().filter(group => group.customTool !== null && this.groupEnabled(undefined, group.name)).map(group => group.name),
		].sort();
	}

	/** 还在用默认审批方式的内置工具、内置工具组和自定义工具，把当前的默认审批方式记成这些成员自己的。MCP 服务器不在默认设置里，不用记。 */
	pinPolicies(memberIds: readonly string[]): void {
		const custom = this.groups().filter(group => group.customTool !== null);
		this.db.transaction(() => {
			for (const memberId of memberIds) {
				for (const { name, tool } of this.entries.values()) {
					if (policiesOf(tool).length === 0) continue;
					this.db.run('INSERT OR IGNORE INTO tool_policies (member_id, tool_name, policy) VALUES (?, ?, ?)', memberId, name, this.defaultPolicy(tool));
				}
				for (const group of custom) {
					this.db.run('INSERT OR IGNORE INTO tool_policies (member_id, tool_name, policy) VALUES (?, ?, ?)', memberId, group.name, this.groupDefaultPolicy(group));
				}
			}
		});
	}

	/**
	 * 改新成员的默认设置。检查通过后、改之前调用 beforeChange，让已有成员先把当前设置记成自己的。
	 * 和内置默认相同的项不记。
	 */
	setDefault(toolName: string, change: { readonly enabled?: unknown; readonly policy?: unknown }, beforeChange: () => void): void {
		const tool = this.entries.get(toolName)?.tool;
		const group = tool ? undefined : this.groups().find(item => item.name === toolName);
		if (group?.mcpServer) throw invalid(`MCP 服务器 ${group.mcpServer} 不在新成员的默认设置中`);
		if (!tool && !group) throw notFound(`不存在工具 ${toolName}`);
		if (tool?.defaultPolicy === undefined && !group) throw invalid(`${toolName} 不支持该设置`);
		if (change.enabled !== undefined && typeof change.enabled !== 'boolean') throw invalid('enabled 必须是 true 或 false');
		if (change.policy !== undefined) this.checkPolicy(toolName, change.policy as ToolPolicy);
		// 内置默认：内置工具按工具定义，自定义工具不启用、审批方式按 tool.json。
		const builtin = tool ? { enabled: builtinEnabled(tool), policy: tool.defaultPolicy! } : { enabled: false, policy: group!.defaultPolicy };
		const enabled = (change.enabled as boolean | undefined) ?? (tool ? this.defaultEnabled(tool) : this.groupEnabled(undefined, toolName));
		const policy = (change.policy as ToolPolicy | undefined) ?? (tool ? this.defaultPolicy(tool) : this.groupDefaultPolicy(group!));
		beforeChange();
		const next = new Map(this.defaults);
		const entry: IToolDefault = { ...enabled !== builtin.enabled && { enabled }, ...policy !== builtin.policy && { policy } };
		if (Object.keys(entry).length > 0) next.set(toolName, entry);
		else next.delete(toolName);
		this.writeDefaults(next);
	}

	/** 新成员的默认设置全部恢复内置默认。 */
	resetDefaults(beforeChange: () => void): void {
		beforeChange();
		this.writeDefaults(new Map());
	}

	private writeDefaults(defaults: ReadonlyMap<string, IToolDefault>): void {
		if (this.defaultsPath) writeFileSync(this.defaultsPath, `${JSON.stringify(Object.fromEntries(defaults), null, '\t')}\n`);
		this.defaults = defaults;
		this.events.emit({ type: 'toolDefaults.changed' });
	}

	/** 读默认设置文件；没有文件时都是内置默认，写错的项跳过。 */
	private readDefaults(): ReadonlyMap<string, IToolDefault> {
		const defaults = new Map<string, IToolDefault>();
		if (!this.defaultsPath || !existsSync(this.defaultsPath)) return defaults;
		let parsed: unknown;
		try {
			parsed = readJsonFile(this.defaultsPath);
		} catch (error) {
			console.warn(`工具默认设置读取失败，改用内置默认值：${errorMessage(error)}`);
			return defaults;
		}
		if (!isRecord(parsed)) return defaults;
		for (const [name, value] of Object.entries(parsed)) {
			// 自定义工具这时可能还没加载，按名字认；文件夹删了的留着，建回来接着用。
			const tool = this.entries.get(name)?.tool;
			const custom = name.startsWith(CUSTOM_PREFIX) && !folderNameProblem(name.slice(CUSTOM_PREFIX.length));
			if ((!custom && (!tool || tool.defaultPolicy === undefined)) || typeof value !== 'object' || value === null) continue;
			const { enabled, policy } = value as Record<string, unknown>;
			const policies = tool ? policiesOf(tool) : CUSTOM_POLICIES;
			defaults.set(name, {
				...typeof enabled === 'boolean' && { enabled },
				...typeof policy === 'string' && policies.includes(policy as ToolPolicy) && { policy: policy as ToolPolicy },
			});
		}
		return defaults;
	}

	parse(name: string, rawArguments: string): ParsedCall {
		const tool = this.tools.get(name);
		if (!tool) return { ok: false, result: { output: `不存在工具 ${name}`, isError: true } };
		let args: unknown;
		try {
			args = rawArguments.trim() ? JSON.parse(rawArguments) : {};
		} catch {
			return { ok: false, result: { output: '参数不是合法的 JSON', isError: true } };
		}
		if (typeof args !== 'object' || args === null || Array.isArray(args)) return { ok: false, result: { output: '参数必须是 JSON 对象', isError: true } };
		const unknown = unknownArgument(tool, args as Record<string, unknown>);
		if (unknown) return { ok: false, result: { output: unknown, isError: true } };
		return { ok: true, tool, args: args as Record<string, unknown> };
	}

	/** 执行工具。参数不对、业务校验不通过，都作为错误结果交给模型，不让运行失败。 */
	async run(tool: ITool, context: IToolContext, args: Record<string, unknown>): Promise<IToolCallResult> {
		return (await this.runWithValue(tool, context, args)).result;
	}

	/** 执行工具，同时给出脚本里拿到的结构化结果（出错时没有）。 */
	async runWithValue(tool: ITool, context: IToolContext, args: Record<string, unknown>): Promise<{ result: IToolCallResult; value?: unknown }> {
		const unknown = unknownArgument(tool, args);
		if (unknown) return { result: { output: this.clipOutput(tool, unknown), isError: true } };
		let value: unknown;
		try {
			value = await tool.execute(context, args);
		} catch (error) {
			if (error instanceof RuntimeError) return { result: { output: this.clipOutput(tool, error.message), isError: true } };
			throw error;
		}
		const content = tool.format ? tool.format(value) : value;
		if (typeof content === 'string') return { result: { output: this.clipOutput(tool, content), isError: false }, value };
		const { text, images } = content as IToolText;
		const ids = images.map(image => imageResourceId(image)).filter(id => id !== undefined);
		return { result: { output: this.clipOutput(tool, text), isError: false, ...ids.length > 0 && { images: ids } }, value };
	}

	/** 保底上限：完整内容存在 builtin/<工具名>/，自定义工具和 MCP 工具存在它们自己存过长结果的目录。 */
	private clipOutput(tool: ITool, text: string): string {
		const group = tool.group ?? '';
		const directory = group.startsWith(CUSTOM_PREFIX) ? join(this.outputsDirectory, 'custom', group.slice(CUSTOM_PREFIX.length))
			: group.startsWith(MCP_PREFIX) ? join(this.outputsDirectory, 'mcp', group.slice(MCP_PREFIX.length))
			: join(this.outputsDirectory, 'builtin', tool.name);
		return clipToFile(text, OUTPUT_HEAD_CHARS, OUTPUT_TAIL_CHARS, directory, tool.name);
	}

	/** 不经过设置和审批直接执行，测试用。 */
	async call(context: IToolContext, name: string, rawArguments: string): Promise<IToolCallResult> {
		const parsed = this.parse(name, rawArguments);
		return parsed.ok ? this.run(parsed.tool, context, parsed.args) : parsed.result;
	}
}

/** 内置默认是否启用：不能设置的工具总是有。 */
function builtinEnabled(tool: ITool): boolean {
	return tool.enabledByDefault !== false;
}

/**
 * 参数里有没有 schema 没声明的键。
 *
 * 工具只按名字取自己认识的参数，多出来的键会被静默丢掉：把 input 写成 command 时，工具「执行了」却什么也没做，
 * 而且没有任何线索指向参数写错了，看起来像工具坏了。所以直接报错，并把可用的参数名列出来。
 *
 * 没声明 properties 的（自定义工具常见 { type: 'object' }，参数由脚本自己解析）和写了 additionalProperties: true 的
 * 本来就能收任意参数，不拦。
 */
function unknownArgument(tool: ITool, args: Record<string, unknown>): string | undefined {
	const parameters = tool.parameters as { readonly properties?: Record<string, unknown>; readonly additionalProperties?: unknown };
	if (parameters.additionalProperties === true) return undefined;
	const known = Object.keys(parameters.properties ?? {});
	if (known.length === 0) return undefined;
	const unknown = Object.keys(args).filter(key => !known.includes(key));
	if (unknown.length === 0) return undefined;
	return `没有这个参数：${unknown.join('、')}。${tool.name} 的参数是 ${known.join('、')}。`;
}

/** 可以选的审批方式：不能设置或不用审批的工具没有。 */
function policiesOf(tool: ITool): ToolPolicy[] {
	if (tool.defaultPolicy === undefined || tool.approvable === false) return [];
	return tool.needsApproval ? ['ask', 'auto', 'allow'] : ['ask', 'allow'];
}
