import * as RadixSelect from '@radix-ui/react-select';
import clsx from 'clsx';
import { Check, ChevronDown } from 'lucide-react';
import { Fragment, type ReactNode } from 'react';

export interface ISelectOption {
	readonly value: string;
	readonly label: ReactNode;
	/** 列表里写在名字下面的一句小字说明；选中后框里只显示名字。 */
	readonly description?: string;
}

export interface ISelectGroup {
	readonly group: string;
	readonly options: readonly ISelectOption[];
}

/** Radix 不允许选项的值是空字符串，空值在内部换成它。 */
const EMPTY = '\u0000';
const encode = (value: string) => value === '' ? EMPTY : value;
const decode = (value: string) => value === EMPTY ? '' : value;

/**
 * 下拉选择：和输入框一样的外观，弹出的列表是圆角浮层，深浅色都跟着主题。
 * size 为 sm 时用在列表行里（例如工具的审批方式）。
 */
export function Select({ value, onChange, options, label, title, placeholder, disabled, size = 'md', className }: {
	value: string;
	onChange: (value: string) => void;
	/** 分组后面跟着单独的选项时，中间画一条分隔线。 */
	options: readonly (ISelectOption | ISelectGroup)[];
	/** 无障碍名称。 */
	label: string;
	title?: string;
	/** 值为空、又没有值为空的选项时框里写的灰字。 */
	placeholder?: string;
	disabled?: boolean;
	size?: 'sm' | 'md';
	className?: string;
}) {
	// Radix 的值是空字符串时显示 placeholder。
	const empty = placeholder !== undefined && value === '' && !options.some(option => 'group' in option ? option.options.some(item => item.value === '') : option.value === '');
	return (
		<RadixSelect.Root value={empty ? '' : encode(value)} onValueChange={next => onChange(decode(next))} disabled={disabled}>
			<RadixSelect.Trigger
				aria-label={label}
				title={title}
				// Radix 按下鼠标就打开。放在弹出框里时，打开会让弹出框换掉点外面的监听，这次按下没传到它，它以为还按在自己里面，
				// 之后点外面要多点一次才收起。拦下按下，Radix 改在松开（click）时打开（它对非鼠标的做法），按下就照常传到弹出框。
				onPointerDown={event => event.pointerType === 'mouse' && event.button === 0 && event.preventDefault()}
				className={clsx(
					'inline-flex min-w-0 items-center justify-between gap-1.5 rounded-md border border-line-strong bg-page text-left outline-none',
					'focus-visible:border-accent data-[state=open]:border-accent data-[placeholder]:text-fg-3 disabled:cursor-not-allowed disabled:opacity-50',
					size === 'sm' ? 'h-7 pl-2 pr-1.5 text-xs' : 'h-8 pl-2.5 pr-2 text-[13px]',
					className,
				)}
			>
				<span className="min-w-0 truncate"><RadixSelect.Value placeholder={placeholder} /></span>
				<RadixSelect.Icon className="shrink-0 text-fg-3"><ChevronDown size={size === 'sm' ? 13 : 15} /></RadixSelect.Icon>
			</RadixSelect.Trigger>
			<RadixSelect.Portal>
				<RadixSelect.Content
					position="popper"
					sideOffset={4}
					className="z-50 max-h-[min(var(--radix-select-content-available-height),20rem)] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-lg border border-line bg-raised shadow-lg"
				>
					<RadixSelect.Viewport className="p-1">
						{options.map((option, index) => {
							const previous = options[index - 1];
							return 'group' in option
								? (
									<RadixSelect.Group key={option.group}>
										<RadixSelect.Label className="px-2 pb-1 pt-2 text-xs text-fg-3">{option.group}</RadixSelect.Label>
										{option.options.map(item => <Item key={item.value} option={item} size={size} />)}
									</RadixSelect.Group>
								)
								: (
									<Fragment key={option.value}>
										{previous && 'group' in previous && <RadixSelect.Separator className="mx-1 my-1 h-px bg-line" />}
										<Item option={option} size={size} />
									</Fragment>
								);
						})}
					</RadixSelect.Viewport>
				</RadixSelect.Content>
			</RadixSelect.Portal>
		</RadixSelect.Root>
	);
}

function Item({ option, size }: { option: ISelectOption; size: 'sm' | 'md' }) {
	return (
		<RadixSelect.Item
			value={encode(option.value)}
			className={clsx(
				'relative flex cursor-default select-none flex-col items-start rounded-md py-1.5 pl-2 pr-7 outline-none',
				'data-[highlighted]:bg-hover data-[state=checked]:text-accent data-[disabled]:opacity-50',
				size === 'sm' ? 'text-xs' : 'text-[13px]',
			)}
		>
			<RadixSelect.ItemText>{option.label}</RadixSelect.ItemText>
			{option.description && <span className="mt-0.5 w-56 text-[11px] leading-snug text-fg-3">{option.description}</span>}
			<RadixSelect.ItemIndicator className="absolute right-2 top-2 inline-flex"><Check size={14} /></RadixSelect.ItemIndicator>
		</RadixSelect.Item>
	);
}
