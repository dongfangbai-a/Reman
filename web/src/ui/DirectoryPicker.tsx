import { ArrowUp, Folder, HardDrive, House } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useDirectories } from '../api/system.ts';
import { Button, IconButton } from './Button.tsx';
import { Dialog } from './Dialog.tsx';

/** 看起来像绝对路径：盘符、斜杠或网络路径开头。真正的判断在运行时。 */
const ABSOLUTE = /^([a-zA-Z]:[\\/]|[\\/])/;

/**
 * 浏览运行时所在机器的目录，选一个目录（默认用来选工作目录）。
 * initial 是绝对路径时从那里开始，否则从用户目录开始；path 为 null 时显示用户目录和各个盘符。
 */
export function DirectoryPicker({ initial, onSelect, onClose, title = '选择工作目录' }: { initial: string; onSelect: (path: string) => void; onClose: () => void; title?: string }) {
	const [path, setPath] = useState<string | null>(ABSOLUTE.test(initial.trim()) ? initial.trim() : null);
	const goHome = useRef(path === null);
	const listing = useDirectories(path);
	useEffect(() => {
		if (goHome.current && listing.data) {
			goHome.current = false;
			setPath(listing.data.home);
		}
	}, [listing.data]);

	const data = listing.data;
	const readable = path !== null && data?.path === path && !data.error;
	return (
		<Dialog open onOpenChange={open => !open && onClose()} title={title} width="w-[560px]">
			<div className="flex items-center gap-2">
				<IconButton label="上一级" disabled={path === null} onClick={() => setPath(data?.path === path ? data.parent : null)}><ArrowUp size={16} /></IconButton>
				<div className="h-8 min-w-0 flex-1 truncate rounded-md border border-line bg-page px-2.5 font-mono text-xs leading-8" title={path ?? undefined}>
					{path ?? '用户目录和盘符'}
				</div>
			</div>
			<div className="mt-2 h-80 overflow-y-auto rounded-md border border-line py-1">
				{listing.isPending && <Note>正在读取…</Note>}
				{listing.isError && <Note danger>读取失败：{listing.error.message}</Note>}
				{data?.error && <Note danger>{data.error}</Note>}
				{data && path === null && !goHome.current && (
					<>
						<Entry icon={<House size={15} />} label="用户目录" detail={data.home} onOpen={() => setPath(data.home)} />
						{data.roots.map(root => <Entry key={root} icon={<HardDrive size={15} />} label={root} onOpen={() => setPath(root)} />)}
					</>
				)}
				{readable && data.directories.length === 0 && <Note>没有子目录</Note>}
				{readable && data.directories.map(directory => (
					<Entry key={directory.path} icon={<Folder size={15} />} label={directory.name} onOpen={() => setPath(directory.path)} />
				))}
			</div>
			<div className="mt-4 flex justify-end gap-2">
				<Button onClick={onClose}>取消</Button>
				<Button variant="primary" disabled={!readable} onClick={() => onSelect(path!)}>选择该目录</Button>
			</div>
		</Dialog>
	);
}

function Entry({ icon, label, detail, onOpen }: { icon: ReactNode; label: string; detail?: string; onOpen: () => void }) {
	return (
		<button type="button" onClick={onOpen} className="flex h-8 w-full items-center gap-2 px-3 text-left text-[13px] hover:bg-hover focus-visible:bg-hover focus-visible:outline-none">
			<span className="shrink-0 text-fg-3">{icon}</span>
			<span className="truncate">{label}</span>
			{detail && <span className="min-w-0 truncate font-mono text-xs text-fg-3">{detail}</span>}
		</button>
	);
}

function Note({ danger, children }: { danger?: boolean; children: ReactNode }) {
	return <div className={danger ? 'px-3 py-2 text-[13px] text-danger' : 'px-3 py-2 text-[13px] text-fg-3'}>{children}</div>;
}
