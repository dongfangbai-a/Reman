import { Button } from './Button.tsx';

/** 整页居中的一段提示，用于连接中、出错、空状态。 */
export function CenteredMessage({ title, detail, action }: { title: string; detail?: string; action?: { label: string; onClick: () => void } }) {
	return (
		<div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
			<div className="text-[15px] font-medium">{title}</div>
			{detail && <div className="max-w-md text-fg-2">{detail}</div>}
			{action && <Button className="mt-2" onClick={action.onClick}>{action.label}</Button>}
		</div>
	);
}
