import { useEffect, useState } from 'react';

/**
 * 复制文字，返回是否复制成功。安全上下文（localhost、127.0.0.1、https）里用剪贴板接口；
 * 用 http 打开局域网地址时浏览器不给用，换成旧的 execCommand('copy')，它要在点击里同步调用。
 */
export async function copyText(text: string): Promise<boolean> {
	if (!window.isSecureContext || !navigator.clipboard) return legacyCopy(text);
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		return legacyCopy(text);
	}
}

/** 选中一个临时文本框里的文字再复制。文本框放在当前焦点旁边：弹窗会把焦点锁在自己里面，放在 body 上选不中。 */
function legacyCopy(text: string): boolean {
	const active = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : undefined;
	const textarea = document.createElement('textarea');
	textarea.value = text;
	textarea.readOnly = true;
	textarea.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
	(active?.parentElement ?? document.body).append(textarea);
	textarea.select();
	let copied = false;
	try {
		copied = document.execCommand('copy');
	} catch {
		copied = false;
	}
	textarea.remove();
	active?.focus({ preventScroll: true });
	return copied;
}

/** 点击复制的按钮用：复制后 state 短暂是 copied 或 failed，再回到 idle。 */
export function useCopy(): { readonly state: 'idle' | 'copied' | 'failed'; readonly copy: (text: string) => void } {
	const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
	useEffect(() => {
		if (state === 'idle') return;
		const timer = window.setTimeout(() => setState('idle'), 1500);
		return () => window.clearTimeout(timer);
	}, [state]);
	return { state, copy: text => void copyText(text).then(copied => setState(copied ? 'copied' : 'failed')) };
}
