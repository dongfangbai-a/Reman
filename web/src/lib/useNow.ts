import { useEffect, useState } from 'react';

/** 当前时间，enabled 时每秒更新：显示已经过了多久、还剩多久。 */
export function useNow(enabled = true): number {
	const [now, setNow] = useState(Date.now);
	useEffect(() => {
		if (!enabled) return;
		setNow(Date.now());
		const timer = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, [enabled]);
	return now;
}
