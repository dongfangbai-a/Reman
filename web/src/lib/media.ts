import { useSyncExternalStore } from 'react';

function useMediaQuery(query: string): boolean {
	return useSyncExternalStore(
		onChange => {
			const list = window.matchMedia(query);
			list.addEventListener('change', onChange);
			return () => list.removeEventListener('change', onChange);
		},
		() => window.matchMedia(query).matches,
	);
}

/** 手机：768 以下，图标栏在底部，列表和内容一次只显示一个。和 Tailwind 的 md 断点一致。 */
const PHONE = '(max-width: 767.98px)';

export function useIsPhone(): boolean {
	return useMediaQuery(PHONE);
}

/** 现在是不是手机：在事件、effect 里读一次用，不跟着变。 */
export function isPhone(): boolean {
	return window.matchMedia(PHONE).matches;
}
