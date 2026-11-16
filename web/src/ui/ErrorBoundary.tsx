import { Component, type ErrorInfo, type ReactNode } from 'react';
import { errorMessage } from '../lib/errors.ts';
import { CenteredMessage } from './CenteredMessage.tsx';

/** 按需加载的代码没取到：网页端重新构建过、旧页面要的文件没了，或者连不上运行时。 */
class CodeLoadError extends Error {}

/** 按需加载代码（import()）；取不到时报 CodeLoadError，出错提示据此让用户重新加载页面，不显示浏览器的原始报错。 */
export function loadCode<T>(load: () => Promise<T>): Promise<T> {
	return load().catch((error: unknown) => {
		throw new CodeLoadError(errorMessage(error), { cause: error });
	});
}

const RELOAD = { label: '重新加载', onClick: () => location.reload() };

/**
 * 里面的代码出错时显示提示，不整页空白。默认是「页面出错了」和「重新加载」；只坏一块、重新加载还会再坏的（比如工作台的一个标签）
 * 给自己的 title 和 action。代码没加载到时总是让重新加载。className 给提示外面包一层，用在 flex 布局里。
 */
export class ErrorBoundary extends Component<{ children: ReactNode; title?: string; action?: { label: string; onClick: () => void }; className?: string }, { error: Error | undefined }> {
	override state: { error: Error | undefined } = { error: undefined };

	static getDerivedStateFromError(error: Error) {
		return { error };
	}

	override componentDidCatch(error: Error, info: ErrorInfo): void {
		console.error(error, info.componentStack);
	}

	override render(): ReactNode {
		const { error } = this.state;
		if (!error) return this.props.children;
		const message = error instanceof CodeLoadError
			? <CenteredMessage title="未能加载该部分代码" detail="网页端可能已更新，或无法连接运行时。请尝试重新加载页面。" action={RELOAD} />
			: <CenteredMessage title={this.props.title ?? '页面出错'} detail={error.message} action={this.props.action ?? RELOAD} />;
		return this.props.className ? <div className={this.props.className}>{message}</div> : message;
	}
}
