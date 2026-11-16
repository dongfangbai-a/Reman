/**
 * 只计执行时间的时钟：等用户审批时暂停。用于「执行多久转后台」和 run_tool_script 的超时，
 * 这两个都不应该把等审批的时间算进去。
 */
export class ExecutionClock {
	private elapsedBefore = 0;
	private runningSince: number | undefined = Date.now();
	private pauses = 0;
	private readonly listeners = new Set<() => void>();

	/** 已经执行了多少毫秒（不含暂停的时间）。 */
	elapsed(): number {
		return this.elapsedBefore + (this.runningSince === undefined ? 0 : Date.now() - this.runningSince);
	}

	/** 暂停计时，返回恢复的函数。可以同时有多处暂停，全部恢复后才继续计时。 */
	pause(): () => void {
		if (this.pauses++ === 0 && this.runningSince !== undefined) {
			this.elapsedBefore += Date.now() - this.runningSince;
			this.runningSince = undefined;
			this.notify();
		}
		let resumed = false;
		return () => {
			if (resumed) return;
			resumed = true;
			if (--this.pauses === 0) {
				this.runningSince = Date.now();
				this.notify();
			}
		};
	}

	/** 执行时间达到 ms 时完成；signal 触发时不再等（不报错，直接完成）。 */
	async after(ms: number, signal: AbortSignal): Promise<void> {
		while (!signal.aborted) {
			const remaining = ms - this.elapsed();
			if (remaining <= 0) return;
			await new Promise<void>(resolve => {
				const done = () => {
					clearTimeout(timer);
					this.listeners.delete(done);
					signal.removeEventListener('abort', done);
					resolve();
				};
				// 暂停时只等状态变化；计时中就等到剩余时间，或者中途被暂停。
				const timer = this.runningSince === undefined ? undefined : setTimeout(done, remaining);
				this.listeners.add(done);
				signal.addEventListener('abort', done, { once: true });
			});
		}
	}

	private notify(): void {
		for (const listener of [...this.listeners]) listener();
	}
}
