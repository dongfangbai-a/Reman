import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { temporaryDirectory } from '../testing.ts';
import { commandWords } from './command/commandApproval.ts';
import { DataProtection } from './protection.ts';

test('受保护的范围：数据目录里除了 workspaces 都算，读也要审批的（令牌和密钥、成员浏览器的数据、数据库）、整个数据目录单独说明；通过符号链接指进去的也算', async t => {
	const data = temporaryDirectory(t);
	const protection = new DataProtection({
		dataDirectory: data, workspacesDirectory: join(data, 'workspaces'), membersDirectory: join(data, 'members'), skillsDirectory: join(data, 'skills'),
		eventRoutesDirectory: join(data, 'event-routes'),
		customToolsDirectory: join(data, 'custom-tools'),
	});
	const touch = async (path: string) => {
		const result = await protection.touch(path);
		return result && `${result.kind}/${result.reason}`;
	};
	assert.equal(await touch(join(data, 'members', '林舟', 'member.json')), 'protected/修改成员配置：林舟');
	assert.equal(await touch(join(data, 'members', 'INDEX.md')), 'protected/修改运行时的数据：members/INDEX.md');
	assert.equal(await touch(join(data, 'skills', 'notes', 'SKILL.md')), 'protected/修改技能：notes');
	assert.equal(await touch(join(data, 'event-routes', 'ci-failure.js')), 'protected/修改事件路由：ci-failure');
	assert.equal(await touch(join(data, 'event-logs', '2026-11-02.jsonl')), 'protected/修改运行时的数据：event-logs/2026-11-02.jsonl');
	assert.equal(await touch(join(data, 'browsers', 'M_1', 'Cookies')), 'sensitive/涉及成员浏览器的数据：browsers/M_1/Cookies');
	assert.equal(await touch(join(data, 'runtime.sqlite-wal')), 'sensitive/涉及全部对话数据：runtime.sqlite-wal');
	assert.equal(await touch(join(data, 'secret-key')), 'sensitive/涉及运行时的令牌和密钥：secret-key');
	assert.equal(await touch(join(data, 'models.json')), 'protected/修改运行时的数据：models.json');
	assert.equal(await touch(join(data, 'access-token')), 'sensitive/涉及运行时的令牌和密钥：access-token');
	assert.equal(await touch(data), `sensitive/涉及整个数据目录：${data}`);
	assert.equal(await touch(dirname(data)), `sensitive/涉及整个数据目录：${dirname(data)}`);
	assert.equal(await touch(join(data, 'workspaces', 'M_1', 'members', 'a.txt')), undefined);
	assert.equal(await touch(join(temporaryDirectory(t), 'secret-key')), undefined);
	assert.equal(await new DataProtection().touch(join(data, 'secret-key')), undefined);

	// 任何仓库的 git 钩子和配置也受保护，仓库里其他文件照常；它们不算数据目录里的文件。
	const repository = join(temporaryDirectory(t), 'repo');
	assert.equal(await touch(join(repository, '.git', 'config')), 'protected/修改 git 的钩子和配置：repo/.git/config');
	assert.equal(await touch(join(repository, '.git', 'hooks', 'pre-commit')), 'protected/修改 git 的钩子和配置：repo/.git/hooks/pre-commit');
	assert.equal(await touch(join(repository, '.git')), 'protected/修改 git 的钩子和配置：repo/.git');
	assert.equal(await touch(join(repository, '.git', 'index')), undefined);
	assert.equal(await touch(join(repository, 'src', 'config')), undefined);
	assert.equal(await protection.isProtected(join(repository, '.git', 'config')), false);

	// 工作目录里的链接指到成员目录：按真实路径算。
	mkdirSync(join(data, 'members', '林舟'), { recursive: true });
	mkdirSync(join(data, 'workspaces', 'M_1'), { recursive: true });
	symlinkSync(join(data, 'members'), join(data, 'workspaces', 'M_1', 'link'), 'junction');
	assert.equal(await touch(join(data, 'workspaces', 'M_1', 'link', '林舟', 'prompt.md')), 'protected/修改成员配置：林舟');
});

test('PowerShell 命令里可能是路径的词：去掉引号，取等号后面的部分，通配符取前面的目录，含变量的跳过', () => {
	assert.deepEqual(commandWords(`cat "E:\\DATA\\a b\\models.json" && rm -rf ./x;echo hi>out.txt`), ['cat', 'E:\\DATA\\a b\\models.json', 'rm', '-rf', './x', 'echo', 'hi', 'out.txt']);
	assert.deepEqual(commandWords('grep --file=../../models.json -r key ../../*'), ['grep', '--file=../../models.json', '../../models.json', '-r', 'key', '../../']);
	assert.deepEqual(commandWords('ls *.json; cat $HOME/x %APPDATA%\\y; Get-Content -Path \'C:\\a\\[b].txt\''), ['ls', '.', 'cat', 'Get-Content', '-Path', 'C:/a/']);
	// 根目录下的通配符算根目录，不是当前目录。
	assert.deepEqual(commandWords('Get-ChildItem /* C:\\*'), ['Get-ChildItem', '/', 'C:/']);
});
