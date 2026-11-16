/**
 * 把 eval/evidence 里的原始证据按批次打成发布用的包，算 sha256，更新索引和 EVIDENCE.md。
 *
 *   node eval/pack-evidence.mjs --batch 2026-11 --dry-run     # 只扫描、报体积，不打包
 *   node eval/pack-evidence.mjs --batch 2026-11              # 打包到 eval/.packs/，记进索引
 *   node eval/pack-evidence.mjs --batch 2026-11 --index-only  # 包已经打好，只更新索引和 EVIDENCE.md
 *
 * 包分三个：
 *   <批次>-terminal-bench.tar.gz   轨迹、日志、评分（不含产物）
 *   <批次>-programbench.tar.gz     同上
 *   <批次>-artifacts.tar.gz        产物：artifacts/ 目录、模型权重、submission 包
 *
 * 打包前先在 staging 里复制一份并打码（密钥、令牌、本机用户名与路径），
 * 打完码再扫一遍，扫不干净就停下来；原始证据不动。
 * 索引在 eval/evidence-batches.json（进仓库），EVIDENCE.md 由它生成。
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { parseArgs } from 'node:util';

const root = process.cwd();
const evidenceRoot = join(root, 'eval', 'evidence');
const indexPath = join(root, 'eval', 'evidence-batches.json');
const benches = ['terminal-bench', 'programbench'];

const { values } = parseArgs({
	options: {
		batch: { type: 'string' },
		out: { type: 'string' },
		'dry-run': { type: 'boolean', default: false },
		'index-only': { type: 'boolean', default: false },
	},
});
const batch = values.batch;
if (!batch) {
	console.error('要指定批次：--batch 2026-11');
	process.exit(1);
}

const outputDirectory = values.out ? join(root, values.out) : join(root, 'eval', '.packs');
const staging = join(outputDirectory, `${batch}-staging`);

/** 这些算产物，单独打一个包，不然只想要轨迹的人得跟着下几百 M。 */
function isArtifact(path) {
	return path.includes('/artifacts/') || path.endsWith('.safetensors') || path.endsWith('submission.tar.gz');
}

/** 递归列出目录下的文件（相对仓库根目录，正斜杠）。 */
function walk(directory, out = []) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) walk(path, out);
		else if (entry.isFile()) out.push(relative(root, path).replace(/\\/g, '/'));
	}
	return out;
}

/** 要打码的内容；占位符一律 ASCII——文件按 latin1 原样写回，中文占位符会把编码弄坏。 */
const secrets = [
	{ name: 'API 密钥', re: /sk-[A-Za-z0-9]{32,}/g, replace: 'sk-<redacted>' },
	{ name: 'Bearer 令牌', re: /Bearer [A-Za-z0-9._~+/-]{20,}/g, replace: 'Bearer <redacted>' },
	{ name: 'Windows 用户目录', re: /[A-Za-z]:\\+Users\\+liujia/gi, replace: '<user-dir>' },
	{ name: 'Git Bash 路径', re: /\/c\/Users\/liujia/gi, replace: '<user-dir>' },
	{ name: '本机用户名', re: /liujia/gi, replace: '<user>' },
];

const scanLimit = 64 * 1024 * 1024;
/** 本地日期 YYYY-MM-DD。 */
function localDate() {
	const now = new Date();
	const pad = value => String(value).padStart(2, '0');
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

const megabytes = bytes => `${(bytes / 1048576).toFixed(1)}M`;
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const totalOf = list => list.reduce((sum, file) => sum + statSync(join(root, file)).size, 0);

/** 这个文件命中了哪些模式；太大的跳过（二进制打码会毁掉文件）。 */
function hitsOf(path, base = root) {
	if (statSync(join(base, path)).size > scanLimit) return [];
	const text = readFileSync(join(base, path), 'latin1');
	return secrets.filter(secret => new RegExp(secret.re.source).test(text));
}

/** 本批次覆盖哪些运行：证据目录下的一级子目录（logs 是零散日志，不算一场运行）。 */
function runsOf() {
	const runs = [];
	for (const bench of benches) {
		const path = join(evidenceRoot, bench);
		if (!existsSync(path)) continue;
		for (const entry of readdirSync(path, { withFileTypes: true })) {
			if (!entry.isDirectory() || entry.name === 'logs') continue;
			runs.push(entry.name);
		}
	}
	return runs.sort();
}

let packed = [];
let redactedCount = 0;

if (!values['index-only']) {
	if (!existsSync(evidenceRoot)) {
		console.error(`没有 ${evidenceRoot}：证据不在本机时不用打包。`);
		process.exit(1);
	}
	const files = benches.flatMap(bench => {
		const path = join(evidenceRoot, bench);
		return existsSync(path) ? walk(path) : [];
	});

	const artifactFiles = files.filter(isArtifact);
	const normalFiles = files.filter(file => !isArtifact(file));
	const groups = [
		{ name: 'terminal-bench', files: normalFiles.filter(file => file.includes('/terminal-bench/')) },
		{ name: 'programbench', files: normalFiles.filter(file => file.includes('/programbench/')) },
		{ name: 'artifacts', files: artifactFiles },
	];

	const redacted = files.map(file => ({ file, hits: hitsOf(file) })).filter(entry => entry.hits.length > 0);
	redactedCount = redacted.length;
	console.log(`批次 ${batch}：${files.length} 个文件，共 ${megabytes(totalOf(files))}`);
	for (const group of groups) {
		console.log(`  ${group.name}：${group.files.length} 个文件，${megabytes(totalOf(group.files))}`);
	}
	if (redacted.length > 0) {
		const names = [...new Set(redacted.flatMap(entry => entry.hits.map(hit => hit.name)))];
		console.log(`\n需要打码的文件 ${redacted.length} 个（${megabytes(totalOf(redacted.map(entry => entry.file)))}）：${names.join('、')}`);
		for (const entry of redacted.slice(0, 10)) console.log(`  ${entry.file}：${entry.hits.map(hit => hit.name).join('、')}`);
		if (redacted.length > 10) console.log(`  …还有 ${redacted.length - 10} 个`);
	}

	if (values['dry-run']) {
		console.log('\n--dry-run，没有打包。');
		process.exit(0);
	}

	// staging：要打码的文件复制后改写，其余用硬链接（同一个盘上不占空间）
	rmSync(staging, { recursive: true, force: true });
	const redactedSet = new Set(redacted.map(entry => entry.file));
	for (const file of files) {
		const target = join(staging, file);
		mkdirSync(dirname(target), { recursive: true });
		if (!redactedSet.has(file)) {
			try {
				linkSync(join(root, file), target);
			} catch {
				copyFileSync(join(root, file), target);
			}
			continue;
		}
		let text = readFileSync(join(root, file), 'latin1');
		for (const secret of secrets) text = text.replace(secret.re, secret.replace);
		writeFileSync(target, Buffer.from(text, 'latin1'));
	}

	// 打完码再扫一遍，扫不干净就别发了
	const leftovers = files.map(file => ({ file, hits: hitsOf(file, staging) })).filter(entry => entry.hits.length > 0);
	if (leftovers.length > 0) {
		console.error(`\n打完码还有 ${leftovers.length} 个文件命中，停下来：`);
		for (const entry of leftovers.slice(0, 10)) console.error(`  ${entry.file}：${entry.hits.map(hit => hit.name).join('、')}`);
		process.exit(1);
	}

	/** 用系统 tar；有 zstd 就用 zstd，没有就用 gzip（Windows 自带的是 gzip）。 */
	let flag = '-z';
	try {
		execFileSync('zstd', ['--version'], { stdio: 'ignore' });
		flag = '--zstd';
	} catch {
		// 没有 zstd 就用 gzip
	}
	const extension = flag === '--zstd' ? 'tar.zst' : 'tar.gz';

	mkdirSync(outputDirectory, { recursive: true });
	for (const group of groups) {
		if (group.files.length === 0) continue;
		const name = `${batch}-${group.name}.${extension}`;
		const archive = join(outputDirectory, name);
		const listFile = join(outputDirectory, `${batch}-${group.name}.files.txt`);
		writeFileSync(listFile, `${group.files.join('\n')}\n`);
		// --force-local：Windows 的 E:\ 会被 tar 当成「远程主机 E」。
		execFileSync('tar', [flag, '--force-local', '-cf', archive, '--files-from', listFile], { cwd: staging, stdio: ['ignore', 'ignore', 'inherit'] });
		packed.push({ name, size: statSync(archive).size, sha256: sha256(archive), files: group.files.length });
		console.log(`打好 ${name}：${megabytes(packed.at(-1).size)}，sha256 ${packed.at(-1).sha256.slice(0, 12)}…`);
	}
	rmSync(staging, { recursive: true, force: true });
} else {
	// 只更新索引：包已经在 eval/.packs 里，重算大小和 sha256
	for (const name of readdirSync(outputDirectory).filter(entry => entry.startsWith(`${batch}-`) && /\.tar\.(gz|zst)$/.test(entry))) {
		const archive = join(outputDirectory, name);
		packed.push({ name, size: statSync(archive).size, sha256: sha256(archive), files: null });
	}
	if (packed.length === 0) {
		console.error(`eval/.packs 里没有 ${batch} 的包。`);
		process.exit(1);
	}
}

let commit = '（未记录）';
try {
	commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
} catch {
	// 不在 git 仓库里就留空
}

// 索引：一个批次一条，重新打同一批次就覆盖
const index = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, 'utf8')) : { batches: [] };
index.batches = index.batches.filter(entry => entry.batch !== batch);
index.batches.push({
	batch,
	// 用本地日期：打包是按本机的日子叫批次的，别写成 UTC 的前一天
	packedAt: localDate(),
	commit,
	runs: existsSync(evidenceRoot) ? runsOf() : [],
	redactedFiles: redactedCount,
	packages: packed,
});
index.batches.sort((a, b) => a.batch.localeCompare(b.batch));
writeFileSync(indexPath, `${JSON.stringify(index, null, '\t')}\n`);

// EVIDENCE.md：给别人看的那份索引
const rows = JSON.parse(readFileSync(join(root, 'eval', 'results.json'), 'utf8')).rows;
const runOf = (path, bench) => {
	const parts = path.replace(/\\/g, '/').split('/');
	return bench === 'Terminal-Bench' ? parts.at(-3) : parts.at(-1);
};
const batchOf = run => index.batches.find(entry => entry.runs.includes(run))?.batch ?? '（未打包）';

const lines = [
	'# 基准测试的原始证据',
	'',
	'仓库里不放原始证据：`eval/evidence/` 有一个多 G，还都是日志和产物，放进 git 历史会让仓库永远这么大。',
	'证据按批次打包放在 GitHub Release 里，仓库里只留脚本、`eval/results.json`、结果文档和这份索引。',
	'',
	'## 怎么用',
	'',
	'```bash',
	'# 1. 从下表对应批次的 Release 下载包，放到仓库根目录',
	'# 2. 解压，会在 eval/evidence/ 下展开成原来的目录结构',
	`tar -xzf ${index.batches.at(-1)?.packages[0]?.name ?? '<批次>-terminal-bench.tar.gz'} -C .`,
	'',
	'# 3. 核对：文档里的数字能从这里重算出来',
	'node eval/terminal-bench/tools/verify-benchmarks.mjs',
	'node eval/terminal-bench/tools/verify-usage.mjs',
	'node eval/collect-results.mjs',
	'```',
	'',
	'## 批次',
	'',
	'| 批次 | 包 | 大小 | sha256 | 文件数 | 覆盖的运行 | 打包时的代码提交 |',
	'|---|---|---|---|---|---|---|',
	...index.batches.flatMap(entry => entry.packages.map(pkg => [
		`| ${entry.batch} | \`${pkg.name}\` | ${megabytes(pkg.size)} | \`${pkg.sha256}\` | ${pkg.files ?? '—'} |`,
		`${entry.runs.length} 个 | \`${entry.commit}\` |`,
	].join(' '))),
	'',
	'## 打过的码',
	'',
	'打包时把这些内容换成了占位符（原始证据不动）：',
	'',
	...secrets.map(secret => `- ${secret.name}：\`${secret.replace}\``),
	'',
	'## 每一行结果属于哪个批次',
	'',
	'| 运行目录 | 基准 | 题目 | agent | 结果 | 用时 | 批次 |',
	'|---|---|---|---|---|---|---|',
	...rows.map(row => {
		const score = row.bench === 'Terminal-Bench' ? row.reward.toFixed(2) : `${row.tests_passed}/${row.tests_total}`;
		return `| \`${runOf(row.evidence, row.bench)}\` | ${row.bench} | \`${row.task}\` | ${row.agent} | ${score} | ${Math.round(row.seconds)} 秒 | ${batchOf(runOf(row.evidence, row.bench))} |`;
	}),
	'',
];

writeFileSync(join(root, 'eval', 'EVIDENCE.md'), `${lines.join('\n')}\n`);
console.log('\n更新 eval/evidence-batches.json 和 EVIDENCE.md');
