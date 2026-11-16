// 只放类型，前端也直接引用（tunnel.ts 用到 Node 的模块，前端检查不了）。

/** cloudflared 现在能不能用。downloading 的 receivedBytes 是已经下载的字节数。 */
export type CloudflaredState =
	| { readonly kind: 'missing' }
	| { readonly kind: 'downloading'; readonly receivedBytes: number; readonly totalBytes: number }
	| { readonly kind: 'ready'; readonly version: string; readonly path: string }
	/** 这个平台官方没有包，只能填已有的路径。 */
	| { readonly kind: 'unsupported'; readonly reason: string }
	| { readonly kind: 'failed'; readonly reason: string };

/** 隧道进程：starting 是已经起来、还没连上；connected 是 cloudflared 说已经连上 Cloudflare 的边缘。 */
export type TunnelProcessKind = 'off' | 'starting' | 'connected' | 'error';

/** 给网页端的「公网访问」状态。 */
export interface IRemoteStatus {
	readonly enabled: boolean;
	readonly hostname: string | null;
	/** 隧道之外还接受的域名（Tailscale serve 的 ts.net 域名之类），和隧道开关无关。 */
	readonly hostnames: readonly string[];
	/** 隧道 token 的末四位，用来确认填的是哪一个；没填时 null。token 本身不回显。 */
	readonly tokenTail: string | null;
	/** 用户填的已有的 cloudflared 路径。 */
	readonly cloudflaredPath: string | null;
	readonly cloudflared: CloudflaredState;
	readonly process: { readonly kind: TunnelProcessKind; readonly error: string | null };
	/** 在 Cloudflare 后台的 Public Hostname 里要填的服务地址。 */
	readonly origin: string;
	/** 上次真的连上时用的服务地址：和现在的不一样说明端口或域名改过，后台也要改。 */
	readonly lastOrigin: string | null;
}
