import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { IShell } from '../../shells/shells.ts';
import { temporaryDirectory } from '../../testing.ts';
import { DataProtection } from '../protection.ts';
import { checkCommand } from './commandApproval.ts';
import { CommandParser } from './commandParser.ts';
import { isSimpleSedScript } from './commandRules.ts';

const parser = new CommandParser();
const bash: IShell = { kind: 'bash', executable: 'bash', label: 'bash' };

/** 一行一条命令：空字符串是放行，否则是审批原因，受保护的原因前面加「受保护：」，用 | 隔开。 */
const CASES: readonly (readonly [string, string])[] = [
	// 查看类
	['ls -la', ''],
	['git status && git diff', ''],
	['git log --oneline -5 -- src', ''],
	['git -C sub --no-pager log', ''],
	['git branch -a', ''],
	['git config --get user.name', ''],
	['cat README.md | head -20', ''],
	['grep -rn "TODO" src', ''],
	['rg -n foo src', ''],
	['find . -name "*.ts" -type f', ''],
	['ps aux', ''],
	['jq .name package.json', ''],
	['sed -n \'1,20p\' a.txt', ''],
	['sed -E \'s/(a)+/\\1/g; /^$/d\' a.txt', ''],
	['sort data.txt | uniq -c', ''],
	['node --version', ''],
	['npm ls --depth=0', ''],
	['echo "$HOME" $PATH', ''],
	['timeout 10 ls 2>/dev/null', ''],
	['bash -c \'ls -la\'', ''],
	['cd src && cat ../README.md', ''],
	['cat ../../members/林舟/member.json', ''],
	['cat .git/config', ''],
	// 写文件
	['echo hi > out.txt', ''],
	['mkdir -p build/x && cp a.txt build/x/', ''],
	['cat <<EOF > notes.md\nhi\nEOF', ''],
	['sed -i \'s/a/b/\' a.txt', ''],
	['cd sub && echo hi > ../x.txt', ''],
	['cd sub && ls | sort > ../x.txt', ''],
	['echo hi > ../x.txt', '写入工作目录以外：../x.txt'],
	['cd .. && echo hi > x.txt', '写入工作目录以外：x.txt'],
	['cd sub; echo hi > ../x.txt', '写入工作目录以外：../x.txt'],
	['echo hi > $OUT', '无法确定写入位置：$OUT'],
	['cp /etc/hosts .', '从工作目录以外复制：/etc/hosts'],
	['mv a.txt ../b.txt', '写入工作目录以外：../b.txt'],
	['ls > >(tee ../.bashrc)', '无法确定写入位置：>(tee ../.bashrc) | 写入工作目录以外：../.bashrc'],
	// 容易漏的：选项的值是要写的文件、长选项的缩写、会执行代码的子命令
	['sort --output=/etc/x a.txt', '写入工作目录以外：/etc/x'],
	['find . -fprint0 /tmp/x', '不在免审批范围内：find -fprint0'],
	['git diff --output=/tmp/x', '不在免审批范围内：git diff --output'],
	['git log --out=/tmp/x', '不在免审批范围内：git log --out'],
	['npm ci', '不在免审批范围内：npm ci'],
	['sed -i \'s/a/b/\' /etc/hosts', '写入工作目录以外：/etc/hosts'],
	// 会执行别的代码、不在清单里、看不清的
	['sed \'s/x/y/e\' a.txt', '不在免审批范围内：sed 脚本'],
	['sed \'s/[/]/;p;#/e\' a.txt', '不在免审批范围内：sed 脚本'],
	['rg --pre ./x foo', '不在免审批范围内：rg --pre'],
	['find . -exec rm {} \\;', '不在免审批范围内：find -exec'],
	['rm -rf build', '不在免审批范围内：rm'],
	['node script.js', '不在免审批范围内：node'],
	['npm test', '不在免审批范围内：npm test'],
	['yarn list', '不在免审批范围内：yarn'],
	['./build.sh --version', '不在免审批范围内：./build.sh'],
	['cmd //c dir', '不在免审批范围内：cmd'],
	['git push', '不在免审批范围内：git push'],
	['git -c core.pager=less log', '不在免审批范围内：git -c'],
	['git branch -D main', '不在免审批范围内：git branch -D'],
	['FOO=1 git status', '临时设置环境变量：FOO'],
	['export FOO=1 && ls', '设置环境变量：FOO'],
	['eval ls', '无法解析的写法：eval'],
	['f() { ls; }; f', '无法解析的写法：定义函数 f | 不在免审批范围内：f'],
	['cat "$F"', '无法确定读取的文件：$F'],
	['sort $OPTS a.txt', '无法确定读取的文件：$OPTS'],
	['wc -l $(git ls-files)', '无法确定读取的文件：$(git ls-files)'],
	['find . -name "*.ts" | xargs grep -n foo', '无法确定读取的文件：xargs 读取的内容'],
	['git log )(', '命令无法自动判断'],
	// 受保护的数据
	['cat ../../secret-key', '受保护：涉及运行时的令牌和密钥：secret-key'],
	['cd ../.. && cat secret-key', '受保护：涉及运行时的令牌和密钥：secret-key'],
	['git diff --no-index a.txt ../../secret-key', '受保护：涉及运行时的令牌和密钥：secret-key'],
	['echo x > ../../members/林舟/prompt.md', '写入工作目录以外：../../members/林舟/prompt.md | 受保护：修改成员配置：林舟'],
	['node -e "x" ../../secret-key', '不在免审批范围内：node | 受保护：涉及运行时的令牌和密钥：secret-key'],
	['echo x > .git/config', '受保护：修改 git 的钩子和配置：M_1/.git/config'],
	['cp hook.sh .git/hooks/pre-commit', '受保护：修改 git 的钩子和配置：M_1/.git/hooks/pre-commit'],
];

test('命令的自动判断：一行一条命令和预期结果', async t => {
	const data = temporaryDirectory(t);
	const workingDirectory = join(data, 'workspaces', 'M_1');
	mkdirSync(join(workingDirectory, 'sub'), { recursive: true });
	const protection = new DataProtection({
		dataDirectory: data, workspacesDirectory: join(data, 'workspaces'), membersDirectory: join(data, 'members'), skillsDirectory: join(data, 'skills'),
		eventRoutesDirectory: join(data, 'event-routes'),
		customToolsDirectory: join(data, 'custom-tools'),
	});
	const results = await Promise.all(CASES.map(async ([command]) => {
		const result = await checkCommand(parser, bash, command, { directory: workingDirectory, workingDirectory, protection });
		return [...result.reasons, ...result.protectedReasons.map(reason => `受保护：${reason}`)].join(' | ');
	}));
	assert.deepEqual(CASES.map(([command], index) => [command, results[index]]), CASES);
});

test('当前目录看不清时，相对路径的读写都看不清；PowerShell 的命令都要审批', async t => {
	const workingDirectory = temporaryDirectory(t);
	const protection = new DataProtection();
	const unknown = await checkCommand(parser, bash, 'cat a.txt; echo hi > b.txt; ls', { directory: undefined, workingDirectory, protection });
	assert.deepEqual(unknown.reasons, ['无法确定写入位置：b.txt', '无法确定读取的文件：a.txt']);
	const powershell = await checkCommand(parser, { kind: 'pwsh', executable: 'pwsh', label: 'PowerShell 7' }, 'Get-ChildItem', { directory: workingDirectory, workingDirectory, protection });
	assert.deepEqual(powershell.reasons, ['PowerShell 命令均须审批']);
});

test('简单的 sed 脚本：看得懂的放行，执行程序、读写文件的不算', () => {
	for (const script of ['p', '1,20p', 's/a/b/g', '$!N;s/\\n/ /', ':a;N;$!ba;s/\\n/ /g', '/x/{s/a/b/;p}', 's|[|]|x|', '1~2d', '/start/,/end/d', 'y/abc/xyz/', '1i\\header']) {
		assert.ok(isSimpleSedScript(script), script);
	}
	for (const script of ['s/a/b/e', 's/a/b/w out', 'w out', 'r /etc/passwd', 'e date', '1e date', 's/[/]/;p;#/e', '#n', 'v', 's/a/b']) {
		assert.ok(!isSimpleSedScript(script), script);
	}
});
