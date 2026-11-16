/**
 * 量运行时的启动耗时和常用接口的耗时，给性能审查用（标准见 DEVELOPMENT.md「性能测试数据」）。
 * 用一个数据目录启动运行时（一般是 scripts/perfData.ts 造的），量完关掉。不请求模型；不打印访问令牌。
 *
 *   node scripts/perfMeasure.ts --data-dir <数据目录> [--port 4890] [--times 20]
 *
 * 每个接口先请求一次预热，再请求 times 次，报中位数、最慢的和返回的大小。耗时是本机 HTTP 往返，包括 JSON 编码。
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { Agent, get as httpGet } from 'node:http';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { 'data-dir': { type: 'string' }, port: { type: 'string' }, times: { type: 'string' } } });
if (!values['data-dir']) throw new Error('要用 --data-dir 指定数据目录');
const dataDirectory = resolve(values['data-dir']);
const port = Number(values.port ?? 4890);
const times = Number(values.times ?? 20);

// 启动：从开进程到打印「已启动」。
const launched = performance.now();
const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'src', 'main.ts'), '--data-dir', dataDirectory, '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
// 出错退出时也关掉运行时。
process.on('exit', () => child.kill());
let stderr = '';
child.stderr.on('data', chunk => { stderr += chunk; });
await new Promise<void>((done, fail) => {
	let stdout = '';
	child.stdout.on('data', chunk => {
		stdout += chunk;
		if (stdout.includes('已启动')) done();
	});
	child.on('exit', code => fail(new Error(`运行时退出了（${code}）：${stderr}`)));
});
console.log(`启动 ${(performance.now() - launched).toFixed(0)} ms`);

const token = readFileSync(join(dataDirectory, 'access-token'), 'utf8').trim();
// 用 node:http 加长连接：Windows 上 fetch 复用连接时每次要多等一个计时器周期（约 16 毫秒），量不出接口本身的耗时。
const agent = new Agent({ keepAlive: true, maxSockets: 1 });
const request = (path: string) => new Promise<string>((done, fail) => {
	httpGet({ host: '127.0.0.1', port, path, agent, headers: { authorization: `Bearer ${token}` } }, response => {
		let text = '';
		response.setEncoding('utf8');
		response.on('data', chunk => { text += chunk; });
		response.on('end', () => response.statusCode === 200 ? done(text) : fail(new Error(`${path}：${response.statusCode} ${text.slice(0, 200)}`)));
	}).on('error', fail);
});
const get = async <T>(path: string) => JSON.parse(await request(path)) as T;

const rows: string[][] = [];
const measure = async (name: string, path: string) => {
	const first = performance.now();
	const body = await request(path);
	const cold = performance.now() - first;
	const spent: number[] = [];
	for (let index = 0; index < times; index++) {
		const start = performance.now();
		await request(path);
		spent.push(performance.now() - start);
	}
	spent.sort((a, b) => a - b);
	rows.push([name, cold.toFixed(1), spent[Math.floor(spent.length / 2)]!.toFixed(1), spent.at(-1)!.toFixed(1), `${(body.length / 1024).toFixed(0)} KB`]);
};

interface IMember { readonly memberId: string; readonly name: string; readonly type: string }
interface IGroup { readonly groupId: string; readonly name: string }
const { members } = await get<{ members: IMember[] }>('/v1/members');
const { groups } = await get<{ groups: IGroup[] }>('/v1/groups');
const byName = (name: string) => members.find(member => member.name === name)!;
const heavy = byName('成员A');
const typical = byName('成员Z');
const owner = byName('真人A');
const bigGroup = groups.find(group => group.name === '外部群A')!;
const { items: latest } = await get<{ items: { itemId: number }[] }>(`/v1/members/${heavy.memberId}/timeline?before=${Number.MAX_SAFE_INTEGER}&limit=1`);
const bigGroupViewer = (await get<{ group: { members: { memberId: string }[] } }>(`/v1/groups/${bigGroup.groupId}`)).group.members[0]!.memberId;
const { messages: bigNewest } = await get<{ messages: { messageId: number }[] }>(`/v1/members/${bigGroupViewer}/conversations/group/${bigGroup.groupId}/messages?limit=1`);
const { messages: [bigMiddle] } = await get<{ messages: { messageId: number }[] }>(`/v1/members/${bigGroupViewer}/conversations/group/${bigGroup.groupId}/messages?limit=1&before=${Math.floor(bigNewest[0]!.messageId / 3)}`);

await measure('状态 /v1/state', '/v1/state');
await measure('成员列表', '/v1/members');
await measure('成员状态', '/v1/member-states');
await measure('成员页概览', '/v1/member-overview');
await measure('成员页概览：补一个 AI 成员', `/v1/member-overview?memberIds=${heavy.memberId}`);
await measure('成员页概览：补一个真人', `/v1/member-overview?memberIds=${owner.memberId}`);
await measure('群聊列表', '/v1/groups');
await measure('审批', '/v1/approvals');
await measure('时间线最新一页（10 万条的成员）', `/v1/members/${heavy.memberId}/timeline?before=${Number.MAX_SAFE_INTEGER}&limit=100`);
await measure('时间线往前翻一页（中间）', `/v1/members/${heavy.memberId}/timeline?before=${Math.floor(latest[0]!.itemId / 2)}&limit=100`);
await measure('时间线 after 取 500 条', `/v1/members/${heavy.memberId}/timeline?after=${Math.floor(latest[0]!.itemId / 2)}&limit=500`);
await measure('时间线最新一页（一般成员）', `/v1/members/${typical.memberId}/timeline?before=${Number.MAX_SAFE_INTEGER}&limit=100`);
await measure('运行列表 200 条', `/v1/members/${heavy.memberId}/runs?limit=200`);
await measure('上下文用量', `/v1/members/${heavy.memberId}/context`);
await measure('对话列表（真人）', `/v1/members/${owner.memberId}/conversations`);
await measure('对话列表（大群里的成员）', `/v1/members/${bigGroupViewer}/conversations`);
await measure('大群最新一页', `/v1/members/${bigGroupViewer}/conversations/group/${bigGroup.groupId}/messages?limit=50`);
await measure('大群往前翻（中间）', `/v1/members/${bigGroupViewer}/conversations/group/${bigGroup.groupId}/messages?limit=50&before=${Math.floor(bigNewest[0]!.messageId / 2)}`);
await measure('大群跳到某条前后', `/v1/members/${bigGroupViewer}/conversations/group/${bigGroup.groupId}/messages?limit=50&around=${bigMiddle!.messageId}`);
await measure('搜索：常见词（真人）', `/v1/members/${owner.memberId}/messages/search?q=${encodeURIComponent('超时')}&limit=20`);
await measure('搜索：没有的词（真人）', `/v1/members/${owner.memberId}/messages/search?q=${encodeURIComponent('完全不存在的词')}&limit=20`);
await measure('搜索：没有的词（大群里的成员）', `/v1/members/${bigGroupViewer}/messages/search?q=${encodeURIComponent('完全不存在的词')}&limit=20`);

const widths = rows[0]!.map((_, column) => Math.max(...rows.map(row => row[column]!.length)));
console.log(['接口', '第一次', '中位数', '最慢', '大小'].join(' | '));
for (const row of rows) console.log(row.map((cell, column) => column === 0 ? cell.padEnd(widths[column]!) : cell.padStart(widths[column]!)).join(' | '));

agent.destroy();
child.kill();
