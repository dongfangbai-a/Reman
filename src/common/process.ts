import { spawn, type ChildProcess } from 'node:child_process';

/**
 * 结束进程和它启动的全部子进程。
 *
 * Windows 上靠 taskkill 连子进程一起结束。taskkill 本身也可能起不来或被拒（装了杀软、在沙箱里跑）：
 * 这时至少结束直接子进程，不留一个没人管的进程在后面跑——命令看起来已经取消，其实还在占着资源。
 */
export function killProcessTree(child: ChildProcess): void {
	if (child.pid === undefined || child.exitCode !== null) return;
	if (process.platform === 'win32') {
		try {
			const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
			killer.on('error', () => child.kill());
			// 退出码不是 0：没结束掉（被拒绝或没找到），回退到只结束直接子进程。taskkill 成功时子进程也
			// 已经被要求结束，这里多调一次 kill 没有副作用。
			killer.on('exit', code => {
				if (code !== 0) child.kill();
			});
		} catch {
			child.kill();
		}
	} else {
		try {
			process.kill(-child.pid, 'SIGKILL');
		} catch {
			child.kill('SIGKILL');
		}
	}
}
