// 打一个 DeepSeek Harness（dsh）的离线包：容器里不用联网装依赖。
//
//   node eval/terminal-bench/dsh-bundle.mjs [--force]
//
// 产物：eval/build/dsh-bundle.tar.gz（解开是 node/ 和一个装着 @deepseek-ai/dsh 的 app/），
//       以及 eval/build/dsh-bundle.json（大小和哈希）。
//
// 为什么打包：dsh 是 npm 包，依赖 650 多个包、node_modules 快 900 MB，每进一个任务容器都装一遍
// 既慢又要联网；容器跑完就扔，每道题都得重来。node 用仓库里已有的 linux 版，和运行时的包同一个文件。
//
// 全部在 Linux 容器里做（装依赖、解 node、打包），宿主机的挂载目录里只落一个 tar.gz：
// 依赖几万个小文件，直接写到 Windows 挂载点上会慢到没法用。
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');
const BUILD = resolve(import.meta.dirname, '..', '..', '.cache', 'build');
const BUNDLE = join(BUILD, 'dsh-bundle.tar.gz');
const META = join(BUILD, 'dsh-bundle.json');
const NODE_TARBALL = join(BUILD, 'node-v24.17.0-linux-x64.tar.gz');
const NODE_TARBALL_NAME = 'node-v24.17.0-linux-x64.tar.gz';
/** 和 eval 里其它地方一致；换版本时改这里，或者用环境变量。 */
const VERSION = process.env.DSH_VERSION ?? '0.2.2-rc.1';
// 容器里装依赖走宿主机的转发代理（Clash 只监听 127.0.0.1，容器的 DNS 又是 TUN 的假 IP）。
const PROXY = process.env.CONTAINER_PROXY ?? 'http://host.docker.internal:7898';

if (existsSync(BUNDLE) && !process.argv.includes('--force')) {
	console.log(`已经有 ${BUNDLE}，要重打加 --force`);
	process.exit(0);
}
if (!existsSync(NODE_TARBALL)) {
	console.error(`缺 node 的 linux 包：${NODE_TARBALL}（先跑 node eval/terminal-bench/bundle.mjs，它会下载）`);
	process.exit(1);
}

const PACKAGE = join(BUILD, 'dsh-package.json');
writeFileSync(PACKAGE, `${JSON.stringify({
	name: 'dsh-eval-app', private: true, type: 'module',
	dependencies: { '@deepseek-ai/dsh': VERSION },
}, null, '\t')}\n`);
rmSync(BUNDLE, { force: true });

const script = [
	'set -euo pipefail',
	'rm -rf /work && mkdir -p /work/app',
	'cp /out/dsh-package.json /work/app/package.json',
	'cd /work/app',
	'npm install --no-audit --no-fund',
	'node -e "console.log(require(\'@deepseek-ai/dsh/package.json\').version)"',
	'cd /work',
	`tar -xzf /out/${NODE_TARBALL_NAME}`,
	'mv node-v24.17.0-linux-x64 node',
	'tar -czf /out/dsh-bundle.tar.gz -C /work node app',
].join(' && ');

try {
	execFileSync('docker', [
		'run', '--rm',
		'-v', `${BUILD.replaceAll('\\', '/')}:/out`,
		'-e', `HTTP_PROXY=${PROXY}`,
		'-e', `HTTPS_PROXY=${PROXY}`,
		'-e', 'NO_PROXY=localhost,127.0.0.1',
		'node:24',
		'bash', '-lc', script,
	], { stdio: 'inherit' });
} finally {
	rmSync(PACKAGE, { force: true });
}

const bytes = readFileSync(BUNDLE);
const sha256 = createHash('sha256').update(bytes).digest('hex');
writeFileSync(META, JSON.stringify({
	file: 'dsh-bundle.tar.gz', version: VERSION, bytes, sha256,
}, null, 2));
console.log(`打好：${BUNDLE}（${(bytes.length / 1024 / 1024).toFixed(1)} MB，sha256 ${sha256.slice(0, 16)}…）`);
