import clsx from 'clsx';
import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';
import { useMembers } from '../api/queries.ts';
import { useRuntimePlatform } from '../api/system.ts';
import { toolFilePath } from './paths.ts';
import { openFile } from './tabs.ts';

/** 本机文件内容的地址；download 为 true 时作为附件下载。 */
export function fileContentUrl(path: string, options: { download?: boolean; version?: number } = {}): string {
	const query = new URLSearchParams({ path });
	if (options.download) query.set('download', '1');
	if (options.version !== undefined) query.set('v', String(options.version));
	return `/v1/files/content?${query}`;
}

/**
 * 点开在工作台里预览的文件路径。可能放在别的按钮里（工具卡片的第一行），所以不用 button，点击也不往外传。
 * variant：link 和普通链接一样；path 是虚下划线，和普通链接区分（行内代码、工具卡片上的路径）。
 */
export function FileLink({ path, variant = 'path', className, children }: { path: string; variant?: 'link' | 'path'; className?: string; children: ReactNode }) {
	const open = (event: MouseEvent | KeyboardEvent) => {
		event.preventDefault();
		event.stopPropagation();
		openFile(path);
	};
	return (
		<span
			role="link"
			tabIndex={0}
			title={path}
			onClick={open}
			onKeyDown={event => event.key === 'Enter' && open(event)}
			className={clsx(
				'cursor-pointer',
				variant === 'link' ? 'text-accent underline underline-offset-2' : 'underline decoration-fg-3 decoration-dotted underline-offset-4 hover:text-accent hover:decoration-accent',
				className,
			)}
		>
			{children}
		</span>
	);
}

/**
 * 工具参数里的文件路径：算得出完整路径时做成可以点开的，相对路径按这个成员现在的工作目录算（和执行工具时一样），
 * 悬停看完整路径；算不出来时照原样显示。
 */
export function ToolFileLink({ memberId, path, children }: { memberId: string; path: string; children: ReactNode }) {
	const platform = useRuntimePlatform();
	const member = useMembers().data?.find(item => item.memberId === memberId);
	const full = toolFilePath(path, member ? member.workingDirectory ?? member.defaultWorkingDirectory ?? undefined : undefined, platform);
	return full ? <FileLink path={full}>{children}</FileLink> : <>{children}</>;
}
