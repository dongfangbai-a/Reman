import clsx from 'clsx';
import { FolderOpen } from 'lucide-react';
import { useState } from 'react';
import { IconButton } from './Button.tsx';
import { INPUT_CLASS } from './Dialog.tsx';
import { DirectoryPicker } from './DirectoryPicker.tsx';

/** 目录输入框：可以直接输入绝对路径，也可以点右边的文件夹图标选。选目录时从输入框里的路径开始，没有时从用户目录开始。 */
export function DirectoryInput({ value, onChange, label, placeholder, pickerTitle, className }: {
	value: string;
	onChange: (value: string) => void;
	label: string;
	placeholder: string;
	pickerTitle: string;
	className?: string;
}) {
	const [picking, setPicking] = useState(false);
	return (
		<div className="relative">
			<input
				aria-label={label}
				value={value}
				onChange={event => onChange(event.target.value)}
				placeholder={placeholder}
				title="运行时所在机器上的绝对路径"
				className={clsx(INPUT_CLASS, 'pr-9', className)}
			/>
			<IconButton label="选择目录" onClick={() => setPicking(true)} className="absolute right-0 top-0"><FolderOpen size={15} /></IconButton>
			{picking && (
				<DirectoryPicker
					title={pickerTitle}
					initial={value}
					onClose={() => setPicking(false)}
					onSelect={path => {
						onChange(path);
						setPicking(false);
					}}
				/>
			)}
		</div>
	);
}
