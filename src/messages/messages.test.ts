import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { Runtime } from '../runtime.ts';
import { addAi, testRuntime } from '../testing.ts';

function setup(t: TestContext) {
	const runtime = testRuntime(t);
	const human = runtime.members.createHuman('张三');
	const host = addAi(runtime, '沈安');
	const alice = addAi(runtime, '陈屿');
	const bob = addAi(runtime, '顾宁');
	return { runtime, human, host, alice, bob };
}

/** 每个成员时间线里的内容，写成便于对比的短字符串。 */
function timelines(runtime: Runtime, ...memberIds: string[]): Record<string, string[]> {
	return Object.fromEntries(memberIds.map(memberId => [
		runtime.members.get(memberId)!.name,
		runtime.timeline.list(memberId).map(item => item.kind === 'message'
			? `消息:${runtime.messages.get(item.messageId)!.text}${item.wakes ? '(唤醒)' : ''}`
			: item.kind === 'group_event' ? `群聊${item.event.type}:${item.event.groupName}` : item.kind),
	]));
}

test('谁会被唤醒：私聊、点名、关注会唤醒；普通群消息和加入前的消息不会', t => {
	const { runtime, human, host, alice, bob } = setup(t);
	const group = runtime.groups.create(human.memberId, '狼人杀大厅', [host.memberId, alice.memberId]);
	const groupTarget = { kind: 'group', groupId: group.groupId } as const;

	runtime.messages.send(human.memberId, groupTarget, '大家好');
	runtime.messages.send(human.memberId, groupTarget, '请陈屿发言', [alice.memberId]);
	runtime.groups.setWatching(group.groupId, host.memberId, true, 'self');
	runtime.messages.send(alice.memberId, groupTarget, '我是好人');
	runtime.groups.updateMembers(human.memberId, group.groupId, [bob.memberId], []);
	runtime.messages.send(human.memberId, groupTarget, '@所有人 天黑了', 'all');
	runtime.messages.send(human.memberId, { kind: 'direct', memberId: bob.memberId }, '你的身份是狼人');

	assert.deepEqual(timelines(runtime, host.memberId, alice.memberId, bob.memberId, human.memberId), {
		沈安: ['群聊added:狼人杀大厅', '消息:大家好', '消息:请陈屿发言', '消息:我是好人(唤醒)', '消息:@所有人 天黑了(唤醒)'],
		陈屿: ['群聊added:狼人杀大厅', '消息:大家好', '消息:请陈屿发言(唤醒)', '消息:@所有人 天黑了(唤醒)'],
		顾宁: ['群聊added:狼人杀大厅', '消息:@所有人 天黑了(唤醒)', '消息:你的身份是狼人(唤醒)'],
		张三: [],
	});
	assert.deepEqual([host, alice, bob].map(member => runtime.timeline.hasPendingWake(member.memberId)), [true, true, true]);
	runtime.close();
});

test('群聊变动只通知相关成员，移出后不再收到消息，取消关注后不再被唤醒', t => {
	const { runtime, human, host, alice } = setup(t);
	const group = runtime.groups.create(host.memberId, '狼人群', [alice.memberId, human.memberId]);
	const groupTarget = { kind: 'group', groupId: group.groupId } as const;
	runtime.groups.setWatching(group.groupId, host.memberId, true, 'self');
	runtime.groups.setWatching(group.groupId, host.memberId, false, 'self');
	runtime.messages.send(alice.memberId, groupTarget, '杀林澈');
	runtime.groups.updateMembers(host.memberId, group.groupId, [], [alice.memberId]);
	runtime.messages.send(human.memberId, groupTarget, '收到');
	runtime.groups.dissolve(host.memberId, group.groupId);

	assert.deepEqual(timelines(runtime, host.memberId, alice.memberId), {
		沈安: ['消息:杀林澈', '消息:收到'],
		陈屿: ['群聊added:狼人群', '群聊removed:狼人群'],
	});
	assert.throws(() => runtime.messages.send(human.memberId, groupTarget, '还在吗'), /群聊不存在/);
	runtime.close();
});

test('私聊需要两个 AI 成员互相允许，真人不受限制；群聊点名必须是群里的其他成员', t => {
	const { runtime, human, host, alice, bob } = setup(t);
	assert.throws(() => runtime.messages.send(host.memberId, { kind: 'direct', memberId: alice.memberId }, '你好'), /无法私聊/);
	runtime.memberFolders.update(host.memberId, { definition: { directMessage: 'all' } });
	assert.throws(() => runtime.messages.send(host.memberId, { kind: 'direct', memberId: alice.memberId }, '你好'), /无法私聊/);
	runtime.memberFolders.update(alice.memberId, { definition: { directMessage: { allow: ['沈安'] } } });
	runtime.messages.send(host.memberId, { kind: 'direct', memberId: alice.memberId }, '你好');
	runtime.messages.send(alice.memberId, { kind: 'direct', memberId: human.memberId }, '你好');

	const group = runtime.groups.create(human.memberId, '大厅', [host.memberId]);
	assert.throws(() => runtime.messages.send(human.memberId, { kind: 'group', groupId: group.groupId }, '发言', [bob.memberId]), /不是该群聊中的其他成员/);
	assert.throws(() => runtime.messages.send(human.memberId, { kind: 'group', groupId: group.groupId }, '发言', [human.memberId]), /不是该群聊中的其他成员/);
	runtime.close();
});

test('私聊、拉群名单里的名字不分大小写', t => {
	const runtime = testRuntime(t);
	const echo = addAi(runtime, 'Echo');
	const host = addAi(runtime, '沈安', { directMessage: { allow: ['echo'] }, groupInvite: { deny: ['ECHO'] } });
	const member = runtime.members.get(host.memberId)!;
	assert.deepEqual([member.directMessage, member.groupInvite], [{ mode: 'allow', memberIds: [echo.memberId] }, { mode: 'deny', memberIds: [echo.memberId] }]);
	runtime.close();
});

test('AI 成员拉人进群要对方允许，拒绝时整个操作失败；真人拉人、已在群里的不受限制', t => {
	const { runtime, human, host, alice, bob } = setup(t);
	runtime.memberFolders.update(alice.memberId, { definition: { groupInvite: { deny: ['沈安'] } } });
	assert.throws(() => runtime.groups.checkInvites(host.memberId, [alice.memberId, bob.memberId]), /不允许你邀请加入群聊：陈屿/);
	runtime.groups.checkInvites(human.memberId, [alice.memberId]);
	const group = runtime.groups.create(host.memberId, '大厅', [bob.memberId]);
	runtime.groups.updateMembers(host.memberId, group.groupId, [alice.memberId], []);
	runtime.groups.checkInvites(host.memberId, [alice.memberId], group.groupId);
	runtime.groups.updateMembers(alice.memberId, group.groupId, [], [alice.memberId]);
	assert.throws(() => runtime.groups.checkInvites(host.memberId, [alice.memberId], group.groupId), /不允许你邀请加入群聊/);
	runtime.close();
});

test('对话列表的未读数和 @ 数，已读后清零，只看自己收到的消息；最后一条是自己能看到的，带着点名', t => {
	const { runtime, human, host, alice, bob } = setup(t);
	const group = runtime.groups.create(human.memberId, '大厅', [host.memberId, alice.memberId]);
	const groupTarget = { kind: 'group', groupId: group.groupId } as const;
	runtime.messages.send(human.memberId, groupTarget, '第一条');
	const mentioned = runtime.messages.send(human.memberId, groupTarget, '请沈安发言', [host.memberId]);
	runtime.messages.send(host.memberId, groupTarget, '我发言了');
	runtime.messages.send(human.memberId, { kind: 'direct', memberId: host.memberId }, '私聊');

	const summary = () => runtime.messages.conversations(host.memberId).map(conversation =>
		`${conversation.name}:${conversation.unreadCount}/${conversation.mentionCount}:${conversation.lastMessage?.text}`);
	assert.deepEqual(summary(), ['张三:1/0:私聊', '大厅:2/1:我发言了']);
	runtime.messages.markRead(host.memberId, groupTarget, mentioned.messageId);
	assert.deepEqual(summary(), ['张三:1/0:私聊', '大厅:0/0:我发言了']);
	assert.deepEqual(runtime.messages.list(alice.memberId, groupTarget).map(message => message.text), ['第一条', '请沈安发言', '我发言了']);

	// 后加入的看不到加入前的消息，没有最后一条；之后点名它的那条带着点名。
	runtime.groups.updateMembers(human.memberId, group.groupId, [bob.memberId], []);
	assert.deepEqual(runtime.messages.conversations(bob.memberId).map(conversation => [conversation.name, conversation.lastMessage]), [['大厅', undefined]]);
	runtime.messages.send(human.memberId, groupTarget, '顾宁好', [bob.memberId]);
	assert.deepEqual(runtime.messages.conversations(bob.memberId)[0]!.lastMessage?.mentionedMemberIds, [bob.memberId]);
	runtime.close();
});

test('消息翻页：往前、往后、取某条前后；不是这个对话的消息报错', t => {
	const { runtime, human, host, alice } = setup(t);
	const target = { kind: 'direct', memberId: host.memberId } as const;
	const ids = Array.from({ length: 10 }, (_, index) => runtime.messages.send(human.memberId, target, `第${index}条`).messageId);
	const other = runtime.messages.send(human.memberId, { kind: 'direct', memberId: alice.memberId }, '别的对话').messageId;
	const texts = (options: object) => runtime.messages.list(human.memberId, target, { limit: 3, ...options }).map(message => message.text);

	assert.deepEqual(texts({}), ['第7条', '第8条', '第9条']);
	assert.deepEqual(texts({ beforeMessageId: ids[7] }), ['第4条', '第5条', '第6条']);
	assert.deepEqual(texts({ afterMessageId: ids[2] }), ['第3条', '第4条', '第5条']);
	assert.deepEqual(texts({ aroundMessageId: ids[5], limit: 4 }), ['第3条', '第4条', '第5条', '第6条']);
	assert.deepEqual(texts({ aroundMessageId: ids[0], limit: 4 }), ['第0条', '第1条']);
	assert.throws(() => texts({ aroundMessageId: other }), /该对话中不存在消息/);
	runtime.close();
});

test('搜索消息：空格分开的词都要包含，不分大小写，只搜自己能看到的，新的在前', t => {
	const { runtime, human, host, bob } = setup(t);
	const send = (memberId: string, text: string) => runtime.messages.send(human.memberId, { kind: 'direct', memberId }, text).messageId;
	send(host.memberId, 'Hello 世界');
	const second = send(host.memberId, 'hello 朋友');
	send(host.memberId, '你好 世界');
	send(bob.memberId, 'hello 世界 秘密');
	const search = (query: string, options: object = {}) => runtime.messages.search(host.memberId, query, options).map(message => message.text);

	assert.deepEqual(search('HELLO'), ['hello 朋友', 'Hello 世界']);
	assert.deepEqual(search('hello  世界'), ['Hello 世界']);
	assert.deepEqual(search('秘密'), []);
	assert.deepEqual(search('hello', { beforeMessageId: second }), ['Hello 世界']);
	assert.throws(() => search('  '), /请输入要搜索的内容/);
	runtime.close();
});
