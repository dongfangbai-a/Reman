import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { addAi, testRuntime } from '../testing.ts';

test('技能：内置和技能目录两处，同名用技能目录里的，内置的（包括覆盖内置的）排在前面；成员只能读自己配置的技能，没找到的技能给警告', async t => {
	const runtime = testRuntime(t);
	const write = (name: string, content: string) => {
		mkdirSync(join(runtime.skills.directory, name), { recursive: true });
		writeFileSync(join(runtime.skills.directory, name, 'SKILL.md'), content);
	};
	write('write-skill', '---\nname: write-skill\ndescription: 自己改过的写技能规则\n---\n\n# 写技能\n');
	write('notes', '---\ndescription: >\n  记笔记的方法，\n  分两行写\n---\n\n成员目录：{{members_directory}}\n路由目录：{{event_routes_directory}}\n');
	write('Bad_Name', '# 名字不对\n');

	const snapshot = runtime.skills.snapshot();
	assert.deepEqual(snapshot.skills.map(skill => `${skill.name}/${skill.source}/${skill.description}`), [
		'create-custom-tool/builtin/新建、修改或删除自定义工具。',
		'manage-members/builtin/新建、修改或删除 AI 成员，查看现有成员和群聊。需要创建一批成员（例如组织一场游戏、组建一个团队）时使用。',
		'write-event-routes/builtin/新建、修改或删除外部事件的路由，决定飞书消息、GitHub 通知等外部事件投递给哪个 AI 成员或哪个群聊。用户要求安排外部事件的处理人，或询问某个事件为何未送达时使用。',
		'write-skill/data/自己改过的写技能规则',
		'notes/data/记笔记的方法， 分两行写',
	]);
	assert.deepEqual(snapshot.skills.filter(skill => skill.overridesBuiltin).map(skill => skill.name), ['write-skill']);
	assert.deepEqual(snapshot.issues.map(issue => issue.message), ['技能名「Bad_Name」只能包含小写英文字母、数字和横杠']);

	const host = addAi(runtime, '沈安', { skills: ['notes', 'manage-members', 'missing'] });
	assert.equal(runtime.memberFolders.snapshot().folders[0]!.issues.join(), '技能「missing」不存在，无法读取');
	const description = runtime.tools.definitions(host.memberId).find(tool => tool.name === 'read_skill')!.description;
	assert.match(description, /- notes：记笔记的方法， 分两行写\n- manage-members：新建/);
	const plain = addAi(runtime, '林舟');
	assert.match(runtime.tools.definitions(plain.memberId).find(tool => tool.name === 'read_skill')!.description, /\n为你配置的技能：暂无$/);

	const context = { memberId: host.memberId, workingDirectory: runtime.skills.directory, signal: new AbortController().signal };
	const read = async (name: string) => (await runtime.tools.call(context, 'read_skill', JSON.stringify({ name }))).output;
	assert.equal(await read('notes'), `技能目录：${join(runtime.skills.directory, 'notes')}\n\n---\ndescription: >\n  记笔记的方法，\n  分两行写\n---\n\n成员目录：${runtime.memberFolders.directory}\n路由目录：${runtime.external.routes.directory}\n`);
	assert.equal(await read('write-skill'), '未为你配置技能 write-skill；为你配置的技能：notes、manage-members、missing');
	assert.equal(await read('missing'), '技能 missing 不存在，可能已被删除');
	await runtime.close();
});
