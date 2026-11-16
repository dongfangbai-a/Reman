import clsx from 'clsx';
import type { ReactNode } from 'react';
import type { IToolInfo, ToolPolicy } from '../api/types.ts';
import { Select } from '../ui/Select.tsx';
import { Switch } from '../ui/Switch.tsx';
import { POLICY_LABELS } from './aiForm.ts';

/** 可设置的工具，不含 MCP 服务器和自定义工具，按显示顺序：能设审批方式的在前，只能开关的放最后。 */
export function configurableTools(tools: readonly IToolInfo[]): IToolInfo[] {
	const configurable = tools.filter(tool => tool.configurable && tool.mcpServer === null && tool.customTool === null);
	return [...configurable.filter(tool => tool.policies.length > 0), ...configurable.filter(tool => tool.policies.length === 0)];
}

/** 有工具的 MCP 服务器，每个服务器是工具列表里的一项。没连上过、只推外部事件的服务器没有工具，开了也没用，不列。 */
export function mcpTools(tools: readonly IToolInfo[]): IToolInfo[] {
	return tools.filter(tool => tool.mcpServer !== null && !tool.withoutTools);
}

/** 自定义工具，每项是工具列表里的一项：内置的在前，然后是自己写的，两组各按名字排。 */
export function customTools(tools: readonly IToolInfo[]): IToolInfo[] {
	const items = tools.filter(tool => tool.customTool !== null);
	const rank = (tool: IToolInfo) => tool.customTool!.origin === 'builtin' ? 0 : 1;
	return items.sort((left, right) => rank(left) - rank(right) || left.customTool!.folder.localeCompare(right.customTool!.folder));
}

/** 自定义工具悬停看的内容：说明和它的工具。 */
export function customToolTitle(tool: IToolInfo): string {
	return [tool.description, '', '工具：', ...tool.groupTools.map(item => `- ${item.name}${item.label ? `：${item.label}` : ''}`)].join('\n');
}

/** 可设置的工具一行：开关、工具名和短说明（给模型的完整说明悬停显示）、审批方式（不用审批的工具没有）。成员页和设置页的默认设置共用。label 默认是工具名，tag 是名字后面的小标签，title 默认是给模型的说明，children 放在短说明后面。 */
export function ToolRow({ tool, label = tool.name, tag, title = tool.description, enabled, policy, disabled, onChange, children }: {
	tool: IToolInfo;
	label?: string;
	tag?: string;
	title?: string;
	enabled: boolean;
	policy: ToolPolicy;
	disabled?: boolean;
	onChange: (patch: { enabled?: boolean; policy?: ToolPolicy }) => void;
	children?: ReactNode;
}) {
	return (
		// 窄的时候（手机、窄对话框）换行：名字占一行，审批方式占一整行；宽的时候还是一行。
		// 外面的 @container 给里面判宽窄用：容器查询只看祖先，元素量不到自己。
		<div className="@container">
			<div className="flex h-10 flex-wrap items-center gap-x-3 gap-y-1.5 px-4 @max-[22rem]:h-auto @max-[22rem]:min-h-10 @max-[22rem]:py-1.5">
				<Switch checked={enabled} label={label} disabled={disabled} onChange={value => onChange({ enabled: value })} />
				<div className="flex min-w-[8rem] flex-1 flex-wrap items-baseline gap-x-2" title={title}>
					<span className={clsx('min-w-0 truncate font-mono text-[13px]', !enabled && 'text-fg-3')}>{label}</span>
					{tag && <span className="tag">{tag}</span>}
					{tool.label && <span className="min-w-0 truncate text-xs text-fg-3">{tool.label}</span>}
				</div>
				{children && <div className="flex shrink-0 items-center">{children}</div>}
				{tool.policies.length > 0 && <Select
					label={`${label} 的审批方式`}
					size="sm"
					value={policy}
					disabled={disabled || !enabled}
					onChange={value => onChange({ policy: value as ToolPolicy })}
					className="w-32 shrink-0 @max-[22rem]:order-last @max-[22rem]:w-full"
					options={tool.policies.map(item => item === 'auto' && tool.autoPolicy
						? { value: item, label: tool.autoPolicy.label, description: tool.autoPolicy.description }
						: item === 'allow' && tool.protectsData
							? { value: item, label: POLICY_LABELS[item], description: '修改运行时数据、读取令牌和密钥仍须审批' }
							: { value: item, label: POLICY_LABELS[item] })}
				/>}
			</div>
		</div>
	);
}
