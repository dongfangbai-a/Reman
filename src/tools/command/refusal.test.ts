import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { test } from 'node:test';
import { CommandParser, type CommandLanguage } from './commandParser.ts';
import { refusedCommandReason } from './refusal.ts';

const parser = new CommandParser();
const windows = process.platform === 'win32';
const refused = (command: string, language: CommandLanguage = 'bash') => refusedCommandReason(parser, language, command, process.cwd());
const SUFFIX = '，不能由 AI 执行；确有需要时，请用户自行运行';

test('灾难级命令直接拒绝：删除根目录、用户目录、系统目录，格式化磁盘，关机，破坏启动配置，fork 炸弹', async () => {
	const bash = [
		'rm -rf /', 'rm -rf ~', 'rm -rf ~/', 'rm -rf "$HOME"', 'rm -rf ~/*', 'sudo rm -rf --no-preserve-root /', 'rm -r -f -- /',
		'cd build && rm -rf /*', 'cd / && rm -rf *', 'cd /\nrm -rf *', 'cd ~; rm -rf ./*', 'echo $(rm -rf ~)', 'DIR=build && rm -rf ~', 'bash -c "rm -rf ~"', 'nohup sh -lc \'rm -rf ~\'',
		windows ? 'cmd //c "rd /s /q C:\\\\"' : 'rm -rf /usr',
		windows ? 'powershell -Command "Remove-Item -Recurse -Force C:\\Windows"' : 'sudo rm -r /etc',
		'chmod -R 777 /', 'chown -R nobody ~',
		'dd if=/dev/zero of=/dev/sda bs=1M', 'cat disk.img > /dev/sdb', 'mkfs.ext4 /dev/sdb1', 'diskpart', 'format D: /q',
		'shutdown -h now', 'shutdown /s /t 0', 'systemctl reboot', 'sudo init 0',
		'bcdedit /set testsigning on', 'vssadmin delete shadows /all /quiet',
		':(){ :|:& };:', 'bomb() { bomb | bomb & }; bomb',
	];
	for (const command of bash) assert.ok((await refused(command))?.endsWith(SUFFIX), command);
	const powershell = ['Remove-Item -Recurse -Force ~', 'rm -r -fo $env:USERPROFILE', 'Remove-Item -Path $HOME -Recurse', 'Stop-Computer', 'Format-Volume -DriveLetter D'];
	for (const command of powershell) assert.ok((await refused(command, 'powershell'))?.endsWith(SUFFIX), command);

	assert.equal(await refused('rm -rf ~'), `rm -rf ~ 会删除整个用户目录 ${homedir()}${SUFFIX}`);
	assert.equal(await refused('echo ok && shutdown -h now'), `shutdown -h now 会关机、重启、休眠或注销电脑${SUFFIX}`);
	assert.equal(await refused('dd if=/dev/zero of=/dev/sda'), `dd if=/dev/zero of=/dev/sda 会直接写入磁盘设备 /dev/sda${SUFFIX}`);
});

test('有正当用途的、看不清的命令不拒绝，照常按审批方式', async () => {
	const bash = [
		'rm -rf build node_modules', 'rm -rf ~/projects/demo', 'rm -rf ./*', 'rm -f /', 'rm -rf "$DIR"', 'rm -rf $(cat dirs.txt)',
		'chmod -R 755 ./dist', 'chmod -r ~', 'fdisk -l', 'parted -l', 'shutdown /a', 'systemctl restart nginx',
		'git push --force', 'npm run format', 'echo shutdown', 'grep -rn "rm -rf /" .', 'vssadmin list shadows',
		'del /q C:\\temp\\*.log', 'dd if=disk.img of=backup.img', 'cat a > /dev/null', 'ls /', 'cd "$DIR" && rm -rf *', 'echo \'rm -rf ~\'',
	];
	for (const command of bash) assert.equal(await refused(command), undefined, command);
	const powershell = ['Remove-Item -Recurse .\\dist', 'Remove-Item ~\\notes.txt', 'Get-ChildItem C:\\Windows', 'Get-Process | Format-Table'];
	for (const command of powershell) assert.equal(await refused(command, 'powershell'), undefined, command);
});
