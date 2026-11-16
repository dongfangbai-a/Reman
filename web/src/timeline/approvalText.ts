import { useToolCatalog } from '../api/directory.ts';
import { firstLine } from '../lib/format.ts';
import { isRecord } from './ToolCard.tsx';

/** 工具的短名：内置工具用它的短说明（如「执行命令」，内置工具组里的按组里的工具找），MCP 工具写「MCP 工具」，都没有时写工具名。 */
export function useToolLabel(): (name: string) => string {
	const catalog = useToolCatalog();
	return name => catalog.data?.find(tool => tool.name === name)?.label
		?? catalog.data?.flatMap(tool => tool.groupTools).find(tool => tool.name === name)?.label
		?? (name.includes('__') ? 'MCP 工具' : name);
}

/** 终端的输入显示成看得见的样子：回车写 ⏎，Ctrl 组合键写成 ⌃C 这样。 */
export function showKeys(input: string): string {
	return input.replace(/\r\n|\r|\n/g, '⏎\n').replace(/\n$/, '').replace(/[\x00-\x08\x0B-\x1F\x7F]/g, char => {
		const code = char.charCodeAt(0);
		if (code === 0x1b) return '⎋';
		if (code === 0x7f) return '⌫';
		if (code >= 1 && code <= 26) return `⌃${String.fromCharCode(64 + code)}`;
		return `\\x${code.toString(16).padStart(2, '0')}`;
	});
}

const BROWSER_ACTIONS: Record<string, string | undefined> = { click: '点击', type: '输入', press: '按键', select: '选择', evaluate: '执行脚本' };

/** 系统通知里写这次调用要做什么：一行纯文字。 */
export function approvalSubject(name: string, args: unknown): string {
	const record = isRecord(args) ? args : {};
	const text = (key: string) => typeof record[key] === 'string' ? record[key] : '';
	switch (name) {
		case 'shell':
			return clip(firstLine(text('command')));
		case 'terminal':
			return clip(firstLine(showKeys(text('input'))));
		case 'write_file':
		case 'edit_file':
			return clip(text('path'));
		case 'browser':
			return clip([BROWSER_ACTIONS[text('action')] ?? text('action'), text('element') || text('ref')].filter(Boolean).join(' '));
		default:
			return clip(Object.entries(record).filter(([, value]) => value !== undefined && value !== null && value !== '')
				.map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`).join(' · '));
	}
}

function clip(text: string): string {
	return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}
