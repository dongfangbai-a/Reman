import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { addAi, temporaryDirectory, testRuntime } from '../testing.ts';
import { SourceState } from './channel.ts';
import { GitHubError, GitHubSource, type IGitHubState } from './github.ts';

const TOKEN = 'test-token';

/** 假的 GitHub 接口：通知列表、讨论串的详情和工作流运行，都可以随时改。 */
async function fakeGitHub(t: TestContext) {
	const fake = {
		threads: [] as object[],
		resources: new Map<string, object>(),
		runs: [] as object[],
		lastModified: new Date(0).toUTCString(),
		requests: [] as { url: string; headers: IncomingHttpHeaders }[],
		base: '',
		/** 通知变了：换一个 Last-Modified。 */
		setThreads(threads: object[]) {
			this.threads = threads;
			this.lastModified = new Date(Date.parse(this.lastModified) + 1000).toUTCString();
		},
	};
	const server = createServer((request, response) => {
		const url = request.url ?? '';
		fake.requests.push({ url, headers: request.headers });
		const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
			response.writeHead(status, { 'Content-Type': 'application/json', ...headers });
			response.end(JSON.stringify(body));
		};
		if (request.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { message: 'Bad credentials' });
		const path = url.split('?')[0]!;
		if (path === '/notifications') {
			const headers = { 'Last-Modified': fake.lastModified, 'X-Poll-Interval': '1' };
			if (request.headers['if-modified-since'] === fake.lastModified) {
				response.writeHead(304, headers);
				return response.end();
			}
			return json(200, fake.threads, headers);
		}
		if (path.endsWith('/actions/runs')) return json(200, { workflow_runs: fake.runs });
		const resource = fake.resources.get(path);
		return resource ? json(200, resource) : json(404, { message: 'Not Found' });
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	t.after(() => server.close());
	fake.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return fake;
}

function thread(base: string, id: string, updatedAt: string, subject: object, reason = 'subscribed') {
	return { id, reason, updated_at: updatedAt, subject, repository: { full_name: 'acme/app', html_url: 'https://github.com/acme/app' }, url: `${base}/notifications/threads/${id}` };
}

test('GitHub 来源：第一次只记下现有的通知；之后每次更新推一个事件，取评论、PR、CI 的详情；没变时 GitHub 返回 304', async t => {
	const fake = await fakeGitHub(t);
	const events: { content: string; meta: Record<string, string | undefined> }[] = [];
	const state = new SourceState<IGitHubState>(temporaryDirectory(t));
	const source = new GitHubSource(TOKEN, fake.base, async (content, meta) => void events.push({ content, meta }), state);
	const earlier = new Date(Date.now() - 60_000).toISOString();
	fake.setThreads([thread(fake.base, '1', earlier, { title: '启动前就有的问题', url: `${fake.base}/repos/acme/app/issues/7`, latest_comment_url: null, type: 'Issue' })]);

	assert.equal(await source.poll(), 1);
	assert.equal(events.length, 0);
	assert.equal(await source.poll(), 1);
	assert.equal(fake.requests.at(-1)!.headers['if-modified-since'], fake.lastModified);
	assert.match(fake.requests.at(-1)!.url, /^\/notifications\?all=true&per_page=50&since=/);
	assert.equal(events.length, 0);

	const now = Date.now();
	const time = (offset: number) => new Date(now + offset).toISOString();
	const issue = { html_url: 'https://github.com/acme/app/issues/7', body: '问题描述', user: { login: 'alice' }, state: 'open', comments_url: `${fake.base}/repos/acme/app/issues/7/comments` };
	const pull = {
		html_url: 'https://github.com/acme/app/pull/8', body: '改了登录', user: { login: 'dave' }, head: { ref: 'fix-login' }, state: 'open', merged_at: null,
		comments_url: `${fake.base}/repos/acme/app/issues/8/comments`,
	};
	const issueComment = (id: number, body: string, login: string, createdAt: string, updatedAt = createdAt) => ({
		url: `${fake.base}/repos/acme/app/issues/comments/${id}`, html_url: `https://github.com/acme/app/issues/7#issuecomment-${id}`, body, user: { login }, created_at: createdAt, updated_at: updatedAt,
	});
	/** issue 7 的评论：单条的和列表的接口一起改。 */
	const setComments = (...comments: ReturnType<typeof issueComment>[]) => {
		for (const comment of comments) fake.resources.set(new URL(comment.url).pathname, comment);
		fake.resources.set('/repos/acme/app/issues/7/comments', comments);
	};
	const older = issueComment(98, '先记一下', 'bob', time(100));
	fake.resources.set('/repos/acme/app/issues/7', issue);
	fake.resources.set('/repos/acme/app/pulls/8', pull);
	fake.resources.set('/repos/acme/app/issues/8/comments', []);
	setComments(older, issueComment(99, '@bob 帮忙看一下', 'carol', time(500)));
	fake.runs = [
		{ name: 'Deploy', head_branch: 'main', conclusion: 'success', html_url: 'https://github.com/acme/app/actions/runs/1', updated_at: time(1000), actor: { login: 'erin' } },
		{ name: 'CI', head_branch: 'main', conclusion: 'failure', html_url: 'https://github.com/acme/app/actions/runs/2', updated_at: time(2000), actor: { login: 'erin' } },
	];
	const issueSubject = { title: '启动前就有的问题', url: `${fake.base}/repos/acme/app/issues/7`, latest_comment_url: `${fake.base}/repos/acme/app/issues/comments/99`, type: 'Issue' };
	const pullSubject = { title: '修登录', url: `${fake.base}/repos/acme/app/pulls/8`, latest_comment_url: `${fake.base}/repos/acme/app/pulls/8`, type: 'PullRequest' };
	fake.setThreads([
		thread(fake.base, '3', time(3000), { title: 'CI workflow run failed for main branch', url: null, latest_comment_url: null, type: 'CheckSuite' }, 'ci_activity'),
		thread(fake.base, '1', time(1000), issueSubject, 'mention'),
		thread(fake.base, '2', time(2000), pullSubject, 'review_requested'),
		// 找不到对应的运行（私有仓库而令牌没有 repo 权限时也一样）：工作流名、分支和结论从标题里来。
		thread(fake.base, '4', time(3500), { title: 'Lint workflow run succeeded for dev branch', url: null, latest_comment_url: null, type: 'CheckSuite' }, 'ci_activity'),
	]);
	await source.poll();
	// 复制一份再比：直接比 events 会让 TypeScript 把它收窄成下面这几个对象的类型。
	assert.deepEqual([...events], [
		{
			content: '@bob 帮忙看一下',
			meta: { event_id: `1:${time(1000)}`, repo: 'acme/app', type: 'Issue', reason: 'mention', title: '启动前就有的问题', number: '7', url: 'https://github.com/acme/app/issues/7#issuecomment-99', author: 'carol', state: 'open' },
		},
		{
			content: '修登录\n\n改了登录',
			meta: { event_id: `2:${time(2000)}`, repo: 'acme/app', type: 'PullRequest', reason: 'review_requested', title: '修登录', number: '8', url: 'https://github.com/acme/app/pull/8', author: 'dave', state: 'open', branch: 'fix-login' },
		},
		{
			content: 'CI workflow run failed for main branch',
			meta: {
				event_id: `3:${time(3000)}`, repo: 'acme/app', type: 'CheckSuite', reason: 'ci_activity', title: 'CI workflow run failed for main branch', number: undefined,
				url: 'https://github.com/acme/app/actions/runs/2', workflow: 'CI', branch: 'main', conclusion: 'failure', author: 'erin',
			},
		},
		{
			content: 'Lint workflow run succeeded for dev branch',
			meta: {
				event_id: `4:${time(3500)}`, repo: 'acme/app', type: 'CheckSuite', reason: 'ci_activity', title: 'Lint workflow run succeeded for dev branch', number: undefined,
				url: 'https://github.com/acme/app', workflow: 'Lint', branch: 'dev', conclusion: 'success',
			},
		},
	]);

	// 同样的通知再查到（比如 Last-Modified 变了）不再推；讨论串又有更新时再推。
	fake.setThreads([...fake.threads]);
	await source.poll();
	assert.equal(events.length, 4);

	// 最新评论被编辑：正文是改后的评论，带 edited。
	setComments(older, issueComment(99, '@bob 帮忙看一下，急', 'carol', time(500), time(3600)));
	fake.setThreads([thread(fake.base, '1', time(3700), issueSubject, 'mention')]);
	await source.poll();
	assert.deepEqual(events.slice(4).map(event => [event.content, event.meta['url'], event.meta['edited']]), [['@bob 帮忙看一下，急', 'https://github.com/acme/app/issues/7#issuecomment-99', 'true']]);

	// 关闭、合并时通知不指向评论：正文是 issue 或 PR 本身，不把旧评论再推一遍。
	// 之前没通知的编辑早于这次通知 2 分钟以上，不算这次的起因。
	const pointsToIssue = { ...issueSubject, latest_comment_url: issueSubject.url };
	setComments(older, issueComment(99, '@bob 帮忙看一下，很急', 'carol', time(500), time(4000)));
	fake.resources.set('/repos/acme/app/issues/7', { ...issue, state: 'closed' });
	fake.resources.set('/repos/acme/app/pulls/8', { ...pull, state: 'closed', merged_at: time(4000) });
	const closed = time(4000 + 3 * 60_000);
	fake.setThreads([thread(fake.base, '1', closed, pointsToIssue, 'mention'), thread(fake.base, '2', closed, pullSubject, 'review_requested')]);
	await source.poll();
	assert.deepEqual(events.slice(5).map(event => [event.content, event.meta['url'], event.meta['author'], event.meta['state'], event.meta['edited']]), [
		['启动前就有的问题\n\n问题描述', 'https://github.com/acme/app/issues/7', 'alice', 'closed', undefined],
		['修登录\n\n改了登录', 'https://github.com/acme/app/pull/8', 'dave', 'merged', undefined],
	]);

	// 编辑较早的评论时通知也不指向评论：找通知前不久改过的那条。
	setComments(issueComment(98, '先记一下 @carol', 'bob', time(100), time(4 * 60_000)), issueComment(99, '@bob 帮忙看一下，很急', 'carol', time(500), time(4000)));
	fake.setThreads([thread(fake.base, '1', time(4 * 60_000 + 20_000), pointsToIssue, 'mention')]);
	await source.poll();
	assert.deepEqual(events.slice(7).map(event => [event.content, event.meta['url'], event.meta['author'], event.meta['edited']]), [
		['先记一下 @carol', 'https://github.com/acme/app/issues/7#issuecomment-98', 'bob', 'true'],
	]);
	assert.deepEqual(state.read()!.comments, { 1: { url: `${fake.base}/repos/acme/app/issues/comments/99`, updatedAt: time(3600) } });

	fake.setThreads([thread(fake.base, '1', time(5 * 60_000), { title: '启动前就有的问题', url: null, latest_comment_url: null, type: 'Issue' }, 'comment')]);
	await source.poll();
	assert.deepEqual(events.slice(8).map(event => [event.content, event.meta['event_id']]), [['启动前就有的问题', `1:${time(5 * 60_000)}`]]);

	// 读不了详情（私有仓库而令牌没有 repo 权限）：正文用通知标题，警告每个仓库只说一次。
	const warnings = t.mock.method(console, 'error', () => {});
	const hidden = (id: string, number: number) => thread(fake.base, id, time(6 * 60_000 + number), { title: `私有的问题 ${number}`, url: `${fake.base}/repos/acme/app/issues/${number}`, latest_comment_url: null, type: 'Issue' });
	fake.setThreads([hidden('6', 70), hidden('7', 71)]);
	await source.poll();
	assert.deepEqual(events.slice(9).map(event => event.content), ['私有的问题 70', '私有的问题 71']);
	assert.deepEqual(warnings.mock.calls.map(call => call.arguments[0]), ['无法读取 acme/app 的详情（Not Found），正文暂用通知标题；私有仓库须令牌具有 repo 权限']);

	const wrong = new GitHubSource('wrong', fake.base, async () => {}, state);
	await assert.rejects(wrong.poll(), (error: unknown) => error instanceof GitHubError && error.status === 401 && error.message === 'Bad credentials');
});

test('内置的 GitHub 事件来源：mcp.json 写 builtin，运行时用自己的 node 启动脚本，通知变成外部事件交给路由', async t => {
	const fake = await fakeGitHub(t);
	const directory = temporaryDirectory(t);
	const mcpPath = join(directory, 'mcp.json');
	writeFileSync(mcpPath, JSON.stringify({ mcpServers: { github: { builtin: 'github', env: { GITHUB_TOKEN: TOKEN, GITHUB_API_URL: fake.base } } } }));
	const runtime = testRuntime(t, { mcpPath, sourcesDirectory: join(directory, 'sources') });
	t.after(() => runtime.close());
	const ai = addAi(runtime, '沈安');
	mkdirSync(runtime.external.routes.directory, { recursive: true });
	writeFileSync(join(runtime.external.routes.directory, 'github.js'), `export const sources = ['github'];\nexport default () => ({ to: '${ai.memberId}', wake: false });`);

	const waitFor = async (condition: () => boolean, what: string) => {
		const deadline = Date.now() + 30_000;
		while (!condition()) {
			if (Date.now() > deadline) throw new Error(`一直没有${what}`);
			await new Promise(resolve => setTimeout(resolve, 50));
		}
	};
	await waitFor(() => fake.requests.some(request => request.url.startsWith('/notifications')) && runtime.mcp.snapshot().servers[0]?.status === 'connected', '连上并查通知');
	const info = runtime.mcp.snapshot().servers[0]!;
	assert.deepEqual([info.builtin, info.transport, info.command, info.channel, info.status], ['github', 'stdio', null, true, 'connected']);

	fake.setThreads([thread(fake.base, '5', new Date().toISOString(), { title: '新问题', url: null, latest_comment_url: null, type: 'Issue' }, 'assign')]);
	const events = () => runtime.timeline.all(ai.memberId).filter(item => item.kind === 'external_event');
	await waitFor(() => events().length > 0, '外部事件');
	const event = events()[0]!;
	assert.equal(event.kind === 'external_event' && event.external.text, '新问题');
	assert.equal(event.kind === 'external_event' && event.external.meta['reason'], 'assign');
});
