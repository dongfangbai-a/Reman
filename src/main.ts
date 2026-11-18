import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Secrets } from './common/secrets.ts';
import { defaultDataDirectory, runtimeDirectories } from './dataDirectory.ts';
import { DataDirectoryLock } from './database/lock.ts';
import { ModelConfig } from './models/config.ts';
import { Runtime } from './runtime.ts';
import { RuntimeServer } from './server/server.ts';

/** 前端读这个文件找到运行时：端口、访问令牌。 */
const CONNECTION_FILE = 'runtime.json';
/** 访问令牌存在这里，重启后沿用，网页端的 Cookie 和收藏的链接才不会失效。 */
const TOKEN_FILE = 'access-token';
/** 加密配置里密钥的钥匙，第一次启动时生成。 */
const SECRET_KEY_FILE = 'secret-key';
const DEFAULT_PORT = 6001;
/** 网页端的构建结果。 */
const WEB_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'dist');

async function main(): Promise<void> {
	const { values } = parseArgs({ options: { 'data-dir': { type: 'string' }, port: { type: 'string' } } });
	const dataDirectory = values['data-dir'] ? resolve(values['data-dir']) : defaultDataDirectory();
	mkdirSync(dataDirectory, { recursive: true });
	const lock = await DataDirectoryLock.acquire(dataDirectory);
	const directories = runtimeDirectories(dataDirectory);
	mkdirSync(directories.eventRoutesDirectory, { recursive: true });
	const secrets = Secrets.fromFile(join(dataDirectory, SECRET_KEY_FILE));
	const models = ModelConfig.fromFile(join(dataDirectory, 'models.json'), secrets);
	models.encryptKeys();
	const token = accessToken(join(dataDirectory, TOKEN_FILE));
	const runtime = new Runtime(join(dataDirectory, 'runtime.sqlite'), {
		dataDirectory,
		...directories,
		models,
		secrets,
		toolDefaultsPath: join(dataDirectory, 'tool-defaults.json'),
		skillDefaultsPath: join(dataDirectory, 'skill-defaults.json'),
		browserBlocklistPath: join(dataDirectory, 'browser-blocklist.json'),
		mcpPath: join(dataDirectory, 'mcp.json'),
		customToolsConfigPath: join(dataDirectory, 'custom-tools.json'),
		sandboxSettingsPath: join(dataDirectory, 'sandbox.json'),
		terminalSettingsPath: join(dataDirectory, 'terminals.json'),
		remoteSettingsPath: join(dataDirectory, 'remote.json'),
		cloudflaredDirectory: join(dataDirectory, 'cloudflared'),
		accessToken: token,
	});
	runtime.memberFolders.watch();
	runtime.skills.watch();
	runtime.mcp.watch();
	runtime.customTools.watch();
	runtime.external.watch();
	const server = new RuntimeServer(runtime, token, WEB_DIRECTORY);
	let port: number;
	try {
		port = await server.listen(values.port ? Number(values.port) : DEFAULT_PORT);
	} catch (error) {
		// 端口被占这类：已经启动的 MCP 服务器、事件来源要关掉再退出。
		await runtime.close();
		throw error;
	}
	const connectionFile = join(dataDirectory, CONNECTION_FILE);
	writeFileSync(connectionFile, JSON.stringify({ port, token, pid: process.pid, startedAt: Date.now() }, null, '\t'), { mode: 0o600 });
	runtime.runs.start();
	runtime.reminders.start();
	void runtime.tunnel.sync();
	console.log(`Reman Runtime 已启动，数据目录 ${dataDirectory}`);
	console.log(`在浏览器里打开: http://127.0.0.1:${port}/#token=${token}`);

	// 任何退出的路径都尽量把锁放开（进程被强杀时由系统放）。
	process.on('exit', () => lock.release());

	let stopping = false;
	const stop = async () => {
		if (stopping) return;
		stopping = true;
		rmSync(connectionFile, { force: true });
		await server.close();
		await runtime.close();
		lock.release();
		process.exit(0);
	};
	process.on('SIGINT', () => void stop());
	process.on('SIGTERM', () => void stop());
}

/** 读取保存的访问令牌；没有时生成一个并保存。 */
function accessToken(path: string): string {
	if (existsSync(path)) {
		const saved = readFileSync(path, 'utf8').trim();
		if (saved) return saved;
	}
	const token = randomBytes(32).toString('base64url');
	writeFileSync(path, token, { mode: 0o600 });
	return token;
}

main().catch(error => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
