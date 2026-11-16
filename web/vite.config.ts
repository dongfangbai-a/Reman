import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig, loadEnv } from 'vite';
import { defaultDataDirectory } from '../src/dataDirectory.ts';

/**
 * 开发时把 /v1 代理到运行时（默认端口 6001，HUMAN_RUNTIME_PORT 可改）。代理从运行时数据目录的 runtime.json
 * 读令牌并带上，数据目录和运行时一样默认，运行时用了 --data-dir 时用 HUMAN_DATA_DIR 指定（环境变量或 web/.env.local）。
 * 每个请求重新读，运行时重启后不用重启开发服务器。
 */
export default defineConfig(({ mode }) => {
	const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env };
	const dataDirectory = env['HUMAN_DATA_DIR'] || defaultDataDirectory();
	const token = () => (JSON.parse(readFileSync(join(dataDirectory, 'runtime.json'), 'utf8')) as { token: string }).token;
	return {
		plugins: [react(), tailwindcss()],
		// 代码高亮的 Worker 里按需加载语言，要能分块。
		worker: { format: 'es' },
		// 代码高亮的语言和引擎按需加载，单个比较大，不影响首屏。
		// 第三方库按包拆成几块：每块都在阈值以内，改应用代码时 vendor 块的缓存也不失效。
		build: {
			chunkSizeWarningLimit: 1000,
			rollupOptions: {
				output: {
					codeSplitting: {
						groups: [
							{ name: 'vendor-react', test: /node_modules[\\/](react|react-dom|scheduler|react-router|@tanstack)[\\/]/ },
							{ name: 'vendor-radix', test: /node_modules[\\/]@radix-ui[\\/]/ },
							{ name: 'vendor-markdown', test: /node_modules[\\/](react-markdown|remark-[^\\/]+|rehype-[^\\/]+|micromark[^\\/]*|mdast-[^\\/]+|unist-[^\\/]+|hast-[^\\/]+|unified|vfile[^\\/]*)[\\/]/ },
						],
					},
				},
			},
		},
		server: {
			proxy: {
				'/v1': {
					target: `http://127.0.0.1:${env['HUMAN_RUNTIME_PORT'] ?? 6001}`,
					configure: proxy => {
						proxy.on('proxyReq', request => request.setHeader('Authorization', `Bearer ${token()}`));
					},
				},
			},
		},
	};
});
