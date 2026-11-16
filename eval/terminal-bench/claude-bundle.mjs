// 打一个 Claude Code 的离线包：只装官方 npm 包，取它自带的原生可执行文件。
// 用法：node eval/terminal-bench/claude-bundle.mjs [--force]
// 产物：eval/build/claude-bundle.tar.gz（解压后是 bin/claude，一个自带运行时的单文件），
//       以及 eval/build/claude-bundle.json（大小和哈希）。
//
// 为什么要打包：Harbor 官方的安装方式是在每个任务容器里 apt 装 nodejs/npm 再 npm 装 claude-code，
// 几百个包过一遍代理要好几分钟，而容器跑完就扔——六道题就要重来六次。
// 新版 npm 包里 @anthropic-ai/claude-code 自带一个原生可执行文件（不用 node 启动），直接拷出来就行。
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');
// 产物放 eval/.cache/build：run.py 和 compare.sh 从这里读，.gitignore 也忽略的是这里（原来多跳了一层，写到了仓库根的 .cache）。
const BUILD = resolve(import.meta.dirname, '..', '.cache', 'build');
const PKG = join(BUILD, 'claude-pkg');
const BUNDLE = join(BUILD, 'claude-bundle.tar.gz');
const META = join(BUILD, 'claude-bundle.json');
// 容器里装依赖要走宿主机的转发代理（Clash 只监听 127.0.0.1，容器的 DNS 又是 TUN 的假 IP）。
const PROXY = process.env.CONTAINER_PROXY ?? 'http://host.docker.internal:7898';

if (existsSync(BUNDLE) && !process.argv.includes('--force')) {
	console.log(`已经有 ${BUNDLE}，要重打加 --force`);
	process.exit(0);
}

const run = (command, args, options = {}) => {
	process.stdout.write(`> ${command} ${args.join(' ')}\n`);
	execFileSync(command, args, { stdio: 'inherit', ...options });
};

rmSync(PKG, { recursive: true, force: true });
mkdirSync(join(PKG, 'bin'), { recursive: true });

const install = [
	'set -euo pipefail',
	'export PATH=/usr/local/bin:$PATH',
	'npm install -g @anthropic-ai/claude-code --no-audit --no-fund',
	'cp /usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe /out/bin/claude',
	'chmod +x /out/bin/claude',
	'/out/bin/claude --version',
].join(' && ');

run('docker', [
	'run', '--rm',
	'-v', `${PKG.replaceAll('\\', '/')}:/out`,
	'-e', `HTTP_PROXY=${PROXY}`,
	'-e', `HTTPS_PROXY=${PROXY}`,
	'-e', 'NO_PROXY=localhost,127.0.0.1',
	'node:24',
	'bash', '-lc', install,
]);

run('tar', ['-czf', 'claude-bundle.tar.gz', '-C', 'claude-pkg', 'bin'], { cwd: BUILD });

const bytes = readFileSync(BUNDLE);
writeFileSync(META, JSON.stringify({
	file: 'claude-bundle.tar.gz',
	bytes: bytes.length,
	sha256: createHash('sha256').update(bytes).digest('hex'),
}, null, 2) + '\n', 'utf8');
console.log(`打好：${BUNDLE}（${(bytes.length / 1e6).toFixed(1)} MB）`);
