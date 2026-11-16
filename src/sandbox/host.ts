/**
 * 沙箱进程：一个工作目录一个，在里面开一个 srt 会话（srt 的配置一个进程只有一份，可写目录在会话开始时定好）。
 * 从运行时收命令（IPC），在沙箱里执行，把输出和结果发回去。运行时断开时退出，沙箱里的命令随会话一起结束。见 sandbox.ts。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { SandboxManager, type SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import { errorMessage } from '../common/errors.ts';
import { killProcessTree } from '../common/process.ts';
import { ALLOW_ALL, NETWORK_DENIED, networkAllows } from './network.ts';
import type { HostMessage, HostRequest } from './protocol.ts';
import type { ISandboxNetwork } from './sandboxState.ts';

const running = new Map<string, ChildProcess>();
let network: ISandboxNetwork = ALLOW_ALL;

function send(message: HostMessage): void {
	process.send?.(message);
}

process.on('message', (request: HostRequest) => {
	switch (request.type) {
		case 'init':
			network = request.network;
			void initialize(request.config);
			break;
		case 'network':
			network = request.network;
			break;
		case 'run':
			void run(request);
			break;
		case 'kill': {
			const child = running.get(request.id);
			if (child) killProcessTree(child);
			break;
		}
	}
});

process.on('disconnect', () => {
	for (const child of running.values()) killProcessTree(child);
	void SandboxManager.reset().finally(() => process.exit(0));
});

/** srt 的允许名单不接受 *，所以名单留空，每个连接都问回调，按当前的网络设置回答。 */
async function initialize(config: SandboxRuntimeConfig): Promise<void> {
	try {
		await SandboxManager.initialize(config, async ({ host, port }) => networkAllows(network, host, port) || { allow: false, reason: NETWORK_DENIED });
		send({ type: 'ready' });
	} catch (error) {
		send({ type: 'initFailed', error: mask(errorMessage(error)) });
	}
}

async function run(request: Extract<HostRequest, { type: 'run' }>): Promise<void> {
	const { id, command, cwd, shell, denyWrite } = request;
	const finished = (exitCode: number | null, signal: string | null, error?: string) => {
		running.delete(id);
		const violations = SandboxManager.getSandboxViolationStore().getViolationsForCommand(id).map(violation => mask(violation.line));
		SandboxManager.cleanupAfterCommand();
		send({ type: 'exit', id, exitCode, signal, violations, ...error !== undefined && { error } });
	};
	let wrapped: { argv: string[]; env: NodeJS.ProcessEnv };
	try {
		const custom = denyWrite.length ? { filesystem: { denyWrite: [...denyWrite] } } as Partial<SandboxRuntimeConfig> : undefined;
		const binShell = process.platform === 'win32' ? { exe: shell, args: ['-c'] } : shell;
		wrapped = await SandboxManager.wrapWithSandboxArgv(command, binShell, custom, undefined, cwd, { commandId: id });
	} catch (error) {
		finished(null, null, mask(errorMessage(error)));
		return;
	}
	const child = spawn(wrapped.argv[0]!, wrapped.argv.slice(1), {
		cwd, env: wrapped.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32',
	});
	running.set(id, child);
	for (const stream of [child.stdout!, child.stderr!]) {
		const decoder = new TextDecoder();
		const forward = (text: string) => text && send({ type: 'output', id, text: mask(text) });
		stream.on('data', (chunk: Buffer) => forward(decoder.decode(chunk, { stream: true })));
		stream.on('end', () => forward(decoder.decode()));
	}
	let done = false;
	const finish = (exitCode: number | null, signal: string | null, error?: string) => {
		if (done) return;
		done = true;
		finished(exitCode, signal, error);
	};
	child.on('error', error => finish(null, null, error.message));
	child.on('close', (code, signal) => finish(code, signal));
	// 放到后台的子进程可能一直占着输出管道；命令本身退出后最多再等一会儿。
	child.on('exit', (code, signal) => setTimeout(() => {
		if (done) return;
		child.stdout!.destroy();
		child.stderr!.destroy();
		finish(code, signal);
	}, 2000).unref());
}

/** 输出里不出现 srt 代理的令牌。 */
function mask(text: string): string {
	const token = SandboxManager.getProxyAuthToken();
	if (!token) return text;
	return [token, encodeURIComponent(token)].reduce((result, form) => result.split(form).join('***'), text);
}
