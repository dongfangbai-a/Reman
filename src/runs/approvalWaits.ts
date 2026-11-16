/**
 * 一次运行里只在等审批的时间：正在执行的工具调用全都在等审批时计时（脚本里的调用在等，也算它所属的调用在等）。
 * 同时还有别的调用在执行时不算，那段时间运行还在干活。运行用时减掉它。
 */
export class ApprovalWaits {
	/** 正在执行的调用，各有几处在等审批。 */
	private readonly calls = new Set<{ waits: number }>();
	private since: number | undefined;
	private total = 0;

	private readonly now: () => number;

	constructor(now: () => number = Date.now) {
		this.now = now;
	}

	/** 一次调用开始执行。wait 在等审批时调用，返回等完时调用的函数；调用结束时调用 end。 */
	start(): { readonly wait: () => () => void; readonly end: () => void } {
		const call = { waits: 0 };
		this.calls.add(call);
		this.update();
		return {
			wait: () => {
				if (!this.calls.has(call)) return () => {};
				call.waits++;
				this.update();
				let done = false;
				return () => {
					if (done) return;
					done = true;
					call.waits--;
					this.update();
				};
			},
			end: () => {
				this.calls.delete(call);
				this.update();
			},
		};
	}

	/** 到现在为止只在等审批的毫秒数。 */
	waitedMs(): number {
		return this.total + (this.since === undefined ? 0 : this.now() - this.since);
	}

	private update(): void {
		const stalled = this.calls.size > 0 && [...this.calls].every(call => call.waits > 0);
		if (stalled && this.since === undefined) {
			this.since = this.now();
		} else if (!stalled && this.since !== undefined) {
			this.total += this.now() - this.since;
			this.since = undefined;
		}
	}
}
