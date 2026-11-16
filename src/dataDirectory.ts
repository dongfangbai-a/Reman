import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * 不写 --data-dir 时的数据目录。放本机的应用数据目录，不放会随账户同步的地方：数据库和成员的工作目录可能很大。
 * 网页端的开发服务器也用它找运行时，所以单独放一个文件。
 */
export function defaultDataDirectory(): string {
	if (process.platform === 'win32') return join(process.env['LOCALAPPDATA'] || join(homedir(), 'AppData', 'Local'), 'Reman');
	if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Reman');
	return join(process.env['XDG_DATA_HOME'] || join(homedir(), '.local', 'share'), 'reman');
}

/** 数据目录下运行时用的各个子目录。测试和脚本也用它，把这些目录都放进自己的临时目录。 */
export function runtimeDirectories(dataDirectory: string) {
	return {
		membersDirectory: join(dataDirectory, 'members'),
		skillsDirectory: join(dataDirectory, 'skills'),
		resourcesDirectory: join(dataDirectory, 'resources'),
		workspacesDirectory: join(dataDirectory, 'workspaces'),
		browsersDirectory: join(dataDirectory, 'browsers'),
		eventRoutesDirectory: join(dataDirectory, 'event-routes'),
		customToolsDirectory: join(dataDirectory, 'custom-tools'),
		toolOutputsDirectory: join(dataDirectory, 'tool-outputs'),
		eventLogsDirectory: join(dataDirectory, 'event-logs'),
		sourcesDirectory: join(dataDirectory, 'sources'),
	};
}
