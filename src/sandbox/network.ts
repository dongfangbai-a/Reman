import { hostMatches, isLoopbackHost, parseBlockedHost } from '../browsers/blocklist.ts';
import { errorMessage } from '../common/errors.ts';
import type { ISandboxNetwork } from './sandboxState.ts';

export const ALLOW_ALL: ISandboxNetwork = { mode: 'all', hosts: [] };
/** 沙箱里被网络设置挡住的连接，srt 的记录里写这个原因，如 deny network-outbound example.com:443 (用户的设置不允许)。 */
export const NETWORK_DENIED = '用户的设置不允许';

/** 网页端或 sandbox.json 给的网络设置，整理成统一的样子；有一项不对时报错。 */
export function parseNetwork(value: unknown): ISandboxNetwork {
	if (value === 'all' || value === 'none') return { mode: value, hosts: [] };
	if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
		const keys = Object.keys(value);
		const key = keys[0];
		if (keys.length === 1 && (key === 'allow' || key === 'deny')) {
			const list = (value as Record<string, unknown>)[key];
			if (!Array.isArray(list) || !list.every(item => typeof item === 'string')) throw new Error(`network.${key} 必须是字符串数组`);
			return { mode: key, hosts: [...new Set(list.map(hostEntry))] };
		}
	}
	throw new Error('network 只能是 "all"、"none"、{ "allow": [主机名...] } 或 { "deny": [主机名...] }');
}

/** 写进 sandbox.json 的样子；全部允许时不写。 */
export function serializeNetwork(network: ISandboxNetwork): unknown {
	switch (network.mode) {
		case 'all': return undefined;
		case 'none': return 'none';
		case 'allow': return { allow: network.hosts };
		case 'deny': return { deny: network.hosts };
	}
}

/**
 * 沙箱里的命令能不能连这个地址。srt 给的是命令里写的主机名，先规范化（IP 的简写如 2852039166 换成 169.254.169.254），
 * 不然换个写法就绕过了名单。本机地址总是能连。
 */
export function networkAllows(network: ISandboxNetwork, host: string, port: number | undefined): boolean {
	if (network.mode === 'all') return true;
	const name = canonicalHost(host);
	if (name === undefined) return false;
	if (isLoopbackHost(name)) return true;
	if (network.mode === 'none') return false;
	const listed = network.hosts.some(text => {
		const entry = parseBlockedHost(text);
		return (entry.port === undefined || entry.port === port) && hostMatches(entry.host, name);
	});
	return network.mode === 'allow' ? listed : !listed;
}

function hostEntry(input: string): string {
	let entry;
	try {
		entry = parseBlockedHost(input);
	} catch (error) {
		throw new Error(`「${input}」格式有误：${errorMessage(error)}`);
	}
	if (isLoopbackHost(entry.host)) throw new Error(`「${input}」是本机地址，本机地址始终允许连接`);
	return entry.text;
}

function canonicalHost(host: string): string | undefined {
	const bracketed = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
	try {
		return new URL(`http://${bracketed}`).hostname.toLowerCase().replace(/\.$/, '') || undefined;
	} catch {
		return undefined;
	}
}
