/**
 * 把一个设备像素等于多少 CSS 像素写进 --device-px（如 150% 缩放时约 0.667px）。
 * 居中的内容列用它把左边距取整到设备像素（见 index.css 的 center-column）。
 * 拖到缩放比例不同的屏幕上、改了系统或浏览器的缩放时跟着更新。
 */
export function trackDevicePixel(): void {
	const update = () => {
		const ratio = window.devicePixelRatio || 1;
		document.documentElement.style.setProperty('--device-px', `${1 / ratio}px`);
		window.matchMedia(`(resolution: ${ratio}dppx)`).addEventListener('change', update, { once: true });
	};
	update();
}
