import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './App.tsx';
import './index.css';
import { trackDevicePixel } from './lib/devicePixel.ts';
import { ErrorBoundary } from './ui/ErrorBoundary.tsx';

const queryClient = new QueryClient({
	defaultOptions: {
		// 数据靠运行时的事件刷新，不靠定时和窗口聚焦。
		queries: { staleTime: Infinity, refetchOnWindowFocus: false, retry: 1 },
	},
});

trackDevicePixel();

createRoot(document.getElementById('root')!).render(
	<StrictMode>
		<QueryClientProvider client={queryClient}>
			<BrowserRouter>
				<ErrorBoundary>
					<App />
				</ErrorBoundary>
			</BrowserRouter>
		</QueryClientProvider>
	</StrictMode>,
);
