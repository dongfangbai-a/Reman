import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { addAi, testRuntime } from '../testing.ts';

test('成员文件夹：新建、更新；有误时保持上一次的配置；删除后软删除并离开群聊，同名文件夹不读取', async t => {
	const runtime = testRuntime(t);
	const folders = runtime.memberFolders;
	const write = (name: string, json: string, prompt?: string) => {
		mkdirSync(join(folders.directory, name), { recursive: true });
		writeFileSync(join(folders.directory, name, 'member.json'), json);
		if (prompt !== undefined) writeFileSync(join(folders.directory, name, 'prompt.md'), prompt);
	};
	const human = runtime.members.createHuman('张三');
	write('沈安', JSON.stringify({ description: '主持人', directMessage: { allow: ['陈屿', '不存在'] }, tools: ['shell'] }), '你是主持人\n');
	write('陈屿', JSON.stringify({ directMessage: 'all' }));
	write('顾宁', JSON.stringify({ foo: 1 }));
	write('张三', '{}');
	folders.sync();

	const statuses = () => Object.fromEntries(folders.snapshot().folders.map(state => [state.name, `${state.status}:${state.issues.join('；')}`]));
	assert.deepEqual(statuses(), {
		张三: 'error:名字已被真人「张三」使用',
		沈安: 'warning:私聊名单中的「不存在」不是现有的 AI 成员，已忽略',
		陈屿: 'ok:',
		顾宁: 'error:无法识别的字段「foo」；可用字段：description、model、reasoning、directMessage、groupInvite、skills、tools、timeAwareness',
	});
	const host = runtime.members.findByName('沈安')!;
	const alice = runtime.members.findByName('陈屿')!;
	assert.equal(runtime.members.findByName('顾宁'), undefined);
	assert.deepEqual([host.description, host.prompt, host.tools, host.directMessage], ['主持人', '你是主持人', ['shell'], { mode: 'allow', memberIds: [alice.memberId] }]);
	assert.ok(runtime.tools.available(host.memberId).some(tool => tool.name === 'send_message'));
	assert.ok(!runtime.tools.available(host.memberId).some(tool => tool.name === 'search_history'));
	assert.match(readFileSync(join(folders.directory, 'INDEX.md'), 'utf8'), /\| 沈安 \| M_\w+ \| 主持人 \| 有警告：/);

	// 文件写错了：成员保持上一次正确的配置。
	write('沈安', JSON.stringify({ description: 1 }));
	folders.sync();
	assert.equal(statuses()['沈安'], 'error:description 必须是字符串');
	assert.equal(runtime.members.get(host.memberId)!.description, '主持人');

	// 删掉文件夹：软删除，它建的群聊解散，所在的其他群聊里它退出。
	const own = runtime.groups.create(host.memberId, '狼人群', [alice.memberId, human.memberId]);
	const other = runtime.groups.create(alice.memberId, '大厅', [host.memberId]);
	rmSync(join(folders.directory, '沈安'), { recursive: true });
	folders.sync();
	assert.equal(runtime.members.get(host.memberId)!.deleted, true);
	assert.equal(runtime.groups.get(own.groupId)!.dissolved, true);
	assert.deepEqual(runtime.groups.get(other.groupId)!.members.map(membership => membership.memberId), [alice.memberId]);

	// 同名文件夹再出现：不读取，名字还被已删除的成员占着，只能在网页端恢复。
	write('沈安', '{}');
	folders.sync();
	assert.equal(statuses()['沈安'], 'error:与已删除的成员同名：如需恢复该成员，请在网页端成员页的「已删除」中恢复；如需新建成员，请更换名字');
	assert.equal(folders.snapshot().folders.find(state => state.name === '沈安')!.memberId, null);
	assert.equal(runtime.members.get(host.memberId)!.deleted, true);
	await runtime.close();
});

test('删除和恢复：恢复时用存的成员文件生成文件夹（头像不存，恢复后没有），群聊、关注、定时照删除前；已有同名文件夹时用文件夹里的', async t => {
	const runtime = testRuntime(t);
	const { members, groups, reminders, timeline } = runtime;
	const folders = runtime.memberFolders;
	const human = members.createHuman('张三');
	const host = folders.create('沈安', { definition: { description: '主持人', tools: ['shell'] }, prompt: '你是主持人' });
	const alice = addAi(runtime, '陈屿');
	const bob = addAi(runtime, '顾宁');
	runtime.memories.write(host.memberId, '记住 A', false);
	const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
	assert.notEqual(folders.setAvatar(host.memberId, png).avatar, null);
	const own = groups.create(host.memberId, '狼人群', [alice.memberId, human.memberId, bob.memberId]);
	groups.setWatching(own.groupId, alice.memberId, true, 'self');
	const hall = groups.create(alice.memberId, '大厅', [host.memberId]);
	groups.setWatching(hall.groupId, host.memberId, true, 'self');
	const temporary = groups.create(alice.memberId, '临时', [host.memberId]);
	const reminder = reminders.add(host.memberId, { delay_seconds: 60, note: '提醒' });
	const groupEvents = (memberId: string) => timeline.all(memberId).flatMap(item => item.kind === 'group_event' ? [[item.event.type, item.event.groupName, item.wakes]] : []);
	const memberIds = (groupId: string) => groups.get(groupId)!.members.map(membership => membership.memberId).sort();
	const path = join(folders.directory, '沈安');
	const definition = readFileSync(join(path, 'member.json'), 'utf8');

	folders.remove(host.memberId);
	const deleted = members.get(host.memberId)!;
	assert.equal(existsSync(path), false);
	assert.ok(deleted.deleted && deleted.deletedAt !== null && !deleted.purged && deleted.avatar === null);
	assert.deepEqual(deleted.deletion, {
		dissolvedGroups: [{ groupId: own.groupId, name: '狼人群' }],
		leftGroups: [{ groupId: hall.groupId, name: '大厅' }, { groupId: temporary.groupId, name: '临时' }],
		reminders: 1,
	});
	assert.deepEqual(groupEvents(alice.memberId).at(-1), ['dissolved', '狼人群', false]);
	assert.match(readFileSync(join(folders.directory, 'INDEX.md'), 'utf8'), new RegExp(`## 已删除的成员[^]*\\| 沈安 \\| ${host.memberId} \\|`));
	assert.throws(() => addAi(runtime, '沈安'), /成员名「沈安」与已删除的成员同名/);
	// 删除期间定时不触发。
	runtime.db.run('UPDATE reminders SET next_at = ? WHERE reminder_id = ?', Date.now() - 5000, reminder.reminderId);
	reminders.check();
	assert.equal(reminders.list(host.memberId).length, 1);
	// 删除期间顾宁也被删了：它还在已解散的狼人群里，狼人群恢复时它要退出，等它自己恢复时再加回来。
	folders.remove(bob.memberId);
	groups.dissolve(alice.memberId, temporary.groupId);

	const restored = runtime.restoreMember(host.memberId);
	assert.deepEqual([restored.deleted, restored.description, restored.tools, restored.avatar, restored.deletion], [false, '主持人', ['shell'], null, null]);
	assert.equal(readFileSync(join(path, 'member.json'), 'utf8'), definition);
	assert.equal(readFileSync(join(path, 'prompt.md'), 'utf8'), '你是主持人\n');
	assert.equal(readFileSync(join(path, 'memory.md'), 'utf8'), '记住 A\n');
	assert.equal(existsSync(join(path, 'avatar.png')), false);
	assert.equal(groups.get(own.groupId)!.dissolved, false);
	assert.deepEqual(memberIds(own.groupId), [host.memberId, alice.memberId, human.memberId].sort());
	assert.equal(groups.get(own.groupId)!.members.find(membership => membership.memberId === alice.memberId)!.watching, true);
	assert.deepEqual(groupEvents(alice.memberId).slice(-1), [['restored', '狼人群', false]]);
	assert.deepEqual(memberIds(hall.groupId), [alice.memberId, host.memberId].sort());
	assert.equal(groups.get(hall.groupId)!.members.find(membership => membership.memberId === host.memberId)!.watching, true);
	assert.ok(!memberIds(temporary.groupId).includes(host.memberId));
	assert.deepEqual(members.get(bob.memberId)!.deletion!.leftGroups, [{ groupId: own.groupId, name: '狼人群' }]);
	// 删除期间错过的定时补触发一次，写明晚了多久。
	const fired = timeline.all(host.memberId).filter(item => item.kind === 'reminder');
	assert.equal(fired.length, 1);
	assert.ok(fired[0]!.kind === 'reminder' && fired[0]!.reminder.lateMs >= 5000);
	assert.deepEqual(reminders.list(host.memberId), []);
	assert.doesNotMatch(readFileSync(join(folders.directory, 'INDEX.md'), 'utf8'), /\| 沈安 \| M_\w+ \| \d/);

	runtime.restoreMember(bob.memberId);
	assert.deepEqual(memberIds(own.groupId), [host.memberId, alice.memberId, human.memberId, bob.memberId].sort());

	// 已有同名文件夹（例如从回收站还原了）：用文件夹里的内容。
	folders.remove(host.memberId);
	mkdirSync(path);
	writeFileSync(join(path, 'member.json'), JSON.stringify({ description: '还原的' }));
	folders.sync();
	assert.equal(folders.snapshot().folders.find(state => state.name === '沈安')!.status, 'error');
	assert.equal(runtime.restoreMember(host.memberId).description, '还原的');
	assert.equal(folders.snapshot().folders.find(state => state.name === '沈安')!.status, 'ok');
	assert.throws(() => runtime.restoreMember(host.memberId), /未被删除/);
	await runtime.close();
});

test('彻底删除：删掉只属于成员的数据，对话里的消息保留；名字空出来，同名的是新成员', async t => {
	const runtime = testRuntime(t);
	const { members, messages, reminders, timeline } = runtime;
	const human = members.createHuman('张三');
	const host = addAi(runtime, '沈安');
	const target = { kind: 'direct', memberId: host.memberId } as const;
	messages.send(human.memberId, target, '你好');
	reminders.add(host.memberId, { delay_seconds: 60, note: '提醒' });
	runtime.tools.setPolicy(host.memberId, 'shell', 'allow');
	// 计划指着时间线里的条目。
	runtime.plans.update(host.memberId, [{ text: '订会议室', status: 'pending' }], timeline.all(host.memberId)[0]!.itemId);
	await assert.rejects(runtime.purgeMember(host.memberId), /未被删除/);

	runtime.memberFolders.remove(host.memberId);
	assert.ok(timeline.all(host.memberId).length > 0);
	await runtime.purgeMember(host.memberId);
	const purged = members.get(host.memberId)!;
	assert.deepEqual([purged.name, purged.deleted, purged.purged, purged.deletion], ['沈安', true, true, null]);
	assert.deepEqual(timeline.all(host.memberId), []);
	assert.deepEqual(reminders.list(host.memberId), []);
	assert.deepEqual(runtime.plans.get(host.memberId), { items: [], updatedAt: null });
	assert.equal(runtime.db.get<{ count: number }>('SELECT COUNT(*) AS count FROM tool_policies WHERE member_id = ?', host.memberId)!.count, 0);
	assert.deepEqual(messages.list(human.memberId, target).map(message => message.text), ['你好']);
	assert.equal(members.findByName('沈安'), undefined);
	assert.throws(() => runtime.restoreMember(host.memberId), /成员不存在/);
	assert.doesNotMatch(readFileSync(join(runtime.memberFolders.directory, 'INDEX.md'), 'utf8'), /已删除的成员/);

	const again = addAi(runtime, '沈安');
	assert.notEqual(again.memberId, host.memberId);
	await runtime.close();
});

test('通过接口改成员文件：有误时报错，文件和成员都不变', async t => {
	const runtime = testRuntime(t);
	runtime.members.createHuman('张三');
	const host = addAi(runtime, '沈安', { description: '主持人' });
	assert.throws(() => runtime.memberFolders.update(host.memberId, { definition: { tools: ['send_message'] } }), /始终可用/);
	assert.equal(readFileSync(join(runtime.memberFolders.directory, '沈安', 'member.json'), 'utf8'), '{\n  "description": "主持人"\n}\n');
	assert.equal(runtime.members.get(host.memberId)!.tools, null);
	assert.throws(() => addAi(runtime, '张三'), /已被使用/);
	assert.equal(existsSync(join(runtime.memberFolders.directory, '张三')), false);
	await runtime.close();
});

test('思考强度和模型分开写，用默认模型也能设；只认固定的几档', async t => {
	const runtime = testRuntime(t);
	const member = runtime.memberFolders.create('沈安', { definition: { reasoning: 'low' } });
	assert.equal(member.reasoningEffort, 'low');
	assert.equal(member.model, null);
	assert.deepEqual(JSON.parse(readFileSync(join(runtime.memberFolders.directory, '沈安', 'member.json'), 'utf8')), { reasoning: 'low' });
	assert.throws(() => runtime.memberFolders.update(member.memberId, { definition: { reasoning: 'minimal' } }), /reasoning 只能是/);
});

test('时间感知：member.json 没写时开着，写 false 关掉并写回文件；只认 true 和 false；真人总是开着', async t => {
	const runtime = testRuntime(t);
	const member = addAi(runtime, '沈安');
	assert.equal(member.timeAwareness, true);
	assert.equal(runtime.memberFolders.update(member.memberId, { definition: { timeAwareness: false } }).timeAwareness, false);
	assert.deepEqual(JSON.parse(readFileSync(join(runtime.memberFolders.directory, '沈安', 'member.json'), 'utf8')), { timeAwareness: false });
	assert.throws(() => runtime.memberFolders.update(member.memberId, { definition: { timeAwareness: 'off' as never } }), /timeAwareness 必须是 true 或 false/);
	assert.equal(runtime.members.get(member.memberId)!.timeAwareness, false);
	assert.equal(runtime.members.createHuman('张三').timeAwareness, true);
	await runtime.close();
});

test('AI 成员有默认工作目录（不管用没用），真人没有；成员文件夹快照带上默认目录所在的目录', async t => {
	const runtime = testRuntime(t);
	const ai = addAi(runtime, '沈安');
	const human = runtime.members.createHuman('张三');
	assert.equal(ai.defaultWorkingDirectory, join(runtime.members.workspacesDirectory, ai.memberId));
	assert.equal(human.defaultWorkingDirectory, null);
	assert.equal(runtime.memberFolders.snapshot().workspacesDirectory, runtime.members.workspacesDirectory);
	// 只是算出路径，第一次用到时才创建。
	assert.equal(existsSync(ai.defaultWorkingDirectory!), false);
	await runtime.close();
});

test('指定的工作目录不存在、不是文件夹时成员数据写明原因，每次取都重新检查；默认目录不检查', async t => {
	const runtime = testRuntime(t);
	const ai = addAi(runtime, '沈安');
	assert.equal(ai.workingDirectoryProblem, null);
	const directory = join(runtime.members.workspacesDirectory, '..', 'project');
	mkdirSync(directory, { recursive: true });
	assert.equal(runtime.members.setWorkingDirectory(ai.memberId, directory).workingDirectoryProblem, null);
	rmSync(directory, { recursive: true });
	assert.equal(runtime.members.require(ai.memberId).workingDirectoryProblem, '目录不存在');
	writeFileSync(directory, '');
	assert.equal(runtime.members.require(ai.memberId).workingDirectoryProblem, '不是文件夹');
	await runtime.close();
});
