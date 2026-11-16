// 只放类型，前端也直接引用（sandbox.ts 用到 Node 的模块，前端检查不了）。

/** 沙箱现在能不能用。installing 的 granting：用户已经在系统的窗口里允许了，正在授权沙箱读用户目录。 */
export type SandboxState =
	| { readonly kind: 'off' }
	| { readonly kind: 'checking' }
	| { readonly kind: 'installing'; readonly granting: boolean }
	| { readonly kind: 'uninstalling' }
	| { readonly kind: 'notInstalled' }
	| { readonly kind: 'ready' }
	| { readonly kind: 'unsupported'; readonly reason: string }
	| { readonly kind: 'failed'; readonly reason: string };

/** 沙箱里的命令能连哪些地址：全部允许、不允许、只允许名单里的、除了名单里的。名单是主机名或 IP，可以带端口。 */
export type SandboxNetworkMode = 'all' | 'none' | 'allow' | 'deny';
export interface ISandboxNetwork {
	readonly mode: SandboxNetworkMode;
	readonly hosts: readonly string[];
}

/** 给网页端的沙箱状态。 */
export interface ISandboxStatus {
	/** 用户打开了沙箱。 */
	readonly enabled: boolean;
	readonly state: SandboxState;
	/** Windows 上装好了，可以卸载。 */
	readonly installed: boolean;
	/** 成员的工作目录里放不进沙箱的，和原因。 */
	readonly problems: readonly { readonly directory: string; readonly reason: string }[];
	readonly network: ISandboxNetwork;
	/** sandbox.json 里的网络设置写错了：照不允许处理。 */
	readonly networkProblem: string | null;
}
