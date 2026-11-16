/**
 * 造一份目标规模的数据，给性能审查用（规模见 DEVELOPMENT.md「性能测试数据」）。不请求模型，不启动运行时的调度。
 * 通过运行时自己的接口写（建成员、发消息、追加时间线、压缩时的摘要），数据的形状和真实运行一样；时间用假时钟，分散在最近 90 天里。
 *
 *   node scripts/perfData.ts --data-dir <还不存在或空的目录> [--scale 0.1]
 *
 * scale 按比例缩小消息和运行的数量，先用小的试。造好后用 npm start -- --data-dir <目录> 启动运行时就能看。
 */
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { runtimeDirectories } from '../src/dataDirectory.ts';
import { Runtime } from '../src/runtime.ts';
import { countContent } from '../src/timeline/counts.ts';
import { timeRangeText } from '../src/timeline/clock.ts';
import type { IModelOutputItem, TimelineItem } from '../src/timeline/timeline.ts';

const { values } = parseArgs({ options: { 'data-dir': { type: 'string' }, scale: { type: 'string' } } });
if (!values['data-dir']) throw new Error('要用 --data-dir 指定数据目录');
const dataDirectory = resolve(values['data-dir']);
if (existsSync(dataDirectory) && readdirSync(dataDirectory).length > 0) throw new Error(`${dataDirectory} 不是空的`);
const scale = Number(values.scale ?? 1);

const DAYS = 90;
const AI_COUNT = 50;
const REMAN_COUNT = 5;
/** 外部的群整个转进来：每个群 10 万条，由专门的真人发，两个 AI 成员在里面、不关注。 */
const BIG_GROUPS = 4;
const BIG_GROUP_MESSAGES = 100_000;
/** 普通的群：真人和几个 AI 成员一起讨论。 */
const NORMAL_GROUPS = 26;
const NORMAL_GROUP_MESSAGES = 2000;
/** 每个 AI 成员和第一个真人的私聊。 */
const DIRECT_MESSAGES = 500;
/** 每个成员干活的运行次数，第一个成员是干活最多的（不在外部的群里，时间线约 10 万条）。每次运行若干轮「思考加调用工具」，发一条消息，最后一轮没有实际产出。 */
const RUNS = 200;
const HEAVY_RUNS = 3000;
const ROUNDS_PER_RUN = 10;
/** 压缩：上下文里的内容超过这么多条时，除了最新的一些，都写成一条摘要；摘要多了再合成一条。 */
const VISIBLE_LIMIT = 400;
const KEEP_RECENT = 100;
const SUMMARY_LIMIT = 10;

const started = Date.now();
let clock = started - DAYS * 24 * 60 * 60 * 1000;
// 发消息记的是 Date.now()，时间线记的是 now；都换成假时钟。
const realNow = Date.now;
Date.now = () => clock;

mkdirSync(dataDirectory, { recursive: true });
const directories = runtimeDirectories(dataDirectory);
mkdirSync(directories.eventRoutesDirectory, { recursive: true });
const runtime = new Runtime(join(dataDirectory, 'runtime.sqlite'), {
	dataDirectory, ...directories, portableGitDirectory: null, now: () => clock,
	toolDefaultsPath: join(dataDirectory, 'tool-defaults.json'), skillDefaultsPath: join(dataDirectory, 'skill-defaults.json'),
});
const { db, timeline, messages } = runtime;

const count = (n: number) => Math.max(1, Math.round(n * scale));
let seed = 1;
const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;
const sentence = (n: number) => Array.from({ length: n }, () => pick(WORDS)).join('') + '。';
const WORDS = ['构建', '测试', '失败了', '日志里', '看一下', '这个接口', '返回', '超时', '已经修好', '下一步', '需要确认', '数据库', '页面', '加载很慢', '用户反馈', '提交', '分支', '配置', '重新部署', '没问题'];

/** 成员名、群名不能有数字，用字母编号：A、B…Z、AA… */
const label = (index: number): string => (index >= 26 ? label(Math.floor(index / 26) - 1) : '') + String.fromCharCode(65 + (index % 26));

const log = (text: string) => console.log(`[${((realNow() - started) / 1000).toFixed(1)}s] ${text}`);

// 成员和群
const humans = Array.from({ length: REMAN_COUNT }, (_, index) => runtime.members.createHuman(`真人${label(index)}`));
const ais = Array.from({ length: AI_COUNT }, (_, index) => runtime.memberFolders.create(`成员${label(index)}`, {}));
const owner = humans[0]!;
const bigGroups = Array.from({ length: BIG_GROUPS }, (_, index) => {
	const forwarder = humans[1 + (index % (REMAN_COUNT - 1))]!;
	return { group: runtime.groups.create(forwarder.memberId, `外部群${label(index)}`, [ais[1 + index * 2]!.memberId, ais[2 + index * 2]!.memberId]), sender: forwarder };
});
const normalGroups = Array.from({ length: NORMAL_GROUPS }, (_, index) => {
	const members = Array.from({ length: 4 + (index % 3) }, (__, offset) => ais[(index * 3 + offset) % AI_COUNT]!.memberId);
	const group = runtime.groups.create(owner.memberId, `项目组${label(index)}`, [...new Set(members)]);
	for (const memberId of group.members.map(membership => membership.memberId)) {
		if (ais.some(ai => ai.memberId === memberId) && random() < 0.5) runtime.groups.setWatching(group.groupId, memberId, true, 'user');
	}
	return group;
});
log(`建了 ${humans.length} 个真人、${ais.length} 个 AI 成员、${bigGroups.length + normalGroups.length} 个群聊`);

// 一次运行：建运行和请求的记录，追加思考、工具调用和结果，最后发一条消息。
let callNumber = 0;
const work = (memberId: string, target: { kind: 'direct'; memberId: string } | { kind: 'group'; groupId: string }) => {
	const runId = db.run(`INSERT INTO runs (member_id, kind, status, started_at) VALUES (?, 'response', 'running', ?)`, memberId, clock).lastId;
	// 一次请求：和运行时一样，发出时给看到的收到的内容记上位置，完成后记下输出、标成看过。
	const request = (round: number, outputs: readonly IModelOutputItem[]) => {
		const seenThrough = timeline.latestItemId(memberId);
		const requestId = db.run(
			`INSERT INTO model_requests (run_id, kind, provider, model, seen_through_item_id, status, started_at) VALUES (?, 'response', 'test', 'fake', ?, 'running', ?)`,
			runId, seenThrough, clock,
		).lastId;
		timeline.markRequested(memberId, requestId, seenThrough);
		clock += 2000 + Math.floor(random() * 8000);
		timeline.appendModelOutputs(memberId, requestId, outputs);
		db.run(`UPDATE model_requests SET status = 'completed', input_tokens = ?, cached_tokens = ?, output_tokens = ?, ended_at = ? WHERE request_id = ?`,
			20_000 + round * 3000, 18_000 + round * 3000, 400, clock, requestId);
		timeline.markSeen(memberId, seenThrough);
		return requestId;
	};
	const reasoning = (): IModelOutputItem => ({ type: 'reasoning', id: `rs_${++callNumber}`, summary: [{ type: 'summary_text', text: sentence(30) }], encrypted_content: 'gAAAAB' + 'x'.repeat(800) });
	for (let round = 0; round <= ROUNDS_PER_RUN; round++) {
		const callId = `call_${++callNumber}`;
		const last = round === ROUNDS_PER_RUN;
		const requestId = request(round, [
			reasoning(),
			last
				? { type: 'function_call', call_id: callId, name: 'send_message', arguments: JSON.stringify({ target: target.kind === 'direct' ? target.memberId : target.groupId, text: sentence(40) }) }
				: { type: 'function_call', call_id: callId, name: 'shell', arguments: JSON.stringify({ command: `npm test -- ${pick(WORDS)}` }) },
		]);
		if (last) {
			const sent = messages.send(memberId, target, sentence(40));
			timeline.appendToolResult(memberId, requestId, { callId, name: 'send_message', output: `已发送，消息 ${sent.messageId}`, isError: false });
		} else {
			const output = Array.from({ length: 40 }, () => sentence(8)).join('\n');
			timeline.appendToolResult(memberId, requestId, { callId, name: 'shell', output, isError: random() < 0.05 });
		}
	}
	// 发完消息没什么要说的：只有思考和一条空文字，这一轮没带回上下文，运行结束。
	request(ROUNDS_PER_RUN + 1, [reasoning(), { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '' }] }]);
	db.run(`UPDATE runs SET status = 'completed', ended_at = ? WHERE run_id = ?`, clock, runId);
};

// 压缩：上下文里的内容多了就把最早的一批换成摘要，摘要多了再合成一条，和真实的压缩一样只改状态、不删内容。
// 和真实的压缩一样：摘要再被摘要时沿用最早的编号，时间范围按被代替的摘要的范围算；一次请求的输出和工具结果一起处理，不拆开；只处理看过的。
const summarize = (memberId: string, items: readonly TimelineItem[]) => {
	const anchors = items.map(item => item.kind === 'summary' ? item.summary.anchorItemId : item.itemId);
	const times = items.flatMap(item => item.kind === 'summary' ? [item.summary.startTime, item.summary.endTime] : [item.createdAt]);
	const [startTime, endTime] = [Math.min(...times), Math.max(...times)];
	const summaryId = timeline.appendSummary(memberId, {
		text: Array.from({ length: 12 }, () => sentence(20)).join('\n'), keywords: [],
		anchorItemId: Math.min(...anchors), startTime, endTime, rangeText: timeRangeText(startTime, endTime), counts: countContent(items),
	});
	timeline.setContextState(memberId, items.map(item => item.itemId), 'summarized', summaryId);
	timeline.repointSummarized(memberId, items.filter(item => item.kind === 'summary').map(item => item.itemId), summaryId);
};
const compact = (memberId: string) => {
	const visible = () => db.all<{ item_id: number; kind: string; request_id: number | null }>(
		`SELECT item_id, kind, request_id FROM timeline_items WHERE member_id = ? AND context_state = 'visible' ORDER BY item_id`, memberId,
	);
	let rows = visible();
	if (rows.length <= VISIBLE_LIMIT) return;
	const items = (ids: readonly number[]) => ids.map(itemId => timeline.get(memberId, itemId)!);
	const seen = db.get<{ id: number }>('SELECT seen_through_item_id AS id FROM member_states WHERE member_id = ?', memberId)!.id;
	const content = rows.filter(row => row.kind !== 'summary' && row.item_id <= seen);
	let cut = content.length - KEEP_RECENT;
	while (cut > 0 && cut < content.length && content[cut]!.request_id !== null && content[cut]!.request_id === content[cut - 1]!.request_id) cut++;
	if (cut <= 0) return;
	summarize(memberId, items(content.slice(0, cut).map(row => row.item_id)));
	rows = visible();
	const summaries = rows.filter(row => row.kind === 'summary');
	if (summaries.length > SUMMARY_LIMIT) {
		summarize(memberId, items(summaries.slice(0, -1).map(row => row.item_id)));
	}
};

// 按天造：先是这一天的消息，再是各成员这一天的运行，每天结束时压缩一次。
const perDay = (total: number) => total / DAYS;
const carried = new Map<string, number>();
const share = (key: string, total: number) => {
	const value = (carried.get(key) ?? 0) + perDay(total);
	const whole = Math.floor(value);
	carried.set(key, value - whole);
	return whole;
};
for (let day = 0; day < DAYS; day++) {
	const dayStart = clock;
	db.transaction(() => {
		for (const { group, sender } of bigGroups) {
			for (let index = share(group.groupId, count(BIG_GROUP_MESSAGES)); index > 0; index--) {
				clock += 500;
				messages.send(sender.memberId, { kind: 'group', groupId: group.groupId }, sentence(15), [], [], { source: 'feishu', meta: { chat_id: 'oc_1', sender_name: '张三' } });
			}
		}
		for (const group of normalGroups) {
			const members = group.members.map(membership => membership.memberId);
			for (let index = share(group.groupId, count(NORMAL_GROUP_MESSAGES)); index > 0; index--) {
				clock += 1000;
				const sender = pick(members);
				const others = members.filter(memberId => memberId !== sender);
				messages.send(sender, { kind: 'group', groupId: group.groupId }, sentence(20), random() < 0.2 ? [pick(others)] : []);
			}
		}
		for (const ai of ais) {
			for (let index = share(`dm-${ai.memberId}`, count(DIRECT_MESSAGES)); index > 0; index--) {
				clock += 1000;
				const fromHuman = random() < 0.5;
				messages.send(fromHuman ? owner.memberId : ai.memberId, { kind: 'direct', memberId: fromHuman ? ai.memberId : owner.memberId }, sentence(20));
			}
		}
	});
	ais.forEach((ai, index) => db.transaction(() => {
		for (let run = share(`runs-${ai.memberId}`, count(index === 0 ? HEAVY_RUNS : RUNS)); run > 0; run--) {
			const groups = normalGroups.filter(group => group.members.some(membership => membership.memberId === ai.memberId));
			work(ai.memberId, groups.length > 0 && random() < 0.5 ? { kind: 'group', groupId: pick(groups).groupId } : { kind: 'direct', memberId: owner.memberId });
		}
		compact(ai.memberId);
	}));
	clock = Math.max(clock, dayStart + 24 * 60 * 60 * 1000);
	if (day % 10 === 9) log(`第 ${day + 1} 天`);
}
// 都当作已经处理过：不然启动运行时后，没看过的私聊和点名会让很多成员马上开始运行。
db.run('UPDATE member_states SET seen_through_item_id = (SELECT COALESCE(MAX(item_id), 0) FROM timeline_items WHERE timeline_items.member_id = member_states.member_id)');

const total = (sql: string) => db.get<{ n: number }>(sql)!.n;
log(`消息 ${total('SELECT COUNT(*) AS n FROM messages')} 条，时间线 ${total('SELECT COUNT(*) AS n FROM timeline_items')} 条，运行 ${total('SELECT COUNT(*) AS n FROM runs')} 次`);
const largest = db.all<{ member_id: string; n: number }>('SELECT member_id, COUNT(*) AS n FROM timeline_items GROUP BY member_id ORDER BY n DESC LIMIT 3');
log(`时间线最多的成员：${largest.map(row => `${runtime.members.require(row.member_id).name} ${row.n} 条`).join('，')}`);
Date.now = realNow;
await runtime.close();
