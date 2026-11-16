/**
 * 内置的 GitHub 事件来源：轮询通知接口 /notifications，每个讨论串的每次更新推一个事件。
 * 环境变量 GITHUB_TOKEN 是经典令牌（notifications 或 repo 权限）；GITHUB_API_URL 不填时是 https://api.github.com。
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { errorMessage } from '../common/errors.ts';
import { Channel, requiredEnv, SourceState, stateDirectory } from './channel.ts';

const API_VERSION = '2022-11-28';
/** GitHub 没给 X-Poll-Interval 时隔多久查一次。 */
const DEFAULT_INTERVAL_SECONDS = 60;
/** 查询的起点往前多留一段，边界上的更新不会漏；查到重复的按讨论串和更新时间挡掉。 */
const OVERLAP_MS = 5 * 60 * 1000;
/** 一次最多翻几页。 */
const MAX_PAGES = 10;
/** 查失败后多久再试。 */
const RETRY_SECONDS = 60;
/** CI 的通知和工作流运行的时间差多少以内算同一次。 */
const RUN_MATCH_MS = 10 * 60 * 1000;
/** 推过的讨论串记多久：之后再更新时还分得出新评论、编辑和其他更新。 */
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;
/** 通知没指向评论时，通知前多久以内改过的评论算这次通知的起因。 */
const EDIT_MATCH_MS = 2 * 60 * 1000;
/** CI 通知标题里的结果，换成工作流运行的 conclusion。 */
const TITLE_CONCLUSIONS: Readonly<Record<string, string>> = { failed: 'failure', succeeded: 'success', cancelled: 'cancelled', canceled: 'cancelled' };

export interface IGitHubState {
	/** 查询的起点：更早更新的讨论串都处理过了。 */
	readonly since: string;
	/** 讨论串 ID → 推过的最近一次更新的时间。 */
	readonly seen: Readonly<Record<string, string>>;
	/** 讨论串 ID → 推过的最新评论。 */
	readonly comments: Readonly<Record<string, IPushedComment>>;
	/** 上次返回的 Last-Modified，下次带上，没有新通知时 GitHub 返回 304。 */
	readonly lastModified: string | null;
}

/** 推过的评论：接口地址和当时的修改时间。 */
interface IPushedComment {
	readonly url: string;
	readonly updatedAt: string | undefined;
}

interface IThread {
	readonly id: string;
	readonly reason: string;
	readonly updated_at: string;
	readonly subject: { readonly title: string; readonly url: string | null; readonly latest_comment_url: string | null; readonly type: string };
	readonly repository: { readonly full_name: string; readonly html_url: string };
}

interface IWorkflowRun {
	readonly name: string;
	readonly head_branch: string | null;
	readonly conclusion: string | null;
	readonly html_url: string;
	readonly updated_at: string;
	readonly actor?: { readonly login: string };
	readonly triggering_actor?: { readonly login: string };
}

interface IComment {
	readonly url?: string;
	readonly html_url?: string;
	readonly body?: string | null;
	readonly user?: { readonly login: string };
	readonly created_at?: string;
	readonly updated_at?: string;
}

type Meta = Record<string, string | undefined>;

/** GitHub 返回了错误。retryAfter：被限流时多少秒后再试。 */
export class GitHubError extends Error {
	readonly status: number;
	readonly retryAfter: number | undefined;

	constructor(status: number, message: string, retryAfter?: number) {
		super(message);
		this.status = status;
		this.retryAfter = retryAfter;
	}
}

export class GitHubSource {
	private readonly token: string;
	private readonly apiUrl: string;
	private readonly emit: (content: string, meta: Meta) => Promise<void>;
	private readonly state: SourceState<IGitHubState>;
	/** 说过取不到详情的仓库：每个仓库只说一次。 */
	private readonly unreadable = new Set<string>();

	constructor(token: string, apiUrl: string, emit: (content: string, meta: Meta) => Promise<void>, state: SourceState<IGitHubState>) {
		this.token = token;
		this.apiUrl = apiUrl.replace(/\/+$/, '');
		this.emit = emit;
		this.state = state;
	}

	/**
	 * 查一次通知，推出新的更新，返回隔多少秒再查。
	 * 第一次（还没有状态）只记下现有的，不推：只从启动时算起。带上已读的，不改通知的已读状态。
	 */
	async poll(): Promise<number> {
		const previous = this.state.read();
		const state: IGitHubState = previous ?? { since: new Date(Date.now() - OVERLAP_MS).toISOString(), seen: {}, comments: {}, lastModified: null };
		const first = await this.request(`/notifications?all=true&per_page=50&since=${encodeURIComponent(state.since)}`, state.lastModified);
		const interval = Number(first.headers.get('x-poll-interval')) || DEFAULT_INTERVAL_SECONDS;
		if (first.status === 304) return interval;
		const threads: IThread[] = [];
		let response = first;
		for (let page = 1; ; page++) {
			threads.push(...await response.json() as IThread[]);
			const next = nextLink(response.headers.get('link'));
			if (!next || page >= MAX_PAGES) break;
			response = await this.request(next);
		}
		threads.sort((left, right) => left.updated_at.localeCompare(right.updated_at));
		const seen: Record<string, string> = { ...state.seen };
		const comments: Record<string, IPushedComment> = { ...state.comments };
		for (const thread of threads) {
			const pushed = seen[thread.id];
			if (pushed !== undefined && pushed >= thread.updated_at) continue;
			if (previous) {
				const { content, meta, comment } = await this.describe(thread, comments[thread.id], pushed);
				await this.emit(content, meta);
				if (comment) comments[thread.id] = comment;
			}
			seen[thread.id] = thread.updated_at;
		}
		const latest = threads.at(-1);
		const since = latest && Date.parse(latest.updated_at) - OVERLAP_MS > Date.parse(state.since)
			? new Date(Date.parse(latest.updated_at) - OVERLAP_MS).toISOString()
			: state.since;
		const cutoff = Date.now() - KEEP_MS;
		const kept = Object.fromEntries(Object.entries(seen).filter(([, time]) => Date.parse(time) >= cutoff));
		this.state.write({
			since,
			seen: kept,
			comments: Object.fromEntries(Object.entries(comments).filter(([id]) => id in kept)),
			lastModified: first.headers.get('last-modified') ?? state.lastModified,
		});
		return interval;
	}

	/**
	 * 一次更新的正文和 meta：再取具体内容，取不到的不写。
	 * 最新评论和推过的比：换了是新评论，改过是编辑，正文都是评论。都没变时找通知前不久改过的评论；
	 * 也没有时（关闭、合并、加标签等）正文是 issue 或 PR 本身。pushedAt：上次推送时讨论串的更新时间。
	 */
	private async describe(thread: IThread, pushed: IPushedComment | undefined, pushedAt: string | undefined): Promise<{ content: string; meta: Meta; comment?: IPushedComment }> {
		const { subject } = thread;
		const meta: Meta = {
			event_id: `${thread.id}:${thread.updated_at}`,
			repo: thread.repository.full_name,
			type: subject.type,
			reason: thread.reason,
			title: subject.title,
			number: /\/(?:issues|pulls)\/(\d+)$/.exec(subject.url ?? '')?.[1],
			url: thread.repository.html_url,
		};
		let content = subject.title;
		let comment: IPushedComment | undefined;
		try {
			if (subject.type === 'CheckSuite') {
				// 先按标题写上；取得到运行（公开仓库，或者令牌有 repo 权限）时换成运行的详情和链接。
				const parsed = parseRunTitle(subject.title);
				Object.assign(meta, parsed);
				const run = await this.findRun(thread, parsed);
				if (run) {
					Object.assign(meta, { workflow: run.name, branch: run.head_branch ?? undefined, conclusion: run.conclusion ?? undefined, url: run.html_url, author: run.triggering_actor?.login ?? run.actor?.login });
				}
			} else if (subject.url) {
				const detail = await this.get<{
					html_url?: string; body?: string | null; user?: { login: string }; author?: { login: string }; head?: { ref: string };
					state?: string; merged_at?: string | null; comments_url?: string;
				}>(subject.url);
				meta.url = detail.html_url ?? meta.url;
				meta.author = detail.user?.login ?? detail.author?.login;
				meta.state = detail.merged_at ? 'merged' : detail.state;
				if (subject.type === 'PullRequest') meta.branch = detail.head?.ref;
				content = [subject.title, detail.body?.trim()].filter(Boolean).join('\n\n');
				const show = (found: IComment, edited: boolean) => {
					content = found.body?.trim() || content;
					meta.url = found.html_url ?? meta.url;
					meta.author = found.user?.login ?? meta.author;
					if (edited) meta.edited = 'true';
				};
				let shown = false;
				if (subject.latest_comment_url && subject.latest_comment_url !== subject.url) {
					const latest = await this.get<IComment>(subject.latest_comment_url);
					comment = { url: subject.latest_comment_url, updatedAt: latest.updated_at };
					const edited = pushed?.url === comment.url && pushed.updatedAt !== comment.updatedAt;
					shown = pushed?.url !== comment.url || edited;
					if (shown) show(latest, edited);
				}
				// 通知没指向新的或改过的评论（编辑较早的评论时就是这样）：找通知前不久、上次推送以后改过的评论。
				if (!shown && detail.comments_url) {
					const from = Math.max(Date.parse(thread.updated_at) - EDIT_MATCH_MS, pushedAt ? Date.parse(pushedAt) : 0);
					const found = (await this.get<IComment[]>(`${detail.comments_url}?since=${encodeURIComponent(new Date(from).toISOString())}&per_page=100`))
						.filter(item => item.updated_at !== item.created_at && Date.parse(item.updated_at ?? '') > from)
						.sort((left, right) => (right.updated_at ?? '').localeCompare(left.updated_at ?? ''))[0];
					if (found) {
						show(found, true);
						if (pushed && found.url === pushed.url) comment = { url: pushed.url, updatedAt: found.updated_at };
					}
				}
			}
		} catch (error) {
			// 没有权限读这个仓库（私有仓库而令牌没有 repo 权限）：每个仓库只说一次。其他原因（网络等）每次都说。
			const repo = thread.repository.full_name;
			const denied = error instanceof GitHubError && (error.status === 404 || (error.status === 403 && error.retryAfter === undefined));
			if (!denied) {
				console.error(`获取 ${repo}「${subject.title}」的详情失败：${errorMessage(error)}`);
			} else if (!this.unreadable.has(repo)) {
				this.unreadable.add(repo);
				console.error(`无法读取 ${repo} 的详情（${error.message}），正文暂用通知标题；私有仓库须令牌具有 repo 权限`);
			}
		}
		return { content, meta, comment };
	}

	/**
	 * CI 的通知没有链接，在仓库最近完成的工作流运行里找时间相近的：标题里认出了工作流名和分支时要对得上，认不出时用时间最近的。
	 */
	private async findRun(thread: IThread, parsed: Meta): Promise<IWorkflowRun | undefined> {
		const { workflow_runs: runs } = await this.get<{ workflow_runs: IWorkflowRun[] }>(`/repos/${thread.repository.full_name}/actions/runs?status=completed&per_page=30`);
		const time = Date.parse(thread.updated_at);
		const distance = (run: IWorkflowRun) => Math.abs(Date.parse(run.updated_at) - time);
		const near = runs.filter(run => distance(run) <= RUN_MATCH_MS).sort((left, right) => distance(left) - distance(right));
		return parsed['workflow'] === undefined ? near[0] : near.find(run => run.name === parsed['workflow'] && run.head_branch === parsed['branch']);
	}

	private async get<T>(url: string): Promise<T> {
		return await (await this.request(url)).json() as T;
	}

	private async request(url: string, ifModifiedSince: string | null = null): Promise<Response> {
		const response = await fetch(url.startsWith('http') ? url : `${this.apiUrl}${url}`, {
			headers: {
				Authorization: `Bearer ${this.token}`,
				Accept: 'application/vnd.github+json',
				'X-GitHub-Api-Version': API_VERSION,
				'User-Agent': 'reman-runtime',
				...ifModifiedSince && { 'If-Modified-Since': ifModifiedSince },
			},
			signal: AbortSignal.timeout(30_000),
		});
		if (response.ok || response.status === 304) return response;
		const message = await response.json().then(body => (body as { message?: string }).message, () => undefined) ?? response.statusText;
		const retryAfter = Number(response.headers.get('retry-after'));
		const reset = Number(response.headers.get('x-ratelimit-reset'));
		const limited = response.status === 429 || (response.status === 403 && (retryAfter > 0 || response.headers.get('x-ratelimit-remaining') === '0'));
		throw new GitHubError(response.status, message, limited ? retryAfter || Math.max(reset - Date.now() / 1000, RETRY_SECONDS) : undefined);
	}
}

/** CI 通知的标题，如「CI workflow run failed for main branch」：工作流名、分支和结论。认不出的不写。 */
export function parseRunTitle(title: string): Meta {
	const match = /^(.+) workflow run (\S+) for (.+) branch$/.exec(title);
	return match ? { workflow: match[1], branch: match[3], conclusion: TITLE_CONCLUSIONS[match[2]!] } : {};
}

/** Link 头里下一页的地址。 */
function nextLink(link: string | null): string | undefined {
	return link?.split(',').map(part => /<([^>]+)>\s*;\s*rel="next"/.exec(part)?.[1]).find(Boolean);
}

async function main(): Promise<void> {
	const token = requiredEnv('GITHUB_TOKEN');
	const channel = new Channel('github');
	await channel.start();
	const source = new GitHubSource(token, process.env['GITHUB_API_URL']?.trim() || 'https://api.github.com', (content, meta) => channel.emit(content, meta), new SourceState(stateDirectory()));
	for (;;) {
		let seconds: number;
		try {
			seconds = await source.poll();
		} catch (error) {
			// 令牌不对时重试也没用：退出，运行时显示连接失败和原因。
			if (error instanceof GitHubError && error.status === 401) {
				console.error(`GitHub 令牌无效或已过期：${error.message}`);
				process.exit(1);
			}
			if (error instanceof GitHubError && error.status === 403 && error.retryAfter === undefined) {
				console.error(`GitHub 拒绝了通知查询：${error.message}。通知接口仅支持经典令牌，须具有 notifications 或 repo 权限`);
				process.exit(1);
			}
			console.error(`查询 GitHub 通知失败：${errorMessage(error)}`);
			seconds = error instanceof GitHubError && error.retryAfter !== undefined ? error.retryAfter : RETRY_SECONDS;
		}
		await sleep(seconds * 1000);
	}
}

if (import.meta.main) await main();
