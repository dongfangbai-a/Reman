/**
 * 卸载 Windows 上的沙箱。srt 只有同步的卸载，要等用户在系统的窗口里允许，再清掉给沙箱账户的授权（要走一遍用户目录），
 * 可能好几分钟，所以放到子进程里，免得卡住运行时。结果用 IPC 发回去。
 */
import { VENDORED_SRT_WIN_EXE, resolveSrtWin, uninstallWindowsSandbox } from '@anthropic-ai/sandbox-runtime';
import { errorMessage } from '../common/errors.ts';

try {
	const result = uninstallWindowsSandbox({ srtWin: resolveSrtWin({ path: VENDORED_SRT_WIN_EXE }) });
	process.send?.({ cancelled: result.cancelled === true });
} catch (error) {
	process.send?.({ error: errorMessage(error) });
}
process.disconnect?.();
