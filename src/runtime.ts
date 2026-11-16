import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserBlocklist } from './browsers/blocklist.ts';
import { CustomTools } from './customTools/customTools.ts';
import { Browsers } from './browsers/browsers.ts';
import { EventHub } from './common/events.ts';
import { Secrets } from './common/secrets.ts';
import { ExternalEvents } from './external/external.ts';
import { Database } from './database/database.ts';
import { Groups } from './groups/groups.ts';
import { McpServers } from './mcp/servers.ts';
import { MemberFolders } from './members/folders.ts';
import { MemberPage } from './members/memberPage.ts';
import { Members, type IMember } from './members/members.ts';
import { Memories } from './members/memory.ts';
import { Work } from './members/work.ts';
import { Attachments } from './messages/attachments.ts';
import { Messages } from './messages/messages.ts';
import { ModelError, OpenAIModelClient, type IModelClient } from './models/client.ts';
import { ModelConfig } from './models/config.ts';
import { ContextBuilder } from './runs/context.ts';
import { ContextSnapshots } from './runs/snapshots.ts';
import { Describer } from './runs/describe.ts';
import { Optimizer } from './runs/optimizer.ts';
import { Plans } from './plans/plans.ts';
import { Resources } from './resources/resources.ts';
import { Sandbox } from './sandbox/sandbox.ts';
import { Runs } from './runs/runs.ts';
import { Reminders } from './reminders/reminders.ts';
import { Skills } from './skills/skills.ts';
import { Terminals } from './terminals/terminals.ts';
import { createFileTools } from './tools/files/fileTools.ts';
import { createBrowserTool } from './tools/browser/browser.ts';
import { Approvals } from './tools/approvals.ts';
import { CodeCalls } from './tools/codeCalls.ts';
import { CommandParser } from './tools/command/commandParser.ts';
import { Environment } from './runs/environment.ts';
import { BACKGROUND_AFTER_MS, EARLY_BACKGROUND_AFTER_MS, ToolExecutor } from './tools/executor.ts';
import { GitReader } from './git/git.ts';
import { PortableGit } from './shells/portableGit.ts';
import { Tunnel } from './tunnel/tunnel.ts';
import { createManageGroupTool } from './tools/chat/manageGroup.ts';
import { createManageMemoryTool } from './tools/work/manageMemory.ts';
import { createUpdatePlanTool } from './tools/work/updatePlan.ts';
import { createManageRemindersTool } from './tools/work/manageReminders.ts';
import { createManageBackgroundTasksTool } from './tools/work/manageBackgroundTasks.ts';
import { createMoreTools } from './tools/moreTools.ts';
import { createReadPdfTool } from './tools/files/readPdf.ts';
import { createViewImageTool } from './tools/files/viewImage.ts';
import { createReadSkillTool } from './tools/work/readSkill.ts';
import { createTestEventRouteTool } from './tools/work/testEventRoute.ts';
import { createRunToolScriptTool } from './tools/runToolScript.ts';
import { createSearchHistoryTool } from './tools/chat/searchHistory.ts';
import { createSendMessageTool } from './tools/chat/sendMessage.ts';
import { createShellTool } from './tools/command/shell.ts';
import { ShellLocator } from './shells/shells.ts';
import { createTerminalTool, TERMINAL_WAIT_MS } from './tools/command/terminal.ts';
import { LiveOutputs } from './tools/liveOutputs.ts';
import { Tasks } from './tools/tasks.ts';
import { DataProtection } from './tools/protection.ts';
import { Tools, type ITool } from './tools/tools.ts';
import { Workspaces } from './members/workspaces.ts';
import { systemNotice, Timeline } from './timeline/timeline.ts';

/** 随运行时提供的内置技能。 */
const BUILTIN_SKILLS_DIRECTORY = fileURLToPath(new URL('../skills', import.meta.url));
/** 随运行时提供的内置自定义工具。 */
const BUILTIN_CUSTOM_TOOLS_DIRECTORY = fileURLToPath(new URL('../custom-tools', import.meta.url));
/** 审批多久没人处理就自动拒绝。 */
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

export interface IRuntimeOptions {
	/** 数据目录：除了 workspaces 以外，成员改里面的文件、读令牌和密钥都要审批。不给时不保护。 */
	readonly dataDirectory?: string;
	/** 成员目录：每个 AI 成员一个文件夹。 */
	readonly membersDirectory: string;
	/** 技能目录：每个技能一个文件夹，和内置技能同名时用这里的。 */
	readonly skillsDirectory: string;
	/** 工具结果里的图片等资源。 */
	readonly resourcesDirectory: string;
	/** 自定义工具和 MCP 工具过长的结果存成文件的地方，按工具分子目录。 */
	readonly toolOutputsDirectory: string;
	/** 新成员的工具默认设置；不给时只在内存里。 */
	readonly toolDefaultsPath?: string;
	/** 新成员的默认技能；不给时只在内存里。 */
	readonly skillDefaultsPath?: string;
	/** MCP 服务器配置文件；不给时没有 MCP 服务器。 */
	readonly mcpPath?: string;
	/** 自定义工具目录，一个文件夹一项，同名时覆盖内置的。不给时是数据目录下的 custom-tools；也没有数据目录时只有内置的（测试用）。 */
	readonly customToolsDirectory?: string;
	/** 自定义工具的配置；不给时只在内存里。 */
	readonly customToolsConfigPath?: string;
	/** 内置自定义工具的目录；测试用，默认是程序目录里的。 */
	readonly builtinCustomToolsDirectory?: string;
	/** 加密配置里密钥的钥匙；不给时用只在内存里的，测试用。 */
	readonly secrets?: Secrets;
	/** 外部事件的路由，一个 .js 文件一条。 */
	readonly eventRoutesDirectory: string;
	/** 外部事件的日志，按天一个文件。 */
	readonly eventLogsDirectory: string;
	/** 内置事件来源的状态，每个来源一个文件夹。 */
	readonly sourcesDirectory: string;
	readonly models?: ModelConfig;
	readonly modelClient?: IModelClient;
	/** 写进上下文的时间从这里取；测试用，默认 Date.now。 */
	readonly now?: () => number;
	/** 压缩时不能处理的最近的内容，没看过的内容往前按组累计到上下文长度的这个比例；测试用，默认 5%。 */
	readonly recentRatio?: number;
	/** 成员默认工作目录的上级目录，每个成员一个子目录。 */
	readonly workspacesDirectory: string;
	/** 成员浏览器的浏览数据，每个成员一个子目录。 */
	readonly browsersDirectory: string;
	/** 用户加的成员浏览器禁止访问的网址；不给时只在内存里。 */
	readonly browserBlocklistPath?: string;
	/** PortableGit 的安装目录；null 表示不支持。默认用 PortableGit.defaultRoot()。 */
	readonly portableGitDirectory?: string | null;
	/** 沙箱的开关存在这里；不给时只在内存里，默认关。 */
	readonly sandboxSettingsPath?: string;
	/** 公网访问的设置存在这里；不给时只在内存里。 */
	readonly remoteSettingsPath?: string;
	/** cloudflared 下载、放到这里；不给时不能下载，只能用已有的路径。 */
	readonly cloudflaredDirectory?: string;
	/** 运行时的访问令牌，拼手机上的链接用。 */
	readonly accessToken?: string;
	/** 测试用：额外的工具，以及调短的等待时间。 */
	readonly extraTools?: readonly ITool[];
	readonly approvalTimeoutMs?: number;
	readonly backgroundAfterMs?: number;
	readonly earlyBackgroundAfterMs?: number;
	readonly terminalWaitMs?: number;
	readonly cancelWaitMs?: number;
}

/** 把各模块装配在一起。HTTP 服务和测试都从这里拿到同一套模块。 */
export class Runtime {
	readonly events: EventHub;
	readonly db: Database;
	readonly members: Members;
	readonly memberFolders: MemberFolders;
	readonly skills: Skills;
	readonly mcp: McpServers;
	readonly customTools: CustomTools;
	readonly external: ExternalEvents;
	readonly timeline: Timeline;
	readonly groups: Groups;
	readonly messages: Messages;
	readonly attachments: Attachments;
	readonly models: ModelConfig;
	/** 调模型的客户端：成员运行和设置页的「测试」共用。 */
	readonly modelClient: IModelClient;
	readonly tools: Tools;
	readonly approvals: Approvals;
	readonly resources: Resources;
	readonly tasks: Tasks;
	/** 执行中的 shell 调用到目前为止的输出。 */
	readonly liveOutputs: LiveOutputs;
	readonly reminders: Reminders;
	readonly codeCalls: CodeCalls;
	readonly shells: ShellLocator;
	/** 网页端 Git 面板的只读查询。 */
	readonly git: GitReader;
	readonly portableGit: PortableGit;
	readonly sandbox: Sandbox;
	/** 公网访问：cloudflared 的下载和子进程。 */
	readonly tunnel: Tunnel;
	readonly terminals: Terminals;
	readonly browsers: Browsers;
	readonly browserBlocklist: BrowserBlocklist;
	readonly runs: Runs;
	/** 「这个成员还有没有活没干完」：给等成员停下来的人用（基准测试），也方便网页端以后显示。 */
	readonly work: Work;
	readonly memories: Memories;
	/** 成员的计划：成员用 update_plan 更新，网页端只读。 */
	readonly plans: Plans;
	readonly memberPage: MemberPage;
	/** 运行时自己的数据：成员的工具按它判断要不要审批，网页端预览文件时不返回敏感文件。 */
	readonly protection: DataProtection;
	/** HTTP 服务监听的端口，成员的浏览器不能访问；还没监听时是 undefined。 */
	serverPort: number | undefined;

	constructor(databasePath: string, options: IRuntimeOptions) {
		this.events = new EventHub();
		this.db = Database.open(databasePath, this.events);
		const { workspacesDirectory, eventRoutesDirectory, eventLogsDirectory } = options;
		const customToolsDirectory = options.customToolsDirectory ?? (options.dataDirectory === undefined ? undefined : join(options.dataDirectory, 'custom-tools'));
		const builtinCustomToolsDirectory = options.builtinCustomToolsDirectory ?? BUILTIN_CUSTOM_TOOLS_DIRECTORY;
		this.members = new Members(this.db, this.events, workspacesDirectory, () => this.skills.defaults());
		const protection = this.protection = new DataProtection(options.dataDirectory === undefined ? undefined : {
			dataDirectory: options.dataDirectory, workspacesDirectory, membersDirectory: options.membersDirectory, skillsDirectory: options.skillsDirectory,
			eventRoutesDirectory, customToolsDirectory: customToolsDirectory!,
		});
		const resources = this.resources = new Resources(options.resourcesDirectory);
		this.attachments = new Attachments(this.db, resources);
		this.timeline = new Timeline(this.db, this.events, this.attachments, options.now ?? Date.now);
		this.groups = new Groups(this.db, this.events, this.members, this.timeline);
		this.messages = new Messages(this.db, this.events, this.members, this.groups, this.timeline, this.attachments);
		this.memories = new Memories(options.membersDirectory, this.members, this.events);
		this.plans = new Plans(this.db, this.events, this.timeline);
		this.memberPage = new MemberPage(this.db, this.events, this.members, this.messages);
		this.models = options.models ?? new ModelConfig(() => {
			throw new ModelError('config', '没有配置模型', false);
		});
		const describer = new Describer(this.members, this.groups);
		// 技能变了，成员文件夹里「技能不存在」的警告也要跟着更新。
		this.skills = new Skills(
			options.skillsDirectory, BUILTIN_SKILLS_DIRECTORY,
			{
				members_directory: options.membersDirectory, event_routes_directory: eventRoutesDirectory, event_logs_directory: eventLogsDirectory,
				custom_tools_directory: customToolsDirectory ?? '', builtin_custom_tools_directory: builtinCustomToolsDirectory,
			},
			options.skillDefaultsPath, () => this.models.describeAvailable(), () => {
				this.events.emit({ type: 'skills.changed' });
				this.memberFolders.sync();
			},
		);
		this.external = new ExternalEvents(
			eventRoutesDirectory, eventLogsDirectory,
			this.members, this.groups, this.messages, this.timeline, describer, () => this.events.emit({ type: 'external.changed' }),
		);
		// 服务器增减了，成员文件夹里「没有 MCP 服务器」的警告也要跟着更新。启动时成员文件夹还没建好，之后会检查。
		this.mcp = new McpServers(
			options.mcpPath, options.sourcesDirectory, resources, join(options.toolOutputsDirectory, 'mcp'), options.secrets ?? Secrets.temporary(), () => this.events.emit({ type: 'mcp.changed' }), () => this.memberFolders?.sync(), this.external,
		);
		this.mcp.reload();
		// 文件夹或配置变了，成员文件夹里「没有这个自定义工具」的警告也要跟着更新。
		this.customTools = new CustomTools({
			directory: customToolsDirectory, builtinDirectory: builtinCustomToolsDirectory,
			configPath: options.customToolsConfigPath, secrets: options.secrets ?? Secrets.temporary(), models: () => this.models, resources,
			outputsDirectory: join(options.toolOutputsDirectory, 'custom'),
			reservedNames: () => this.tools.builtinNames(), onChange: () => {
				this.events.emit({ type: 'customTools.changed' });
				this.memberFolders?.sync();
			},
		});
		this.approvals = new Approvals(this.db, this.events, options.approvalTimeoutMs ?? APPROVAL_TIMEOUT_MS);
		this.tasks = new Tasks(this.db, this.events, this.timeline, options.cancelWaitMs);
		this.liveOutputs = new LiveOutputs(this.events);
		this.reminders = new Reminders(this.db, this.events, this.timeline);
		this.codeCalls = new CodeCalls(this.db, this.events);
		const workspaces = new Workspaces(this.members);
		this.portableGit = new PortableGit(
			this.events,
			options.portableGitDirectory === undefined ? PortableGit.defaultRoot() : options.portableGitDirectory ?? undefined,
			() => this.shells.refresh(),
		);
		this.shells = new ShellLocator(() => this.portableGit.bashPath());
		this.git = new GitReader(() => this.shells.git());
		this.sandbox = new Sandbox({
			settingsPath: options.sandboxSettingsPath,
			data: options.dataDirectory === undefined ? undefined : { dataDirectory: options.dataDirectory, workspacesDirectory },
			// 运行时自己装的 Git 在用户目录里，沙箱账户要授权才读得到。内置技能在程序自己的目录里，不在数据目录下，也要授权：技能里的脚本在沙箱里执行。
			// 内置的自定义工具同样在程序目录里，成员创建自定义工具时要看它们当例子。
			readDirectories: () => {
				const bash = this.portableGit.bashPath();
				return [...bash && this.shells.current().executable === bash ? [dirname(dirname(bash))] : [], BUILTIN_SKILLS_DIRECTORY, builtinCustomToolsDirectory];
			},
			workingDirectories: () => this.members.list().filter(member => member.type === 'ai' && !member.deleted).map(member => member.workingDirectory ?? member.defaultWorkingDirectory!),
			onChange: () => this.events.emit({ type: 'sandbox.changed' }),
		});
		this.tunnel = new Tunnel({
			settingsPath: options.remoteSettingsPath,
			directory: options.cloudflaredDirectory,
			secrets: options.secrets,
			port: () => this.serverPort ?? 0,
			accessToken: () => options.accessToken ?? '',
			onChange: () => this.events.emit({ type: 'remote.changed' }),
		});
		// 成员换了工作目录，旧目录的沙箱进程没人用了就退出。
		this.events.subscribe(({ event }) => {
			if (event.type === 'member.changed') this.sandbox.prune();
		});
		const commandParser = new CommandParser();
		this.terminals = new Terminals(this.events, this.shells, this.members, this.timeline);
		this.browserBlocklist = new BrowserBlocklist(options.browserBlocklistPath, () => this.serverPort, () => this.events.emit({ type: 'browserBlocklist.changed' }));
		this.browsers = new Browsers(options.browsersDirectory, undefined, this.browserBlocklist);
		const environment = new Environment(workspaces, this.shells, this.terminals);
		// 可设置的工具按这个顺序显示（有审批方式的在前）：常用的在前，内置默认不启用的放在一起。
		const backgroundAfterMs = options.backgroundAfterMs ?? BACKGROUND_AFTER_MS;
		this.tools = new Tools(this.db, this.events, this.members, [
			createSendMessageTool(this.messages, this.attachments, this.members, protection),
			createManageBackgroundTasksTool(this.tasks, this.liveOutputs, (name, args) => this.tools.get(name)?.timeoutMs?.(args), (name, taskId) => this.tools.get(name)?.taskStatus?.(taskId)),
			createManageMemoryTool(this.memories),
			createUpdatePlanTool(this.plans),
			createReadSkillTool(this.members, this.skills),
			createShellTool(this.shells, commandParser, protection, this.sandbox),
			createFileTools(protection),
			createBrowserTool(this.browsers, resources, protection),
			createViewImageTool(resources, protection),
			createReadPdfTool(resources, protection),
			createSearchHistoryTool(this.messages, this.timeline, describer),
			createTerminalTool(this.terminals, this.shells, commandParser, protection, backgroundAfterMs, options.terminalWaitMs ?? TERMINAL_WAIT_MS, (memberId, text) => this.timeline.appendChangeNotice(memberId, systemNotice(text))),
			createManageGroupTool(this.groups, describer),
			createTestEventRouteTool(this.external),
			createManageRemindersTool(this.reminders),
			createRunToolScriptTool(() => ({ tools: this.tools, executor })),
			createMoreTools(() => this.tools),
			...options.extraTools ?? [],
		], {
			defaultsPath: options.toolDefaultsPath,
			groups: () => [...this.customTools.groups(), ...this.mcp.groups()],
			outputsDirectory: options.toolOutputsDirectory,
		});
		const executor = new ToolExecutor(this.tools, this.approvals, this.tasks, this.codeCalls, workspaces, this.liveOutputs, {
			backgroundAfterMs, earlyBackgroundAfterMs: options.earlyBackgroundAfterMs ?? EARLY_BACKGROUND_AFTER_MS,
		});
		const currentModel = (member: IMember) => {
			try {
				const resolved = this.models.resolve(member.model);
				return { provider: resolved.provider.id, model: resolved.entry.model };
			} catch {
				return undefined;
			}
		};
		const snapshots = new ContextSnapshots({
			members: this.members, groups: this.groups, tools: this.tools, skills: this.skills, memories: this.memories, environment, sandbox: this.sandbox, currentModel,
		});
		const context = new ContextBuilder(this.db, this.members, this.messages, this.timeline, describer, this.memories, snapshots, currentModel);
		const optimizer = new Optimizer(this.db, this.timeline, context, snapshots, this.memories, this.messages, this.plans, options.recentRatio);
		this.modelClient = options.modelClient ?? new OpenAIModelClient();
		this.runs = new Runs(
			this.db, this.events, this.members, this.timeline, context, optimizer, executor, snapshots, this.models, this.modelClient, resources,
		);
		this.work = new Work(this.members, this.runs, this.tasks, this.events, options.now ?? Date.now);
		this.memberFolders = new MemberFolders(
			options.membersDirectory, this.db, this.events, this.members, this.groups,
			{ toolNames: () => this.tools.names(), skillNames: () => this.skills.names(), modelProblem: model => this.models.problem(model) }, memberId => {
				// 定时不删，删除期间不触发；浏览数据留着，恢复后接着用。
				void this.runs.stop(memberId);
				void this.tasks.cancelMember(memberId);
				this.browsers.suspend(memberId).catch(error => console.error('关闭成员的浏览器失败：', error));
			},
			() => this.memories.checkExternalChanges(),
		);
		this.memberFolders.sync();
	}

	/** 恢复已删除的 AI 成员：生成成员文件夹、还原群聊；定时继续，删除期间错过的补触发一次；有要处理的内容就开始运行。 */
	restoreMember(memberId: string): IMember {
		const member = this.memberFolders.restore(memberId);
		this.reminders.check();
		this.runs.wake(memberId);
		return member;
	}

	/**
	 * 彻底删除已删除的 AI 成员：等它的运行和后台任务停下，删掉只属于它的数据和浏览数据，对话里的消息保留。
	 * 名字空出来，之后同名的成员文件夹会读成新成员。
	 */
	async purgeMember(memberId: string): Promise<void> {
		this.members.requireDeletedAi(memberId);
		await this.runs.stop(memberId);
		await this.tasks.cancelMember(memberId);
		this.reminders.removeMember(memberId);
		this.members.purge(memberId);
		await this.browsers.clear(memberId);
		this.memberFolders.sync();
	}

	/** 改新成员的工具默认设置。已有成员不跟着变：改之前先把还在用默认值的成员的当前设置记成它们自己的。 */
	setToolDefault(toolName: string, change: { readonly enabled?: unknown; readonly policy?: unknown }): void {
		this.tools.setDefault(toolName, change, () => this.pinToolSettings());
	}

	/** 新成员的工具默认设置全部恢复内置默认，已有成员不跟着变。 */
	resetToolDefaults(): void {
		this.tools.resetDefaults(() => this.pinToolSettings());
	}

	/**
	 * 把成员还在用默认值的工具设置记成它自己的：member.json 没写 tools 时写上现在默认启用的工具，没单独设置过的审批方式记下现在的默认。
	 * 不给成员时是全部 AI 成员，包括已删除、还能恢复的。
	 */
	pinToolSettings(memberIds?: readonly string[]): void {
		const ids = memberIds ?? this.restorableAiIds();
		this.tools.pinPolicies(ids);
		for (const memberId of ids) {
			if (this.members.get(memberId)?.tools === null) this.memberFolders.pin(memberId, { tools: this.tools.defaultEnabledNames() });
		}
	}

	/** 设新成员是否默认启用这个技能。已有成员不跟着变：改之前先把还在用默认技能的成员的当前技能记成它们自己的。 */
	setSkillDefault(name: string, enabled: unknown): void {
		this.skills.setDefault(name, enabled, () => this.pinSkills());
	}

	/** 删除技能目录里的技能。要从新成员的默认技能里去掉它时，先把还在用默认技能的成员的当前技能记成它们自己的。 */
	removeSkill(name: string): void {
		this.skills.remove(name, () => this.pinSkills());
	}

	/** member.json 没写 skills 的成员写上现在的默认技能。不给成员时是全部 AI 成员，包括已删除、还能恢复的。 */
	pinSkills(memberIds?: readonly string[]): void {
		const ids = memberIds ?? this.restorableAiIds();
		for (const memberId of ids) this.memberFolders.pin(memberId, { skills: this.skills.defaults() });
	}

	/** 全部 AI 成员，包括已删除、还能恢复的。 */
	private restorableAiIds(): string[] {
		return this.members.list().filter(member => member.type === 'ai' && !member.purged).map(member => member.memberId);
	}

	/** 断开 MCP 服务器、处理完已收到的外部事件，中止所有运行和后台任务，然后关闭数据库。 */
	async close(): Promise<void> {
		this.work.close();
		this.memberFolders.close();
		this.skills.close();
		this.mcp.close();
		this.customTools.close();
		await this.external.close();
		this.reminders.close();
		await this.runs.shutdown();
		// 后台任务先于终端：等终端的任务要按「运行时退出」中止、下次启动时标为中断；终端先关的话，它会当成正常等完，
		// 结果写着终端还在运行，还把成员唤醒。
		await this.tasks.shutdown();
		await this.terminals.shutdown();
		await this.browsers.shutdown();
		await this.sandbox.shutdown();
		await this.tunnel.shutdown();
		await this.portableGit.shutdown();
		this.db.close();
	}
}
