import { spawn, type ChildProcess } from 'node:child_process';

/** 结束进程和它启动的全部子进程。 */
export function killProcessTree(child: ChildProcess): void {
	if (child.pid === undefined || child.exitCode !== null) return;
	if (process.platform === 'win32') {
		spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true }).on('error', () => child.kill());
	} else {
		try {
			process.kill(-child.pid, 'SIGKILL');
		} catch {
			child.kill('SIGKILL');
		}
	}
}
