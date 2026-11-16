import { api, ApiError } from './client.ts';

export type ConnectResult = 'ready' | 'unauthorized' | 'offline';

let exchange: Promise<void> | undefined;

/**
 * 连接运行时：地址里带了 #token=… 就先换成 Cookie，再把令牌从地址栏去掉；然后确认能访问接口。
 */
export async function connect(): Promise<ConnectResult> {
	const token = /(?:^#|&)token=([^&]+)/.exec(location.hash)?.[1];
	if (token) {
		history.replaceState(history.state, '', location.pathname + location.search);
		// 换不成功时按没有 Cookie 处理，下面会提示。
		exchange = api('POST', '/v1/session', undefined, { Authorization: `Bearer ${decodeURIComponent(token)}` }).then(() => undefined, () => undefined);
	}
	await exchange;
	try {
		await api('GET', '/v1/state');
		return 'ready';
	} catch (error) {
		return error instanceof ApiError && error.status === 401 ? 'unauthorized' : 'offline';
	}
}
