import { existsSync, writeFileSync } from 'node:fs';
import { errorMessage, invalid } from '../common/errors.ts';
import { readJsonFile } from '../common/json.ts';

/** 禁止访问的网址，给网页端看。 */
export interface IBrowserBlocklist {
	/** 运行时网页端的地址，如 127.0.0.1:6001，总是禁止；还没监听时是 null。 */
	readonly runtime: string | null;
	/** 用户加的，主机名或 IP，可以带端口。 */
	readonly hosts: readonly string[];
}

interface IBlockedHost {
	readonly host: string;
	/** 不写端口时所有端口都禁止。 */
	readonly port?: number;
	/** 写回文件、给网页端看的样子，如 localhost:8888。 */
	readonly text: string;
}

const WEB_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:', 'ws:', 'wss:']);

/**
 * 成员的浏览器禁止访问的网址：运行时的网页端总是禁止，用户还可以加。用户加的存在 path（字符串列表），不给时只在内存里。
 * 每次请求都现查，改了立即生效。
 */
export class BrowserBlocklist {
	private readonly path: string | undefined;
	private readonly serverPort: () => number | undefined;
	private readonly onChange: () => void;
	private entries: readonly IBlockedHost[];

	constructor(path: string | undefined, serverPort: () => number | undefined, onChange: () => void = () => undefined) {
		this.path = path;
		this.serverPort = serverPort;
		this.onChange = onChange;
		this.entries = this.read();
	}

	snapshot(): IBrowserBlocklist {
		const port = this.serverPort();
		return { runtime: port === undefined ? null : `127.0.0.1:${port}`, hosts: this.entries.map(entry => entry.text) };
	}

	/** 整个替换用户加的；有一项不对时报错，什么都不改。 */
	set(hosts: unknown): void {
		if (!Array.isArray(hosts) || !hosts.every(host => typeof host === 'string')) throw invalid('hosts 必须是字符串数组');
		const entries = unique(hosts.map(host => {
			try {
				return parseBlockedHost(host);
			} catch (error) {
				throw invalid(`「${host}」格式有误：${errorMessage(error)}`);
			}
		}));
		if (this.path) writeFileSync(this.path, `${JSON.stringify(entries.map(entry => entry.text), null, '\t')}\n`);
		this.entries = entries;
		this.onChange();
	}

	/** 成员的浏览器不能访问这个网址时返回原因，如「用户禁止访问 example.com」。只管 http、https 和 WebSocket。 */
	reason(url: URL): string | undefined {
		if (!WEB_PROTOCOLS.has(url.protocol)) return undefined;
		if (isRuntimeAddress(url, this.serverPort())) return '不能打开运行时的网页端';
		const host = url.hostname.toLowerCase().replace(/\.$/, '');
		const port = Number(url.port || (url.protocol === 'https:' || url.protocol === 'wss:' ? 443 : 80));
		const entry = this.entries.find(entry => (entry.port === undefined || entry.port === port) && hostMatches(entry.host, host));
		return entry && `用户禁止访问 ${entry.text}`;
	}

	/** 读文件；没有文件时没有，写错的项跳过。 */
	private read(): IBlockedHost[] {
		if (!this.path || !existsSync(this.path)) return [];
		let parsed: unknown;
		try {
			parsed = readJsonFile(this.path);
		} catch (error) {
			console.warn(`浏览器禁止访问的网址读取失败，按空列表处理：${errorMessage(error)}`);
			return [];
		}
		if (!Array.isArray(parsed)) {
			console.warn('浏览器禁止访问的网址读取失败，按空列表处理：不是列表');
			return [];
		}
		const entries: IBlockedHost[] = [];
		for (const item of parsed) {
			try {
				entries.push(parseBlockedHost(String(item)));
			} catch (error) {
				console.warn(`浏览器禁止访问的网址跳过「${String(item)}」：${errorMessage(error)}`);
			}
		}
		return unique(entries);
	}
}

/**
 * 用户写的一项：主机名或 IP，可以带端口；也可以是整个网址，只取主机名和端口（网址里写了端口才带上）。
 * 统一成小写，中文域名转成 punycode。
 */
export function parseBlockedHost(input: string): IBlockedHost {
	const text = input.trim();
	if (!text) throw new Error('不能为空');
	if (text.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/?#]/)[0]!.includes('*')) throw new Error('不支持通配符，填写域名即包含其子域名');
	let host: string;
	let port: string;
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
		let url: URL;
		try {
			url = new URL(text);
		} catch {
			throw new Error('不是有效的网址');
		}
		({ hostname: host, port } = url);
	} else {
		// 只写了主机名：端口要自己取，new URL 会去掉 80 这种默认端口。
		const match = /^(\[[^\]]*\]|[^:/?#]*)(?::(\d*))?(?:[/?#].*)?$/.exec(text);
		if (!match) throw new Error('只填写主机名或 IP，可带端口，如 example.com、localhost:8888');
		port = match[2] ?? '';
		try {
			host = new URL(`http://${match[1]}`).hostname;
		} catch {
			throw new Error('主机名格式有误');
		}
	}
	host = host.toLowerCase().replace(/\.$/, '');
	if (!host) throw new Error('缺少主机名');
	if (isIpv4(host)) {
		// 网址解析会把简写（1.2.3、2852039166、带前导零的）换成别的地址，用户写的和存下的就对不上了。
		const written = text.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/?#]/)[0]!.replace(/^.*@/, '').replace(/:\d*$/, '').replace(/\.$/, '');
		if (written !== host) throw new Error('IP 地址须为 4 段数字，如 192.168.1.10');
	} else if (!host.startsWith('[') && host !== 'localhost' && !isDomain(host)) {
		throw new Error('不是有效的域名或 IP，如 example.com、192.168.1.10');
	}
	if (port !== '' && !(/^\d+$/.test(port) && Number(port) >= 1 && Number(port) <= 65535)) throw new Error('端口须在 1–65535 之间');
	return port === '' ? { host, text: host } : { host, port: Number(port), text: `${host}:${Number(port)}` };
}

/** 本机地址算同一个；IP 要完全一样；域名包括它的子域名。 */
export function hostMatches(blocked: string, host: string): boolean {
	if (isLoopbackHost(blocked) && isLoopbackHost(host)) return true;
	if (host === blocked) return true;
	return !blocked.startsWith('[') && !isIpv4(blocked) && host.endsWith(`.${blocked}`);
}

function isIpv4(host: string): boolean {
	return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

/** 至少两段，每段是字母、数字和中间的连字符，最后一段不全是数字。中文域名已经转成 punycode。 */
function isDomain(host: string): boolean {
	const labels = host.split('.');
	return labels.length >= 2 && labels.every(label => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) && !/^\d+$/.test(labels.at(-1)!);
}

function unique(entries: readonly IBlockedHost[]): IBlockedHost[] {
	return [...new Map(entries.map(entry => [entry.text, entry])).values()];
}

/** 会连到本机的主机名：localhost、*.localhost、127.*、[::1]，以及 0.0.0.0 和映射到 127.* 的 IPv6 地址。 */
export function isLoopbackHost(host: string): boolean {
	const name = host.toLowerCase();
	return name === 'localhost' || name.endsWith('.localhost') || /^127(\.\d{1,3}){3}$/.test(name) || name === '[::1]' || name === '0.0.0.0'
		|| name === '[::]' || /^\[::ffff:(127\.|7f[0-9a-f]{2}:)/.test(name);
}

/** 运行时自己的地址：本机、运行时监听的端口。 */
export function isRuntimeAddress(url: URL, port: number | undefined): boolean {
	if (port === undefined || !WEB_PROTOCOLS.has(url.protocol) || !isLoopbackHost(url.hostname)) return false;
	return Number(url.port || (url.protocol === 'https:' || url.protocol === 'wss:' ? 443 : 80)) === port;
}
