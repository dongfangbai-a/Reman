/**
 * 固定的 cloudflared 版本，和 PortableGit 一样：只下载下面列出的文件，下载后核对大小和 SHA-256。
 * 官方不发布校验和文件，这些值是把 2026.10.7 的包各下载一遍算出来的。
 * 换版本时把整张表一起换掉。
 */
export const CLOUDFLARED_VERSION = '2026.10.7';

export interface ICloudflaredAsset {
	/** 发布页上的文件名。 */
	readonly file: string;
	readonly size: number;
	readonly sha256: string;
	/** macOS 发的是 tar.gz，里面是 cloudflared；Windows、Linux 是裸二进制。 */
	readonly archive: boolean;
}

const BASE = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}`;

const ASSETS: Readonly<Record<string, ICloudflaredAsset>> = {
	'win32-x64': { file: 'cloudflared-windows-amd64.exe', size: 55_390_512, sha256: '2493dbc168923bb3e59e5e7716f71deced92992eea9acd6e9d74f84ac7751343', archive: false },
	'darwin-x64': { file: 'cloudflared-darwin-amd64.tgz', size: 21_834_416, sha256: '02f3edfd87684dd5b705607688e4eb4b323f6e777b81e7b3a85af556aa356848', archive: true },
	'darwin-arm64': { file: 'cloudflared-darwin-arm64.tgz', size: 19_847_161, sha256: '3586ccf397e98e5f437e60e7c307ca6ac463e110580503af8bb8e6f9ebf831bd', archive: true },
	'linux-x64': { file: 'cloudflared-linux-amd64', size: 40_274_445, sha256: '1f99fb518b83dec2ba8d870a7cc991d82a77e6196295a3d2754ba17ab9f91872', archive: false },
	'linux-arm64': { file: 'cloudflared-linux-arm64', size: 37_667_293, sha256: '3df43aedc9ff291d1735b5cb576cb97e0b157488796db2e32b28aecabb445775', archive: false },
};

/** 这个平台和架构对应的包；官方没有时 undefined，只能填已有的路径。 */
export function cloudflaredAsset(platform: NodeJS.Platform = process.platform, arch: string = process.arch): ICloudflaredAsset | undefined {
	return ASSETS[`${platform}-${arch}`];
}

export function cloudflaredUrl(asset: ICloudflaredAsset): string {
	return `${BASE}/${asset.file}`;
}

/** 下载后存成的名字：Windows 带 .exe，其他平台就是 cloudflared（macOS 的包里也是这个名字）。 */
export function cloudflaredFileName(platform: NodeJS.Platform = process.platform): string {
	return platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
}
