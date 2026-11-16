import { useConnection } from '../api/events.ts';

export function ConnectionBanner() {
	const connected = useConnection(state => state.connected);
	if (connected) return null;
	return <div className="bg-danger-soft px-4 py-1.5 text-center text-[13px] text-danger">与运行时的连接已断开，正在重新连接…</div>;
}
