// 打一个能在 Linux 容器里直接跑的运行时包：node 二进制 + 代码 + node_modules（在 node:24 镜像里装，原生模块才是 Linux 的）。
// 用法：node eval/terminal-bench/bundle.mjs [--force]
// 产物：eval/build/reman-bundle.tar.gz（解压后是 node/bin/node 和 app/），以及 eval/build/bundle.json（大小和哈希）。
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const NODE_VERSION = '24.17.0';
const ROOT = resolve(import.meta.dirname, '..', '..');
const BUILD = resolve(import.meta.dirname, '..', '..', '.cache', 'build');
const PKG = join(BUILD, 'pkg');
const APP = join(PKG, 'app');
const BUNDLE = join(BUILD, 'reman-bundle.tar.gz');
const META = join(BUILD, 'bundle.json');

const run = (command, args, options = {}) => {
	process.stdout.write(`> ${command} ${args.join(' ')}\n`);
	execFileSync(command, args, { stdio: 'inherit', ...options });
};

if (existsSync(BUNDLE) && !process.argv.includes('--force')) {
	console.log(`已经有 ${BUNDLE}，要重打加 --force`);
	process.exit(0);
}

// node_modules 只有在 package-lock.json 没变的时候才能复用：换了依赖（比如加了 yaml）还跳过安装，
// 打出来的包里就会少东西，运行到那一步才报模块找不到。
const lockHash = createHash('sha256').update(readFileSync(join(ROOT, 'package-lock.json'))).digest('hex');
const lockStamp = join(APP, 'node_modules', '.lock-hash');
const installed = existsSync(lockStamp) && readFileSync(lockStamp, 'utf8').trim() === lockHash;
rmSync(join(APP, 'src'), { recursive: true, force: true });
rmSync(join(APP, 'skills'), { recursive: true, force: true });
rmSync(join(APP, 'custom-tools'), { recursive: true, force: true });
mkdirSync(APP, { recursive: true });
mkdirSync(join(PKG, 'node', 'bin'), { recursive: true });

// 1. 代码和它运行时需要的目录：每次都重新拷，代码改了不用重装依赖。
for (const name of ['package.json', 'package-lock.json']) copyFileSync(join(ROOT, name), join(APP, name));
for (const name of ['src', 'skills', 'custom-tools']) {
	cpSync(join(ROOT, name), join(APP, name), { recursive: true });
}
console.log('代码已复制');

if (!installed) {
	// 2. node_modules 在 Linux 镜像里装：node-pty 是原生模块，Windows 上装出来的用不了。
	run('docker', [
		'run', '--rm',
		'-v', `${APP.replaceAll('\\', '/')}:/app`,
		'-w', '/app',
		'node:' + NODE_VERSION.split('.')[0],
		'bash', '-lc', 'npm ci --omit=dev --no-audit --no-fund',
	]);
	writeFileSync(lockStamp, lockHash + '\n');
} else {
	console.log('node_modules 和 package-lock.json 一致，跳过安装');
}

// 3. node 二进制：官方 linux-x64 包，只要 bin/node。
// Git Bash 自带的 tar（bsdtar）不认 xz，所以拿 .tar.gz。
const nodeTarball = join(BUILD, `node-v${NODE_VERSION}-linux-x64.tar.gz`);
if (!existsSync(nodeTarball)) {
	run('curl', ['-fsSL', '-o', nodeTarball, `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.gz`]);
}
if (!existsSync(join(PKG, 'node', 'bin', 'node'))) {
	// 用相对路径：tar 把带冒号的绝对路径当成「远程主机:文件」。
	run('tar', ['-xzf', `node-v${NODE_VERSION}-linux-x64.tar.gz`, '-C', 'pkg/node/bin', '--strip-components=2', `node-v${NODE_VERSION}-linux-x64/bin/node`], { cwd: BUILD });
}
console.log('node 二进制已解出');

// 4. 打包。
rmSync(BUNDLE, { force: true });
run('tar', ['-czf', 'reman-bundle.tar.gz', '-C', 'pkg', 'node', 'app'], { cwd: BUILD });

const size = statSync(BUNDLE).size;
const hash = createHash('sha256').update(readFileSync(BUNDLE)).digest('hex');
writeFileSync(META, `${JSON.stringify({ nodeVersion: NODE_VERSION, size, sha256: hash }, null, '\t')}\n`);
console.log(`打好：${BUNDLE}（${(size / 1024 / 1024).toFixed(1)} MB，sha256 ${hash.slice(0, 16)}…）`);
