// 只放类型，前端也直接引用（portableGit.ts 用到 Node 的流，前端检查不了）。

/** PortableGit 的安装状态。 */
export type PortableGitState =
	| { readonly kind: 'unsupported' }
	| { readonly kind: 'notInstalled' }
	| { readonly kind: 'downloading'; readonly source: string; readonly receivedBytes: number; readonly totalBytes: number }
	| { readonly kind: 'verifying' }
	| { readonly kind: 'extracting' }
	| { readonly kind: 'installed'; readonly bashPath: string }
	| { readonly kind: 'failed'; readonly error: string };
