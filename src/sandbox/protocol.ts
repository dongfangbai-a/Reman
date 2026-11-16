import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import type { ISandboxNetwork } from './sandboxState.ts';

/** 运行时发给沙箱进程的。 */
export type HostRequest =
	| { readonly type: 'init'; readonly config: SandboxRuntimeConfig; readonly network: ISandboxNetwork }
	/** 网络设置改了，之后的连接按新的。 */
	| { readonly type: 'network'; readonly network: ISandboxNetwork }
	/** shell 是 bash 的绝对路径；denyWrite 是这条命令额外禁止写的地方（仓库的钩子和配置）。 */
	| { readonly type: 'run'; readonly id: string; readonly command: string; readonly cwd: string; readonly shell: string; readonly denyWrite: readonly string[] }
	| { readonly type: 'kill'; readonly id: string };

/** 沙箱进程发回运行时的。 */
export type HostMessage =
	| { readonly type: 'ready' }
	| { readonly type: 'initFailed'; readonly error: string }
	| { readonly type: 'output'; readonly id: string; readonly text: string }
	/** 命令结束。error：没能启动；violations：srt 记下的被挡记录（Windows 上只有网络的）。 */
	| { readonly type: 'exit'; readonly id: string; readonly exitCode: number | null; readonly signal: string | null; readonly violations: readonly string[]; readonly error?: string };
