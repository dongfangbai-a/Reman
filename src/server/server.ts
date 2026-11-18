import { timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';
import { RuntimeError, invalid, notFound } from '../common/errors.ts';
import { MEMBER_BROWSER_HEADER } from '../browsers/browsers.ts';
import type { Broadcast } from '../common/events.ts';
import { mimeType } from '../common/mime.ts';
import { systemTimeZone } from '../common/time.ts';
import { parseDefinition, type IMemberDefinition } from '../members/definition.ts';
import type { IMemberFiles } from '../members/folders.ts';
import type { GitDiffArea } from '../git/git.ts';
import { MAX_FILE_BYTES } from '../messages/attachments.ts';
import { checkWorkingDirectory, type MemberType } from '../members/members.ts';
import { MEMORY_LIMIT } from '../members/memory.ts';
import type { ConversationTarget } from '../messages/messages.ts';
import { pingModel } from '../models/ping.ts';
import { fetchUpstreamModels } from '../models/upstream.ts';
import type { Runtime } from '../runtime.ts';
import type { ApprovalScope } from '../tools/approvals.ts';
import type { ToolPolicy } from '../tools/tools.ts';
import { listDirectories } from './directories.ts';
import { checkLocalPath, checkNotSensitive, contentHeaders, localFileInfo, sendLocalFile, type ILocalFileInfo } from './files.ts';
import type { IMemberState, TimelineEntry } from './protocol.ts';

const MAX_BODY_BYTES = 1024 * 1024;
const HEARTBEAT_MS = 15_000;
/** 正常读的页面要在终端满速输出（一秒约 2 MB）时卡住好几秒才碰得到。 */
const MAX_PENDING_EVENT_BYTES = 8 * 1024 * 1024;

type Body = Record<string, unknown>;
/** 普通接口的 body 是解析好的 JSON；上传文件的接口 body 为空，内容在 raw 里。 */
type Handler = (params: Record<string, string>, body: Body, url: URL, raw: Buffer, request: IncomingMessage) => unknown;

interface IRoute {
	readonly method: string;
	readonly pattern: RegExp;
	readonly keys: readonly string[];
	readonly handler: Handler;
	readonly raw: boolean;
}

/** 网页端用的 Cookie：值就是访问令牌。 */
const SESSION_COOKIE = 'reman_token';
/** 浏览器允许的最长有效期（400 天）。 */
const SESSION_MAX_AGE = 400 * 24 * 60 * 60;
/** 请求的 Host 只接受这些主机名，端口不限（开发服务器转发时带的是它自己的端口）。 */
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Host 头里的主机名，小写，不含端口。 */
function hostName(host: string | undefined): string {
	if (!host) return '';
	const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]!;
	return name.toLowerCase();
}

/** Host 头里的端口；没写时按 Origin 的协议取默认端口。 */
function hostPort(host: string | undefined, protocol: string): string {
	const value = host ?? '';
	const colon = value.startsWith('[') ? value.indexOf(':', value.indexOf(']')) : value.indexOf(':');
	if (colon === -1) return protocol === 'https:' ? '443' : '80';
	return value.slice(colon + 1);
}

/**
 * 写请求的 Origin 和请求的主机是不是同一个：本机是 http://127.0.0.1:<端口>，经隧道进来是 https://<域名>。
 * 主机名和端口都要对上，免得同一个主机名上别的端口（本机的其他服务）发来的请求被当成自己的；默认端口省略的写法也认。
 */
function sameOrigin(origin: string | undefined, host: string | undefined): boolean {
	if (!origin) return false;
	let url: URL;
	try {
		url = new URL(origin);
	} catch {
		return false;
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
	if (hostName(url.host) !== hostName(host)) return false;
	const originPort = url.port || (url.protocol === 'https:' ? '443' : '80');
	return originPort === hostPort(host, url.protocol);
}

/**
 * HTTP 加 SSE：命令和查询走 HTTP（JSON），通知走 GET /v1/events 的 SSE 流。
 * 只监听本机。/v1 下的请求要带 Authorization: Bearer <token>，或者网页端用令牌换来的 Cookie；
 * 其他 GET 请求返回网页端的静态文件，不需要认证。
 */
export class RuntimeServer {
	private readonly runtime: Runtime;
	private readonly token: string;
	/** 网页端构建结果所在目录；undefined 表示不提供网页端。 */
	private readonly webDirectory: string | undefined;
	private readonly routes: IRoute[] = [];
	private readonly server: Server;
	/** 一条事件流积压的、还没发出去的数据超过这么多就断开。 */
	private readonly maxPendingEventBytes: number;

	constructor(runtime: Runtime, token: string, webDirectory?: string, maxPendingEventBytes = MAX_PENDING_EVENT_BYTES) {
		this.runtime = runtime;
		this.token = token;
		this.webDirectory = webDirectory;
		this.maxPendingEventBytes = maxPendingEventBytes;
		this.server = createServer((request, response) => {
			// 手机、隧道那一头随时会把连接掐掉（页面刷新、退到后台、SSE 重连）。这是正常的：
			// 不接住 'error' 的话，Node 会把 ECONNRESET 打成一大段调用栈，看着像出错。
			request.on('error', () => {});
			response.on('error', () => {});
			void this.handle(request, response);
		});
		this.registerRoutes();
	}

	async listen(port = 0): Promise<number> {
		await new Promise<void>((resolve, reject) => {
			this.server.once('error', reject);
			this.server.listen(port, '127.0.0.1', () => resolve());
		});
		const actual = (this.server.address() as AddressInfo).port;
		this.runtime.serverPort = actual;
		return actual;
	}

	async close(): Promise<void> {
		this.server.closeAllConnections();
		await new Promise<void>(resolve => this.server.close(() => resolve()));
	}

	private registerRoutes(): void {
		const { members, memberFolders, memberPage, memories, plans, skills, mcp, customTools, external, reminders, groups, messages, attachments, timeline, events, runs, work, models, modelClient, tools, approvals, tasks, liveOutputs, codeCalls, portableGit, sandbox, tunnel, shells, terminals, browsers, browserBlocklist, resources } = this.runtime;

		this.route('GET', '/v1/state', () => ({ epoch: events.epoch, revision: events.currentRevision, platform: process.platform }));
		// 网页端拿链接里的令牌换 Cookie，之后的请求（包括图片和下载）都靠 Cookie。
		this.route('POST', '/v1/session', (_, _body, _url, _raw, request) => new CookieReply(
			`${SESSION_COOKIE}=${this.token}; Path=/; Max-Age=${SESSION_MAX_AGE}; HttpOnly; SameSite=Strict${request.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''}`,
		));

		this.route('GET', '/v1/models', () => models.list());
		// 整个替换 models.json；供应商没给 apiKey 时沿用原来的。
		this.route('PUT', '/v1/models', (_, body) => {
			const list = models.update(body);
			events.emit({ type: 'models.changed' });
			return list;
		});
		this.route('GET', '/v1/providers/:providerId/upstream-models', async ({ providerId }) => ({
			models: await fetchUpstreamModels(models.provider(providerId!)),
		}));
		// 测试一个已添加的模型能不能用：发一次请求，不算运行。不能用时也正常返回，带上原因。
		this.route('POST', '/v1/models/test', (_, body) => pingModel(
			models, modelClient, { provider: string(body, 'provider'), model: string(body, 'model') }, this.runtime.cacheSalt,
		));

		this.route('GET', '/v1/members', () => ({ members: members.list() }));
		// 真人直接建；AI 成员建成员文件夹，可以同时给出 member.json 的内容、提示词、审批方式和工作目录。
		// 审批方式和工作目录先检查，有误时什么都不建。
		this.route('POST', '/v1/members', (_, body) => {
			const type = string(body, 'type') as MemberType;
			if (type === 'human') return { member: members.createHuman(string(body, 'name')) };
			if (type !== 'ai') throw invalid('成员类型只能是 human 或 ai');
			const policies = Object.entries(stringRecord(body, 'toolPolicies')) as [string, ToolPolicy][];
			for (const [toolName, policy] of policies) tools.checkPolicy(toolName, policy);
			const workingDirectory = checkWorkingDirectory(nullable(body, 'workingDirectory'));
			let member = memberFolders.create(string(body, 'name'), memberFiles(body));
			// 没给的工具设置和技能按现在的默认记下来，以后改默认设置不影响它。
			this.runtime.pinToolSettings([member.memberId]);
			this.runtime.pinSkills([member.memberId]);
			for (const [toolName, policy] of policies) tools.setPolicy(member.memberId, toolName, policy);
			if (workingDirectory) member = members.setWorkingDirectory(member.memberId, workingDirectory);
			return { member: members.get(member.memberId)! };
		});
		this.route('GET', '/v1/members/:memberId', ({ memberId }) => ({ member: members.get(memberId!) ?? throwNotFound(`成员不存在：${memberId}`) }));
		this.route('PUT', '/v1/members/:memberId/model', ({ memberId }, body) => {
			if (!('model' in body) || !('reasoning' in body)) throw invalid('须提供 model 和 reasoning，不指定时填 null');
			return { member: memberFolders.setModel(memberId!, body['model'], body['reasoning']) };
		});
		// 改 AI 成员的文件：definition 整个替换 member.json，prompt 替换 prompt.md；没给的不变。
		this.route('PUT', '/v1/members/:memberId/files', ({ memberId }, body) => ({ member: memberFolders.update(memberId!, memberFiles(body)) }));
		this.route('DELETE', '/v1/members/:memberId', ({ memberId }) => (memberFolders.remove(memberId!), {}));
		this.route('POST', '/v1/members/:memberId/restore', ({ memberId }) => ({ member: this.runtime.restoreMember(memberId!) }));
		this.route('POST', '/v1/members/:memberId/purge', async ({ memberId }) => (await this.runtime.purgeMember(memberId!), {}));
		// 成员的记忆：成员自己用工具维护，用户也可以改；用户改了会刷新上下文开头的快照。
		this.route('GET', '/v1/members/:memberId/memory', ({ memberId }) => (members.requireAi(memberId!), { memory: memories.read(memberId!), limit: MEMORY_LIMIT }));
		this.route('PUT', '/v1/members/:memberId/memory', ({ memberId }, body) => {
			members.requireAi(memberId!);
			memories.write(memberId!, string(body, 'memory'), true);
			return { memory: memories.read(memberId!), limit: MEMORY_LIMIT };
		});
		// 成员的计划：由成员用 update_plan 更新；用户只能清空，成员忘了更新时不让它一直挂着。
		this.route('GET', '/v1/members/:memberId/plan', ({ memberId }) => (members.requireAi(memberId!), plans.get(memberId!)));
		this.route('DELETE', '/v1/members/:memberId/plan', ({ memberId }) => {
			members.requireAi(memberId!);
			plans.clear(memberId!);
			return plans.get(memberId!);
		});
		// 真人的备注；AI 成员的备注在 member.json 的 description 里，用上面的 files 改。
		this.route('PUT', '/v1/members/:memberId/description', ({ memberId }, body) => ({
			member: members.setHumanDescription(memberId!, string(body, 'description')),
		}));
		this.route('PUT', '/v1/members/:memberId/working-directory', ({ memberId }, body) => ({
			member: members.setWorkingDirectory(memberId!, nullable(body, 'workingDirectory') ?? null),
		}));
		// 换头像：请求体是图片内容。
		this.route('PUT', '/v1/members/:memberId/avatar', ({ memberId }, _, __, raw) => ({ member: memberFolders.setAvatar(memberId!, raw) }), true);
		this.route('DELETE', '/v1/members/:memberId/browser', async ({ memberId }) => (members.requireAi(memberId!), await browsers.clear(memberId!), {}));
		this.route('DELETE', '/v1/members/:memberId/avatar', ({ memberId }) => ({ member: memberFolders.setAvatar(memberId!, undefined) }));
		// 头像只在成员文件夹里，已删除的成员没有。
		this.route('GET', '/v1/members/:memberId/avatar', ({ memberId }) => {
			const path = memberFolders.avatarPath(memberId!);
			if (!path) throw notFound('该成员没有头像');
			return new FileReply(path);
		});
		this.route('GET', '/v1/member-folders', () => memberFolders.snapshot());

		// 网页端成员页：每一行的概况、分组、使用者看到哪一条。只给网页端用，不进成员的上下文。
		this.route('GET', '/v1/member-overview', (_, __, url) => {
			const memberIds = url.searchParams.get('memberIds');
			return { members: memberPage.overview(memberIds === null ? undefined : new Set(memberIds.split(','))) };
		});
		this.route('PUT', '/v1/members/:memberId/viewed', ({ memberId }, body) => ({ viewedThroughItemId: memberPage.markViewed(memberId!, number(body, 'itemId')) }));
		this.route('GET', '/v1/member-sections', () => ({ sections: memberPage.sections() }));
		this.route('POST', '/v1/member-sections', (_, body) => ({ section: memberPage.createSection(string(body, 'name')) }));
		this.route('PUT', '/v1/member-sections/:sectionId', ({ sectionId }, body) => ({
			section: memberPage.updateSection(sectionId!, { name: optional(body, 'name', 'string'), memberIds: body['memberIds'] === undefined ? undefined : optionalStrings(body, 'memberIds') }),
		}));
		this.route('DELETE', '/v1/member-sections/:sectionId', ({ sectionId }) => (memberPage.removeSection(sectionId!), {}));
		this.route('PUT', '/v1/member-section-order', (_, body) => ({ sections: memberPage.orderSections(optionalStrings(body, 'sectionIds')) }));
		// 技能列表不含正文，正文用 GET /v1/skills/:name 取。
		const skillList = () => {
			const snapshot = skills.snapshot();
			return { ...snapshot, skills: snapshot.skills.map(({ content: _, ...skill }) => skill) };
		};
		this.route('GET', '/v1/skills', skillList);
		this.route('GET', '/v1/skills/:name', ({ name }) => skills.detail(name!));
		this.route('POST', '/v1/skills', (_, body) => {
			const name = string(body, 'name');
			skills.create(name, string(body, 'description'), string(body, 'body'));
			return skills.detail(name);
		});
		this.route('PUT', '/v1/skills/:name', ({ name }, body) => {
			skills.update(name!, string(body, 'description'), string(body, 'body'));
			return skills.detail(name!);
		});
		this.route('DELETE', '/v1/skills/:name', ({ name }) => (this.runtime.removeSkill(name!), {}));
		// 新成员默认启用哪些技能，已有成员不跟着变。
		this.route('PUT', '/v1/skill-defaults/:name', ({ name }, body) => {
			this.runtime.setSkillDefault(name!, body['enabled']);
			return skillList();
		});
		this.route('GET', '/v1/skill-sources', (_, __, url) => {
			const path = url.searchParams.get('path');
			if (path !== null && !isAbsolute(path)) throw invalid('path 必须是绝对路径');
			return { sources: path === null ? skills.globalSources() : [skills.source(path)] };
		});
		this.route('POST', '/v1/skills/import', (_, body) => {
			const directory = string(body, 'directory');
			if (!isAbsolute(directory)) throw invalid('directory 必须是绝对路径');
			const overwrite = body['overwrite'] ?? false;
			if (typeof overwrite !== 'boolean') throw invalid('overwrite 必须是 true 或 false');
			return skills.detail(skills.import(directory, overwrite));
		});
		// MCP 服务器：改配置文件，然后重新连接改过的服务器。env、headers 只返回名字；修改时值为 null 的沿用原来的值。
		this.route('GET', '/v1/mcp', () => mcp.snapshot());
		this.route('PUT', '/v1/mcp/servers/:name', ({ name }, body) => (mcp.update(name!, body), mcp.snapshot()));
		this.route('DELETE', '/v1/mcp/servers/:name', ({ name }) => (mcp.remove(name!), mcp.snapshot()));
		this.route('POST', '/v1/mcp/servers/:name/reconnect', ({ name }) => (mcp.reconnect(name!), mcp.snapshot()));
		this.route('PUT', '/v1/mcp/servers/:name/disabled', ({ name }, body) => {
			const disabled = body['disabled'];
			if (typeof disabled !== 'boolean') throw invalid('disabled 必须是 true 或 false');
			mcp.setDisabled(name!, disabled);
			return mcp.snapshot();
		});
		// 自定义工具：网页端只填配置、停用、删除自己的，代码由成员写或者用户自己改文件。
		this.route('GET', '/v1/custom-tools', () => customTools.snapshot());
		this.route('PUT', '/v1/custom-tools/:name/config', ({ name }, body) => {
			const values = body['values'];
			if (typeof values !== 'object' || values === null || Array.isArray(values)) throw invalid('values 必须是对象');
			customTools.setConfig(name!, values as Record<string, unknown>);
			return customTools.snapshot();
		});
		this.route('PUT', '/v1/custom-tools/:name/disabled', ({ name }, body) => {
			if (typeof body['disabled'] !== 'boolean') throw invalid('disabled 必须是 true 或 false');
			customTools.setDisabled(name!, body['disabled']);
			return customTools.snapshot();
		});
		this.route('DELETE', '/v1/custom-tools/:name', ({ name }) => (customTools.remove(name!), customTools.snapshot()));
		// 外部事件：来源和路由，事件日志按天分页。路由只由成员（要审批）或用户自己改文件。
		this.route('GET', '/v1/external', () => external.overview(mcp.snapshot().servers));
		this.route('GET', '/v1/external/log', (_, __, url) => {
			const date = url.searchParams.get('date') ?? undefined;
			if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw invalid('date 的格式须为 YYYY-MM-DD');
			const limit = queryNumber(url, 'limit') ?? 100;
			if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw invalid('limit 必须是 1 到 500 的整数');
			return external.log.page({ date, source: url.searchParams.get('source') ?? undefined, before: queryNumber(url, 'before'), limit });
		});
		// 成员的浏览器禁止访问的网址：运行时的网页端总是禁止，用户加的整个替换。
		this.route('GET', '/v1/browser-blocklist', () => browserBlocklist.snapshot());
		this.route('PUT', '/v1/browser-blocklist', (_, body) => (browserBlocklist.set(body['hosts']), browserBlocklist.snapshot()));
		this.route('GET', '/v1/tools', () => ({ tools: tools.list() }));
		// 新成员的工具默认设置，已有成员不跟着变。
		this.route('PUT', '/v1/tool-defaults/:toolName', ({ toolName }, body) => {
			this.runtime.setToolDefault(toolName!, { enabled: body['enabled'], policy: body['policy'] });
			return { tools: tools.list() };
		});
		this.route('DELETE', '/v1/tool-defaults', () => {
			this.runtime.resetToolDefaults();
			return { tools: tools.list() };
		});
		// 浏览运行时所在机器的目录，选择工作目录用。
		this.route('GET', '/v1/directories', (_, __, url) => listDirectories(url.searchParams.get('path') ?? undefined));
		// 网页端预览本机文件。
		this.route('GET', '/v1/files', async (_, __, url) => localFileInfo(this.runtime.protection, url.searchParams.get('path') ?? ''));
		this.route('GET', '/v1/files/content', async (_, __, url) => new LocalFileReply(await localFileInfo(this.runtime.protection, url.searchParams.get('path') ?? ''), url.searchParams.get('download') === '1'));
		// 网页端的 Git 面板，只读（API.md「Git 仓库」）。
		const repositoryPath = (url: URL) => {
			const path = url.searchParams.get('path') ?? '';
			checkLocalPath(path);
			return path;
		};
		this.route('GET', '/v1/git/repository', (_, __, url) => this.runtime.git.repository(repositoryPath(url)));
		this.route('GET', '/v1/git/status', (_, __, url) => this.runtime.git.status(repositoryPath(url)));
		this.route('GET', '/v1/git/log', async (_, __, url) => ({
			commits: await this.runtime.git.log(repositoryPath(url), url.searchParams.get('before') ?? undefined, queryNumber(url, 'limit') ?? 50),
		}));
		this.route('GET', '/v1/git/commits/:hash', ({ hash }, __, url) => this.runtime.git.commit(repositoryPath(url), hash!));
		this.route('GET', '/v1/git/diff', async (_, __, url) => {
			const root = repositoryPath(url);
			const file = url.searchParams.get('file') ?? '';
			const oldPath = url.searchParams.get('oldPath') ?? undefined;
			for (const path of [file, ...oldPath ? [oldPath] : []]) if (path && !isAbsolute(path)) await checkNotSensitive(this.runtime.protection, resolve(root, path));
			return this.runtime.git.diff(root, { file, oldPath, area: url.searchParams.get('area') as GitDiffArea, commit: url.searchParams.get('commit') ?? undefined });
		});
		this.route('GET', '/v1/members/:memberId/tools', ({ memberId }) => ({ tools: (members.requireAi(memberId!), tools.list(memberId!)) }));
		this.route('PUT', '/v1/members/:memberId/tools/:toolName', ({ memberId, toolName }, body) => {
			members.requireAi(memberId!);
			tools.setPolicy(memberId!, toolName!, string(body, 'policy') as ToolPolicy);
			return { tools: tools.list(memberId!) };
		});
		this.route('GET', '/v1/approvals', (_, __, url) => ({
			approvals: approvals.list({ memberId: url.searchParams.get('memberId') ?? undefined, pendingOnly: url.searchParams.get('pending') !== '0' }),
		}));
		this.route('POST', '/v1/approvals/:approvalId/approve', ({ approvalId }, body) => (
			approvals.approve(pathNumber(approvalId!), optional(body, 'scope', 'string') as ApprovalScope | undefined), {}
		));
		this.route('POST', '/v1/approvals/:approvalId/deny', ({ approvalId }, body) => {
			const reason = body['reason'];
			if (reason !== undefined && reason !== null && typeof reason !== 'string') throw invalid('reason 必须是字符串');
			approvals.deny(pathNumber(approvalId!), reason ?? null);
			return {};
		});
		this.route('GET', '/v1/members/:memberId/tasks', ({ memberId }) => ({ tasks: (members.requireIncludingDeleted(memberId!), tasks.list(memberId!)) }));
		this.route('GET', '/v1/members/:memberId/reminders', ({ memberId }) => ({
			reminders: (members.requireIncludingDeleted(memberId!), reminders.list(memberId!)), timeZone: systemTimeZone(),
		}));
		this.route('DELETE', '/v1/reminders/:reminderId', ({ reminderId }) => (reminders.cancel(reminderId!), {}));
		this.route('POST', '/v1/tasks/:taskId/cancel', ({ taskId }) => (tasks.cancel(taskId!), {}));
		this.route('GET', '/v1/runs/:runId/calls/:callId/code-calls', ({ runId, callId }) => ({ codeCalls: codeCalls.list(pathNumber(runId!), callId!) }));
		this.route('GET', '/v1/runs/:runId/calls/:callId/output', ({ runId, callId }) => {
			const live = liveOutputs.read(pathNumber(runId!), callId!);
			if (!live) throw notFound(`不存在执行中的调用：${callId}`);
			return { output: live.output };
		});
		this.route('GET', '/v1/portable-git', () => ({ portableGit: portableGit.state(), shell: shells.current() }));
		this.route('POST', '/v1/portable-git/install', () => {
			void portableGit.install();
			return { portableGit: portableGit.state() };
		});
		this.route('POST', '/v1/portable-git/cancel', () => (portableGit.cancel(), {}));
		this.route('GET', '/v1/sandbox', () => sandbox.status());
		this.route('PUT', '/v1/sandbox', (_, body) => {
			if (!('enabled' in body) && !('network' in body)) throw invalid('须提供 enabled 或 network');
			if ('enabled' in body && typeof body['enabled'] !== 'boolean') throw invalid('enabled 必须是 true 或 false');
			if ('network' in body) sandbox.setNetwork(body['network']);
			if (typeof body['enabled'] === 'boolean') sandbox.setEnabled(body['enabled']);
			return sandbox.status();
		});
		this.route('POST', '/v1/sandbox/install', () => (sandbox.install(), {}));
		this.route('POST', '/v1/sandbox/uninstall', () => (sandbox.uninstall(), {}));
		this.route('GET', '/v1/remote', () => tunnel.status());
		this.route('PUT', '/v1/remote', (_, body) => tunnel.update(body));
		this.route('POST', '/v1/remote/install', () => (tunnel.install(), {}));
		// 带令牌的链接不放在状态里：点了「复制链接」「显示二维码」才要一次。
		this.route('POST', '/v1/remote/link', (_, body) => {
			// 不带 host 是隧道的链接；带了是「公网访问」里配的某个额外域名（Tailscale）的链接。
			const host = optional(body, 'host', 'string')?.trim().toLowerCase();
			if (host) {
				const url = tunnel.linkTo(host);
				if (!url) throw invalid(`「${host}」不在「公网访问」配的域名里`);
				return { url };
			}
			const url = tunnel.link();
			if (!url) throw invalid('要先填域名并打开公网访问');
			return { url };
		});
		this.route('GET', '/v1/terminals', () => ({ terminals: terminals.list() }));
		// 用户在前端建的终端：不填起始目录时用用户目录。
		this.route('POST', '/v1/terminals', (_, body) => {
			const cwd = optional(body, 'cwd', 'string')?.trim() || homedir();
			// 只差最后一级时，网页端请用户确认后带 createDirectory 再来，先建这一级。AI 建终端不走这里，不自动建。
			if (isAbsolute(cwd) && !existsSync(cwd) && existsSync(dirname(cwd)) && statSync(dirname(cwd)).isDirectory()) {
				if (body['createDirectory'] !== true) throw new RuntimeError('directory_missing', `起始目录不存在：${cwd}`);
				mkdirSync(cwd);
			}
			return { terminal: terminals.create(null, cwd) };
		});
		this.route('GET', '/v1/terminals/:terminalId/screen', async ({ terminalId }) => ({ screen: await terminals.screen(terminalId!) }));
		this.route('POST', '/v1/terminals/:terminalId/input', ({ terminalId }, body) => (terminals.input(terminalId!, string(body, 'data'), 'user'), {}));
		this.route('POST', '/v1/terminals/:terminalId/resize', ({ terminalId }, body) => ({
			terminal: terminals.resize(terminalId!, number(body, 'cols'), number(body, 'rows')),
		}));
		this.route('POST', '/v1/terminals/:terminalId/takeover', ({ terminalId }) => ({ terminal: terminals.takeover(terminalId!) }));
		this.route('POST', '/v1/terminals/:terminalId/release', ({ terminalId }) => ({ terminal: terminals.release(terminalId!) }));
		this.route('POST', '/v1/terminals/:terminalId/close', ({ terminalId }) => (terminals.close(terminalId!, 'user'), {}));
		// 终端数量的全局上限：AI 成员合计能创建几个。用户自己建的另有固定上限，不能配。
		this.route('GET', '/v1/terminals/limits', () => ({ limits: terminals.limits }));
		this.route('PUT', '/v1/terminals/limits', (_, body) => ({ limits: terminals.setMaxAiTerminals(body['maxAiTerminals']) }));
		this.route('POST', '/v1/members/:memberId/pause', ({ memberId }) => ({ member: runs.pause(memberId!) }));
		this.route('POST', '/v1/members/:memberId/resume', ({ memberId }) => ({ member: runs.resume(memberId!) }));
		this.route('POST', '/v1/members/:memberId/retry', ({ memberId }) => (runs.retry(memberId!), {}));
		// 全部 AI 成员的状态，前端显示状态圆点用。
		this.route('GET', '/v1/member-states', () => ({
			states: members.list().filter(member => member.type === 'ai' && !member.deleted).map((member): IMemberState => {
				if (member.paused) return { memberId: member.memberId, status: 'paused', error: null, activity: null };
				if (runs.isRunning(member.memberId)) {
					return {
						memberId: member.memberId,
						status: approvals.hasPending(member.memberId) ? 'waiting_approval' : 'running',
						error: null,
						activity: runs.activity(member.memberId) ?? null,
					};
				}
				const stop = runs.stopReason(member.memberId);
				return { memberId: member.memberId, status: stop?.status ?? 'idle', error: stop?.error ?? null, activity: null };
			}),
		}));
		// 一个成员还有没有活没干完。等成员真的停下来的人（基准测试、脚本）只看这一个接口，
		// 不用自己拼「状态 + 后台任务 + 全局 revision 有没有变」。
		this.route('GET', '/v1/members/:memberId/work', ({ memberId }, __, url) => ({
			work: work.snapshot(memberId!, clampQuietMs(queryNumber(url, 'quietMs'))),
		}));
		// 同上，但一直等到真的停下来（没有工作、且静默够久）才返回；到 timeoutMs 返回那一刻的快照，settled 是 false。
		this.route('GET', '/v1/members/:memberId/work/wait', async ({ memberId }, __, url) => ({
			work: await work.wait(memberId!, { quietMs: clampQuietMs(queryNumber(url, 'quietMs')), timeoutMs: clampTimeoutMs(queryNumber(url, 'timeoutMs')) }),
		}));
		this.route('POST', '/v1/members/:memberId/optimize', ({ memberId }) => (runs.optimize(memberId!), {}));
		this.route('GET', '/v1/members/:memberId/context', ({ memberId }) => ({ context: runs.contextUsage(memberId!) }));
		// 模型用量：上游返回的真实 token，可以只看某个成员、某段时间（毫秒时间戳，含头不含尾），按模型或按成员分组。
		this.route('GET', '/v1/usage', (_, __, url) => {
			const memberId = url.searchParams.get('memberId') ?? undefined;
			if (memberId !== undefined) members.require(memberId);
			const groupBy = url.searchParams.get('groupBy') ?? 'model';
			if (groupBy !== 'model' && groupBy !== 'member') throw invalid(`查询参数 groupBy 只能是 model 或 member`);
			return { usage: runs.usage({ memberId, since: queryNumber(url, 'since'), until: queryNumber(url, 'until'), groupBy }) };
		});
		this.route('GET', '/v1/members/:memberId/runs', ({ memberId }, _, url) => ({
			runs: (members.requireIncludingDeleted(memberId!), runs.list(memberId!, queryNumber(url, 'limit'))),
		}));
		// 时间线：after 往后取，before 往前翻页。消息条目带上消息内容。已删除的成员的也能看。
		this.route('GET', '/v1/members/:memberId/timeline', ({ memberId }, _, url) => {
			members.requireIncludingDeleted(memberId!);
			const items = timeline.list(memberId!, { afterItemId: queryNumber(url, 'after'), beforeItemId: queryNumber(url, 'before'), limit: queryNumber(url, 'limit') });
			// 这一页的消息一次取完，不一条一条查。
			const byId = messages.getMany(items.flatMap(item => item.kind === 'message' ? [item.messageId] : []));
			return { items: items.map((item): TimelineEntry => item.kind === 'message' ? { ...item, message: byId.get(item.messageId)! } : item) };
		});
		// 用户直接对成员说话：进时间线并唤醒它，不属于任何对话。
		this.route('POST', '/v1/members/:memberId/timeline', ({ memberId }, body) => ({
			item: (members.requireAi(memberId!), timeline.appendUserInput(memberId!, { text: optional(body, 'text', 'string') ?? '', attachmentIds: optionalStrings(body, 'attachments') })),
		}));
		this.route('GET', '/v1/members/:memberId/timeline/:itemId/attachments/:index', ({ memberId, itemId, index }) => {
			const item = timeline.get(memberId!, pathNumber(itemId!));
			if (item?.kind !== 'user_input') throw notFound(`时间线中不存在该条用户输入：${itemId}`);
			const attachment = item.input.attachments[pathNumber(index!)] ?? throwNotFound(`附件不存在：${index}`);
			return new FileReply(attachment.path, attachment.mimeType);
		});
		this.route('GET', '/v1/members/:memberId/conversations', ({ memberId }) => ({ conversations: messages.conversations(memberId!) }));
		// 默认最新一页；before 往前翻，after 往后翻，around 取这条消息前后各一段。
		this.route('GET', '/v1/members/:memberId/conversations/:kind/:targetId/messages', ({ memberId, kind, targetId }, _, url) => ({
			messages: messages.list(memberId!, target(kind!, targetId!), {
				beforeMessageId: queryNumber(url, 'before'), afterMessageId: queryNumber(url, 'after'), aroundMessageId: queryNumber(url, 'around'), limit: queryNumber(url, 'limit'),
			}),
		}));
		this.route('GET', '/v1/members/:memberId/messages/search', ({ memberId }, _, url) => ({
			messages: (members.require(memberId!), messages.search(memberId!, url.searchParams.get('q') ?? '', { beforeMessageId: queryNumber(url, 'before'), limit: queryNumber(url, 'limit') })),
		}));
		this.route('POST', '/v1/members/:memberId/conversations/:kind/:targetId/read', ({ memberId, kind, targetId }, body) => {
			messages.markRead(memberId!, target(kind!, targetId!), number(body, 'throughMessageId'));
			return {};
		});

		this.route('POST', '/v1/groups', (_, body) => ({
			group: groups.create(string(body, 'ownerMemberId'), string(body, 'name'), optionalStrings(body, 'memberIds')),
		}));
		this.route('GET', '/v1/groups', () => ({ groups: groups.listActive() }));
		this.route('GET', '/v1/groups/:groupId', ({ groupId }) => ({ group: groups.get(groupId!) ?? throwNotFound(`群聊不存在：${groupId}`) }));
		this.route('POST', '/v1/groups/:groupId/members', ({ groupId }, body) => ({
			group: groups.updateMembers(string(body, 'requesterMemberId'), groupId!, optionalStrings(body, 'add'), optionalStrings(body, 'remove')),
		}));
		this.route('POST', '/v1/groups/:groupId/dissolve', ({ groupId }, body) => {
			groups.dissolve(string(body, 'requesterMemberId'), groupId!);
			return {};
		});
		// 关注是成员的设置，使用者直接改，不按当前身份；改了会记进成员的时间线，见 setWatching。
		this.route('PUT', '/v1/groups/:groupId/members/:memberId/watching', ({ groupId, memberId }, body) => ({
			group: groups.setWatching(groupId!, memberId!, boolean(body, 'watching'), 'user'),
		}));

		this.route('POST', '/v1/messages', (_, body) => {
			const rawTarget = body['target'] as Body | undefined;
			if (!rawTarget || typeof rawTarget !== 'object') throw invalid('缺少 target');
			const mentions = body['mentions'] === 'all' ? 'all' : optionalStrings(body, 'mentions');
			const conversation = target(string(rawTarget, 'kind'), string(rawTarget, rawTarget['kind'] === 'direct' ? 'memberId' : 'groupId'));
			return {
				message: messages.send(string(body, 'senderMemberId'), conversation, optional(body, 'text', 'string') ?? '', mentions, optionalStrings(body, 'attachments')),
			};
		});
		// 上传附件：请求体是文件内容，文件名放在 ?name= 里。返回的附件 ID 用在发消息的 attachments 里。
		this.route('POST', '/v1/attachments', (_, __, url, raw) => {
			const name = url.searchParams.get('name');
			if (!name) throw invalid('缺少查询参数 name');
			return { attachment: attachments.save(name, raw) };
		}, true);
		// 资源文件，比如工具结果里的图片。
		this.route('GET', '/v1/resources', (_, __, url) => {
			const path = resources.path(url.searchParams.get('id') ?? '');
			if (!path || !existsSync(path)) throw notFound('资源不存在');
			return new FileReply(path);
		});
		this.route('GET', '/v1/messages/:messageId', ({ messageId }) => ({ message: messages.get(pathNumber(messageId!)) ?? throwNotFound(`消息不存在：${messageId}`) }));
		this.route('GET', '/v1/messages/:messageId/attachments/:index', ({ messageId, index }) => {
			const message = messages.get(pathNumber(messageId!)) ?? throwNotFound(`消息不存在：${messageId}`);
			const attachment = message.attachments[pathNumber(index!)] ?? throwNotFound(`附件不存在：${index}`);
			return new FileReply(attachment.path, attachment.mimeType);
		});
	}

	private route(method: string, path: string, handler: Handler, raw = false): void {
		const keys: string[] = [];
		const pattern = new RegExp('^' + path.replace(/:(\w+)/g, (_, key: string) => {
			keys.push(key);
			return '([^/]+)';
		}) + '$');
		this.routes.push({ method, pattern, keys, handler, raw });
	}

	private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		try {
			// 成员的浏览器不能用网页端和接口，经过开发服务器转发的也一样。
			if (request.headers[MEMBER_BROWSER_HEADER] !== undefined) {
				return send(response, 403, { error: { code: 'forbidden', message: '成员的浏览器不能访问运行时' } });
			}
			// 只认本机的主机名和「公网访问」里配的域名（隧道、Tailscale 之类）：用别的域名解析到本机来访问的，不接受。
			const host = hostName(request.headers.host);
			if (!LOCAL_HOSTS.has(host) && !this.runtime.tunnel.allowsHost(host)) {
				return send(response, 403, { error: { code: 'forbidden', message: '只能通过 127.0.0.1、localhost 或「公网访问」里配的域名访问运行时' } });
			}
			const url = new URL(request.url ?? '/', 'http://127.0.0.1');
			if (request.method === 'GET' && url.pathname !== '/v1' && !url.pathname.startsWith('/v1/')) {
				return this.serveWeb(response, url.pathname);
			}
			const auth = this.authorize(request);
			if (auth === 'none') {
				return send(response, 401, { error: { code: 'unauthorized', message: '访问令牌无效' } });
			}
			// 经隧道进来时 Origin 是 https://<域名>，也认；Host 已经在上面校验过了。
			if (auth === 'cookie' && request.method !== 'GET' && !sameOrigin(request.headers.origin, request.headers.host)) {
				return send(response, 403, { error: { code: 'forbidden', message: '不接受来自其他网页的请求' } });
			}
			if (request.method === 'GET' && url.pathname === '/v1/events') {
				return this.streamEvents(request, response, url);
			}
			for (const route of this.routes) {
				const match = route.method === request.method ? route.pattern.exec(url.pathname) : null;
				if (!match) continue;
				const params: Record<string, string> = {};
				route.keys.forEach((key, index) => params[key] = decodeURIComponent(match[index + 1]!));
				const raw = route.raw ? await readBody(request, MAX_FILE_BYTES) : Buffer.alloc(0);
				const body = request.method === 'GET' || route.raw ? {} : await readJson(request);
				const result = await route.handler(params, body, url, raw, request);
				if (result instanceof FileReply) return sendFile(response, result);
				if (result instanceof LocalFileReply) return sendLocalFile(request, response, result.info, result.download);
				if (result instanceof CookieReply) response.setHeader('Set-Cookie', result.cookie);
				return send(response, 200, result instanceof CookieReply ? {} : result);
			}
			send(response, 404, { error: { code: 'not_found', message: `不存在该接口：${request.method} ${url.pathname}` } });
		} catch (error) {
			// 客户端提前断开（手机退到后台、隧道那头重置连接、页面刷新）：这是正常的，不是运行时的错，也不该打一串调用栈。
			if (isAbort(error)) return;
			// 连接已经断了就没法回响应，但真正的错误还是要记下来。
			if (error instanceof RuntimeError) {
				if (!response.destroyed) send(response, error.status, { error: { code: error.code, message: error.message } });
				return;
			}
			console.error(error);
			if (!response.destroyed) send(response, 500, { error: { code: 'internal', message: '运行时内部错误' } });
		}
	}

	/**
	 * SSE 事件流。客户端用 Last-Event-ID 或 ?after=<revision> 说明已经收到哪里，运行时补发之后的事件；
	 * epoch 变了（运行时重启过）或者补不回来时发 resync，客户端应重新拉取状态。
	 * 先认 Last-Event-ID：浏览器自己重连时地址不变，after 还是上次打开时的位置，Last-Event-ID 才是最后收到的。
	 * 补发之后再发成员现在在做的事和流式输出到目前为止的内容（见 EventHub.current）：这两种只推增量，断线期间的靠它补上。
	 */
	private streamEvents(request: IncomingMessage, response: ServerResponse, url: URL): void {
		response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
		// 马上发出响应头：运行时空闲时第一次写出的是 15 秒后的心跳，客户端这么久都不知道已经连上。
		response.flushHeaders();
		const events = this.runtime.events;
		// 不读的连接（页面被冻结、卡死）积压太多就断开，客户端重连后按编号补发或重新拉取。
		const send = (text: string) => {
			if (response.destroyed) return;
			response.write(text);
			if (response.writableLength > this.maxPendingEventBytes) response.destroy();
		};
		const write = (item: Broadcast) => send(
			`${item.revision === undefined ? '' : `id: ${events.epoch}:${item.revision}\n`}event: ${item.event.type}\ndata: ${JSON.stringify(item.event)}\n\n`);
		const resume = parseResume(request.headers['last-event-id']?.toString() || url.searchParams.get('after') || undefined, events.epoch);
		const missed = resume === null ? undefined : resume === undefined ? [] : events.since(resume);
		if (missed === undefined) {
			send(`event: resync\ndata: ${JSON.stringify({ epoch: events.epoch, revision: events.currentRevision })}\n\n`);
		}
		for (const item of missed ?? []) write(item);
		for (const event of events.current()) write({ revision: undefined, event });
		const unsubscribe = events.subscribe(write);
		const heartbeat = setInterval(() => send(': heartbeat\n\n'), HEARTBEAT_MS);
		request.on('close', () => {
			clearInterval(heartbeat);
			unsubscribe();
		});
	}

	/** 用哪种方式通过了认证。 */
	private authorize(request: IncomingMessage): 'bearer' | 'cookie' | 'none' {
		if (request.headers.authorization !== undefined) return sameSecret(request.headers.authorization, `Bearer ${this.token}`) ? 'bearer' : 'none';
		const cookie = (request.headers.cookie ?? '').split(';').map(part => part.trim()).find(part => part.startsWith(`${SESSION_COOKIE}=`));
		return cookie !== undefined && sameSecret(cookie.slice(SESSION_COOKIE.length + 1), this.token) ? 'cookie' : 'none';
	}

	/** 网页端的静态文件；不是文件的路径交给前端路由，返回 index.html。 */
	private serveWeb(response: ServerResponse, pathname: string): void {
		const index = this.webDirectory && join(this.webDirectory, 'index.html');
		if (!this.webDirectory || !index || !existsSync(index)) {
			response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
			response.end('网页端尚未构建。请在运行时目录中执行 npm run web:build 后刷新页面。');
			return;
		}
		let path: string;
		try {
			path = resolve(this.webDirectory, `.${decodeURIComponent(pathname)}`);
		} catch {
			path = index;
		}
		const inside = path.startsWith(resolve(this.webDirectory) + sep);
		const file = inside && existsSync(path) && statSync(path).isFile() ? path : index;
		const contentType = WEB_CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
		// 构建出的 assets 文件名带内容哈希，可以长期缓存；index.html 每次都要重新取。
		const cache = file !== index && file.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache';
		response.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': cache });
		response.end(readFileSync(file));
	}
}

function sameSecret(actual: string, expected: string): boolean {
	const left = Buffer.from(actual);
	const right = Buffer.from(expected);
	return left.length === right.length && timingSafeEqual(left, right);
}

const WEB_CONTENT_TYPES: Record<string, string> = {
	'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
	'.woff2': 'font/woff2', '.wasm': 'application/wasm',
};

/** 路由返回它时，设置 Cookie，回复空对象。 */
class CookieReply {
	readonly cookie: string;

	constructor(cookie: string) {
		this.cookie = cookie;
	}
}

/** 返回 revision；没有提供时 undefined；epoch 对不上时 null（需要 resync）。 */
function parseResume(value: string | undefined, epoch: string): number | null | undefined {
	if (!value) return undefined;
	const [valueEpoch, revision] = value.includes(':') ? value.split(':') : [epoch, value];
	if (valueEpoch !== epoch) return null;
	const parsed = Number(revision);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function target(kind: string, targetId: string): ConversationTarget {
	if (kind === 'direct') return { kind: 'direct', memberId: targetId };
	if (kind === 'group') return { kind: 'group', groupId: targetId };
	throw invalid('对话类型只能是 direct 或 group');
}

/** 路由返回它时，把这个文件原样发回去。给了 content 时发它，path 只用来按扩展名定类型。 */
class FileReply {
	readonly path: string;
	readonly contentType: string | undefined;
	readonly content: Buffer | undefined;

	constructor(path: string, contentType?: string, content?: Buffer) {
		this.path = path;
		this.contentType = contentType;
		this.content = content;
	}
}

/** 路由返回它时，按请求的 Range 发回这个本机文件。 */
class LocalFileReply {
	readonly info: ILocalFileInfo;
	readonly download: boolean;

	constructor(info: ILocalFileInfo, download: boolean) {
		this.info = info;
		this.download = download;
	}
}

/** 附件、资源文件、头像：内容可能是成员写的，和本机文件一样不能当网页执行。 */
function sendFile(response: ServerResponse, file: FileReply): void {
	const content = file.content ?? readFileSync(file.path);
	const mime = file.contentType ?? mimeType(file.path) ?? 'application/octet-stream';
	response.writeHead(200, { ...contentHeaders(mime), 'Cache-Control': 'no-cache' });
	response.end(content);
}

/** 请求里的成员文件：definition 按 member.json 的规则检查。 */
function memberFiles(body: Body): IMemberFiles {
	let definition: IMemberDefinition | undefined;
	if (body['definition'] !== undefined) {
		const parsed = parseDefinition(JSON.stringify(body['definition']));
		if (parsed.issues) throw invalid(`成员配置有误：${parsed.issues.join('；')}`);
		definition = parsed.definition;
	}
	return { definition, prompt: optional(body, 'prompt', 'string') };
}

/** 客户端中途断开时 Node 抛的错：ECONNRESET，或者请求被 abort 时的 `aborted`。 */
function isAbort(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const code = (error as NodeJS.ErrnoException).code;
	return code === 'ECONNRESET' || code === 'ERR_STREAM_PREMATURE_CLOSE' || error.message === 'aborted';
}

function send(response: ServerResponse, status: number, payload: unknown): void {
	response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
	response.end(JSON.stringify(payload));
}

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		size += (chunk as Buffer).length;
		if (size > limit) throw invalid('请求过大');
		chunks.push(chunk as Buffer);
	}
	return Buffer.concat(chunks);
}

async function readJson(request: IncomingMessage): Promise<Body> {
	const bytes = await readBody(request, MAX_BODY_BYTES);
	if (bytes.length === 0) return {};
	try {
		const parsed: unknown = JSON.parse(bytes.toString('utf8'));
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
		return parsed as Body;
	} catch {
		throw invalid('请求内容不是 JSON 对象');
	}
}

function string(body: Body, key: string): string {
	const value = body[key];
	if (typeof value !== 'string') throw invalid(`缺少字符串字段 ${key}`);
	return value;
}

function number(body: Body, key: string): number {
	const value = body[key];
	if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw invalid(`缺少整数字段 ${key}`);
	return value;
}

function boolean(body: Body, key: string): boolean {
	const value = body[key];
	if (typeof value !== 'boolean') throw invalid(`缺少布尔字段 ${key}`);
	return value;
}

function optional(body: Body, key: string, type: 'string'): string | undefined {
	const value = body[key];
	if (value === undefined) return undefined;
	if (typeof value !== type) throw invalid(`${key} 必须是字符串`);
	return value as string;
}

/** 没传返回 undefined（不改），传 null 表示清空。 */
function nullable(body: Body, key: string): string | null | undefined {
	const value = body[key];
	if (value === undefined || value === null) return value;
	if (typeof value !== 'string') throw invalid(`${key} 必须是字符串或 null`);
	return value;
}

function stringRecord(body: Body, key: string): Record<string, string> {
	const value = body[key];
	if (value === undefined || value === null) return {};
	if (typeof value !== 'object' || Array.isArray(value) || !Object.values(value).every(item => typeof item === 'string')) {
		throw invalid(`${key} 必须是值为字符串的对象`);
	}
	return value as Record<string, string>;
}

function optionalStrings(body: Body, key: string): string[] {
	const value = body[key];
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) throw invalid(`${key} 必须是字符串数组`);
	return value;
}

function queryNumber(url: URL, key: string): number | undefined {
	const value = url.searchParams.get(key);
	if (value === null) return undefined;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed)) throw invalid(`查询参数 ${key} 必须是整数`);
	return parsed;
}

/** 静默窗口：0 到 60 秒，别让人写个离谱的值。 */
function clampQuietMs(value: number | undefined): number | undefined {
	return value === undefined ? undefined : Math.min(Math.max(value, 0), 60_000);
}

/** 长轮询最长等多久：1 秒到 4 分钟（比 HTTP 请求的超时短一截，免得连接被掐）。 */
function clampTimeoutMs(value: number | undefined): number | undefined {
	return value === undefined ? undefined : Math.min(Math.max(value, 1_000), 240_000);
}

function pathNumber(value: string): number {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed)) throw notFound(`不存在：${value}`);
	return parsed;
}

function throwNotFound(message: string): never {
	throw notFound(message);
}
