import clsx from 'clsx';
import { Ban, ChevronRight, CircleAlert, CircleDashed, CircleStop, Clock, Hourglass, LoaderCircle, SquareTerminal } from 'lucide-react';
import { Fragment, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { api } from '../api/client.ts';
import { useCallOutput, useCodeCalls } from '../api/member.ts';
import { useGroup, useMembers } from '../api/queries.ts';
import { useTerminals } from '../api/system.ts';
import type { ContextState, ICodeCall, ITask, IToolResult } from '../api/types.ts';
import { CodeBlock } from '../chat/Markdown.tsx';
import { attachmentLabel } from '../chat/MessageItem.tsx';
import { errorMessage } from '../lib/errors.ts';
import { firstLine } from '../lib/format.ts';
import { PlanItems, planItemsOf, planProgress } from '../overview/PlanItems.tsx';
import { delayText, reminderWhen } from '../lib/reminder.ts';
import { CodeScroll, CopyButton, CopyCorner } from '../ui/CopyButton.tsx';
import { FollowOutput } from '../ui/FollowOutput.tsx';
import { TextButton } from '../ui/TextButton.tsx';
import { ToolFileLink } from '../workbench/FileLink.tsx';
import { openTerminal } from '../workbench/tabs.ts';
import { FADED } from './faded.ts';
import { StickyLevel, useStickyHeader } from './sticky.tsx';

/** 工具调用的状态。skipped：运行在执行前停止了；stopped：执行到一半运行停止了；unknown：运行停止了，没有记下结果。 */
export type CallStatus = 'waiting' | 'running' | 'success' | 'error' | 'background' | 'skipped' | 'stopped' | 'unknown';

/** 完成（工具没报错）的不标状态。执行中不转圈：运行中的过程行已经在转。 */
export const STATUS: Record<Exclude<CallStatus, 'success'>, { label: string; icon: ReactNode; className: string }> = {
	waiting: { label: '等待审批', icon: <Hourglass size={12} />, className: 'text-attention' },
	running: { label: '执行中', icon: null, className: 'text-accent' },
	error: { label: '出错', icon: <CircleAlert size={12} />, className: 'text-danger' },
	background: { label: '转为后台', icon: <Clock size={12} />, className: 'text-fg-2' },
	skipped: { label: '未执行', icon: <Ban size={12} />, className: 'text-fg-3' },
	stopped: { label: '已中止', icon: <CircleStop size={12} />, className: 'text-fg-3' },
	unknown: { label: '无结果', icon: <CircleDashed size={12} />, className: 'text-fg-3' },
};

const TASK_STATUS: Record<ITask['status'], string> = {
	running: '运行中',
	completed: '已完成',
	failed: '出错',
	cancelled: '已取消',
	interrupted: '已中断',
};

/** 按扩展名猜是不是图片，只用来写附件数量。 */
const IMAGE_PATH = /\.(png|jpe?g|gif|webp|bmp)$/i;

/** 卡片里显示的结果；脚本里的调用没有图片。 */
type CallResult = Pick<IToolResult, 'output' | 'isError' | 'images'>;

/** 工具名和参数；more_tools 的调用换成它实际调用的工具。 */
export function unwrapCall(name: string, args: unknown): { name: string; args: unknown; describe: boolean } {
	if (name === 'more_tools' && isRecord(args) && typeof args['tool_name'] === 'string') {
		if (args['action'] === 'call') return { name: args['tool_name'], args: args['arguments'] ?? {}, describe: false };
		return { name: args['tool_name'], args, describe: true };
	}
	return { name, args, describe: false };
}

/** 过程里的一次工具调用：一行灰字说清做了什么，只有没完成时标状态；点击展开看第一行没有的内容。 */
export function CallStep({ memberId, name: rawName, args: rawArgs, result, status, task, place, contextState }: {
	memberId: string;
	name: string;
	args: unknown;
	result: CallResult | undefined;
	status: CallStatus;
	task: ITask | undefined;
	/** 这次调用在哪次运行、哪个调用：取脚本里的工具调用、执行中的输出。脚本里的调用没有。 */
	place: ICallPlace | undefined;
	contextState?: ContextState;
}) {
	const [open, setOpen] = useState(false);
	const call = unwrapCall(rawName, rawArgs);
	// 新建终端的那一步第一行里没有终端编号可点，行尾放「打开终端」。
	const created = call.name === 'terminal' && !call.describe && !(isRecord(call.args) && typeof call.args['terminal_id'] === 'string') ? terminalIdOf(call.args, result) : undefined;
	return (
		<div className={clsx(contextState && contextState !== 'visible' && FADED)}>
			<StepLine
				open={open} onToggle={() => setOpen(value => !value)} status={status} contextState={contextState} copy={mainText(call)}
				after={created && <TerminalOpen id={created} className="flex shrink-0 items-center gap-1"><SquareTerminal size={12} />打开终端</TerminalOpen>}
			>
				<Summary memberId={memberId} {...call} />
			</StepLine>
			{!open && result?.isError && <ErrorLine output={result.output} className="pl-[18px]" />}
			{open && (
				<StepDetails>
					<CallBody memberId={memberId} {...call} result={result} place={place} running={status === 'running'} task={task} />
					<RawData args={rawArgs} result={result} />
				</StepDetails>
			)}
			{task && <TaskBar task={task} />}
		</div>
	);
}

/**
 * 过程里一步的那一行：展开箭头、一句话、没完成时的状态。展开时最右边复制 copy（这一步最主要的内容），跟着这一行停在顶部。
 * after 紧跟在那句话后面，不参与截断：话太长时截断的是话，它一直在。
 */
export function StepLine({ open, onToggle, status, contextState, copy, after, children }: {
	open: boolean;
	/** 没有时不能展开。 */
	onToggle: (() => void) | undefined;
	status?: CallStatus;
	contextState?: ContextState;
	copy?: string;
	after?: ReactNode;
	children: ReactNode;
}) {
	const meta = status && status !== 'success' ? STATUS[status] : undefined;
	const sticky = useStickyHeader<HTMLDivElement>(open, onToggle);
	return (
		<div ref={sticky.ref} style={sticky.style} className={clsx('group/copy flex items-center gap-1', sticky.className)}>
			<button
				type="button"
				disabled={!onToggle}
				aria-expanded={onToggle ? open : undefined}
				onClick={sticky.toggle}
				className="flex min-w-0 flex-1 items-center gap-1 py-0.5 text-left text-xs text-fg-2 enabled:hover:text-fg"
			>
				<ChevronRight size={13} className={clsx('shrink-0 text-fg-3 transition-transform', open && 'rotate-90', !onToggle && 'invisible')} />
				<span className={clsx('min-w-0 truncate', !after && 'flex-1')}>{children}</span>
				{after}
				{after && <span className="flex-1" />}
				<ContextTag state={contextState} />
				{meta && <span className={clsx('flex shrink-0 items-center gap-1', meta.className)}>{meta.icon}{meta.label}</span>}
			</button>
			{open && copy && <CopyButton text={copy} />}
		</div>
	);
}

/** 一步最主要的内容，展开时标题行可以复制：命令、文件路径、网址、脚本。 */
function mainText({ name, args, describe }: { name: string; args: unknown; describe: boolean }): string | undefined {
	if (describe || !isRecord(args)) return undefined;
	const key = { shell: 'command', write_file: 'path', edit_file: 'path', browser: 'url', run_tool_script: 'script' }[name];
	const value = key && args[key];
	return typeof value === 'string' && value ? value : undefined;
}

/** 展开后的细节：左边一道细竖线。 */
export function StepDetails({ children }: { children: ReactNode }) {
	return <div className="mb-1.5 ml-1.5 mt-0.5 space-y-2 border-l border-line pl-3 text-[13px]"><StickyLevel>{children}</StickyLevel></div>;
}

/** 审批卡片里的「打开终端」：终端还在时展开工作台、切到这个终端。 */
export function TerminalLink({ terminalId, className }: { terminalId: string | undefined; className?: string }) {
	const terminals = useTerminals();
	if (!terminalId || !terminals.data?.some(terminal => terminal.terminalId === terminalId)) return null;
	return (
		<button type="button" onClick={() => openTerminal(terminalId)} className={clsx('flex w-fit items-center gap-1 text-xs text-accent hover:underline', className)}>
			<SquareTerminal size={12} />打开终端
		</button>
	);
}

/**
 * 时间线里一步的第一行上打开终端的入口：终端还在时可以点（强调色），展开工作台、切到这个终端，标签闪一下。
 * 放在那一行的按钮里，所以不用 button，点击也不往外传（和文件路径一样）。终端不在了：gone 给了就照它写，没给就不显示。
 * 一步一行各放一个「打开终端」会重复很多遍，所以新建终端的那一步放在行尾，其余各步是第一行里的终端编号。
 */
function TerminalOpen({ id, className, gone = null, children }: { id: string; className?: string; gone?: ReactNode; children: ReactNode }) {
	const terminals = useTerminals();
	if (!terminals.data?.some(terminal => terminal.terminalId === id)) return <>{gone}</>;
	const open = (event: MouseEvent | KeyboardEvent) => {
		event.preventDefault();
		event.stopPropagation();
		openTerminal(id);
	};
	return (
		<span
			role="link"
			tabIndex={0}
			title="打开终端"
			onClick={open}
			onKeyDown={event => event.key === 'Enter' && open(event)}
			className={clsx('cursor-pointer text-accent hover:underline', className)}
		>
			{children}
		</span>
	);
}

/** 第一行里的终端编号：等宽字，终端还在时可以点，不在了是普通的字。 */
function TerminalId({ id }: { id: string }) {
	return <TerminalOpen id={id} className="font-mono text-[12px] leading-none" gone={id}>{id}</TerminalOpen>;
}

/** 终端工具操作的终端：参数里给了就用参数的，新建的从结果里找。 */
function terminalIdOf(args: unknown, result: CallResult | undefined): string | undefined {
	if (isRecord(args) && typeof args['terminal_id'] === 'string') return args['terminal_id'];
	return result && /\[终端 (T_\w+)，/.exec(result.output)?.[1];
}

/** 卡片第一行：查看工具说明，或这次调用的概括。 */
function Summary({ memberId, name, args, describe }: { memberId: string; name: string; args: unknown; describe: boolean }) {
	return describe ? <>查看工具说明 <Mono>{name}</Mono></> : <CallSummary memberId={memberId} name={name} args={args} />;
}

/** 卡片第一行的概括：一句话说清做了什么。memberId 是调用的成员，相对路径按它的工作目录算。 */
export function CallSummary({ memberId, name, args }: { memberId: string; name: string; args: unknown }) {
	const record = isRecord(args) ? args : {};
	switch (name) {
		case 'send_message':
			return <><SendTarget target={String(record['target'] ?? '')} />：{String(record['text'] ?? '')}</>;
		case 'shell':
			return <Mono>$ {String(record['command'] ?? '')}</Mono>;
		case 'terminal':
			return <TerminalCall args={record} />;
		case 'browser':
			return <BrowserCall args={record} />;
		case 'write_file':
			return <>{record['overwrite'] === true ? '覆盖文件' : '新建文件'} <PathMono memberId={memberId} path={String(record['path'] ?? '')} /> <span className="text-fg-3">{lineCount(String(record['content'] ?? ''))} 行</span></>;
		case 'edit_file':
			return <>修改文件 <PathMono memberId={memberId} path={String(record['path'] ?? '')} /> <LineCounts {...editCounts(editsOf(args))} /></>;
		case 'run_tool_script':
			return <>用脚本调用工具 <Mono className="text-fg-3">{firstLine(String(record['script'] ?? ''))}</Mono></>;
		case 'view_image':
			return <>查看图片 {(Array.isArray(record['paths']) ? record['paths'] : []).map((path, index) => <Fragment key={index}>{index > 0 && '、'}<PathMono memberId={memberId} path={String(path)} /></Fragment>)}</>;
		case 'read_pdf':
			return <>读取 PDF <PathMono memberId={memberId} path={String(record['path'] ?? '')} />{pages(record)}</>;
		case 'read_skill':
			return <>读取技能 {String(record['name'] ?? '')}</>;
		case 'search_history':
			return <SearchCall args={record} />;
		case 'manage_group':
			return <GroupCall args={record} />;
		case 'manage_background_tasks':
			return record['action'] === 'cancel' ? <>取消后台任务 {String(record['task_id'] ?? '')}</> : <>查看后台任务</>;
		case 'manage_reminders':
			return <ReminderCall args={record} />;
		case 'manage_memory':
			return <MemoryCall args={record} />;
		case 'update_plan':
			return <PlanCall args={record} />;
		default:
			return <><Mono>{name}</Mono> <span className="text-fg-3">{argsSnippet(args)}</span></>;
	}
}

/** edit_file 增减的行数，没有的不写。 */
export function LineCounts({ added, removed }: { added: number; removed: number }) {
	return <>{added > 0 && <span className="text-success">+{added}</span>}{added > 0 && removed > 0 && ' '}{removed > 0 && <span className="text-danger">-{removed}</span>}</>;
}

/** terminal：新建、输入、读取、关闭，请用户接管。 */
function TerminalCall({ args }: { args: Record<string, unknown> }) {
	const id = typeof args['terminal_id'] === 'string' ? args['terminal_id'] : undefined;
	const input = typeof args['input'] === 'string' ? firstLine(args['input']) : '';
	const ask = typeof args['ask_user'] === 'string' && args['ask_user'].trim() ? <>，请你接管：{args['ask_user'].trim()}</> : null;
	if (!id) return <>新建终端{input && <>：<Mono>{input}</Mono></>}{ask}</>;
	const terminal = <TerminalId id={id} />;
	if (args['close'] === true) return <>关闭终端 {terminal}</>;
	if (input) return <>终端 {terminal} 输入：<Mono>{input}</Mono>{ask}</>;
	if (ask) return <>请你接管终端 {terminal}：{(args['ask_user'] as string).trim()}</>;
	return args['output'] === 'screen' ? <>查看终端 {terminal} 当前屏幕</> : <>读取终端 {terminal}</>;
}

/** browser：一句话写清这一步，元素写成员给的说明，没给时写编号。 */
function BrowserCall({ args }: { args: Record<string, unknown> }) {
	const string = (key: string) => typeof args[key] === 'string' ? args[key] : '';
	const element = string('element') || string('ref');
	switch (args['action']) {
		case 'open': return <>打开 <Mono>{string('url')}</Mono>{args['new_tab'] === true && <span className="text-fg-3"> · 新标签页</span>}</>;
		case 'snapshot': return <>读取页面</>;
		case 'click': return <>点击 {element}</>;
		case 'type': return <>在 {element} 输入：{firstLine(string('text'))}{args['submit'] === true && <span className="text-fg-3"> · 回车</span>}</>;
		case 'press': return <>{element && <>在 {element} </>}按 <Mono>{string('key')}</Mono></>;
		case 'select': return <>在 {element} 选择：{Array.isArray(args['values']) ? args['values'].join('、') : ''}</>;
		case 'hover': return <>悬停在 {element}</>;
		case 'scroll': {
			const direction = ({ up: '向上', down: '向下', left: '向左', right: '向右' } as Record<string, string | undefined>)[string('direction')] ?? '';
			const amount = typeof args['amount'] === 'number' && args['amount'] !== 1 ? ` ${args['amount']} 屏` : '';
			return <>{element && <>在 {element} </>}{direction}滚动{amount}</>;
		}
		case 'resize': return <>调整页面大小为 {String(args['width'])}×{String(args['height'])}</>;
		case 'screenshot': return <>截图{element ? <> {element}</> : args['full_page'] === true && '整个页面'}</>;
		case 'back': return <>后退</>;
		case 'reload': return <>刷新</>;
		case 'restore': return <>恢复上次的标签页</>;
		case 'tabs': return <>查看标签页</>;
		case 'switch_tab': return <>切换到标签页 {String(args['tab'] ?? '')}</>;
		case 'close_tab': return <>关闭标签页{args['tab'] !== undefined && ` ${String(args['tab'])}`}</>;
		case 'evaluate': return <>在页面执行脚本 <Mono className="text-fg-3">{firstLine(string('script'))}</Mono></>;
		case 'console': return <>查看页面日志</>;
		case 'wait': return args['text'] !== undefined ? <>等待「{string('text')}」出现</> : <>等待 {String(args['seconds'] ?? '')} 秒</>;
		case 'close': return <>关闭浏览器</>;
		default: return <><Mono>browser</Mono> <span className="text-fg-3">{argsSnippet(args)}</span></>;
	}
}

/** search_history：关键词，限定了对话、发送人、时间范围时写在后面。 */
function SearchCall({ args }: { args: Record<string, unknown> }) {
	const keywords = Array.isArray(args['keywords']) ? args['keywords'].map(String).filter(Boolean) : [];
	const conversation = typeof args['conversation'] === 'string' ? args['conversation'] : undefined;
	const sender = typeof args['sender'] === 'string' ? args['sender'] : undefined;
	const start = typeof args['start_time'] === 'string' ? args['start_time'] : undefined;
	const end = typeof args['end_time'] === 'string' ? args['end_time'] : undefined;
	const timeZone = typeof args['timezone'] === 'string' ? args['timezone'] : undefined;
	const bounds = start && end ? `${start} 到 ${end}` : start ? `${start} 之后` : end ? `${end} 之前` : undefined;
	// 给了时区时跟在范围后面：上下文里的时间可能是以前的时区，不写看不出按的哪个。
	const range = bounds && timeZone ? `${bounds}，${timeZone}` : bounds;
	return (
		<>
			查找历史记录{keywords.length > 0 && `：${keywords.join('、')}`}
			{conversation && <span className="text-fg-3">（{conversation.startsWith('G_') ? '' : '私聊 '}<ConversationName id={conversation} />）</span>}
			{sender && <span className="text-fg-3">（<ConversationName id={sender} /> 发送的）</span>}
			{range && <span className="text-fg-3">（{range}）</span>}
		</>
	);
}

/** manage_memory：添加写新内容，修改写改成的内容，删除写删掉的原文。 */
function MemoryCall({ args }: { args: Record<string, unknown> }) {
	const string = (key: string) => typeof args[key] === 'string' ? args[key] : '';
	if (args['action'] === 'add') return <>添加记忆：{string('text')}</>;
	return string('new_text') ? <>修改记忆：{string('new_text')}</> : <>删除记忆：{string('old_text')}</>;
}

/** update_plan：「更新计划 · 3/7」，清空时写「清空计划」；参数不是清单（调用出错）时只写「更新计划」。 */
function PlanCall({ args }: { args: Record<string, unknown> }) {
	if (!Array.isArray(args['items'])) return <>更新计划</>;
	const items = planItemsOf(args);
	return items.length === 0 ? <>清空计划</> : <>更新计划<span className="text-fg-3"> · {planProgress(items)}</span></>;
}

/** manage_group：创建、调整成员、解散、关注、取消关注。 */
function GroupCall({ args }: { args: Record<string, unknown> }) {
	const group = typeof args['group_id'] === 'string' ? <ConversationName id={args['group_id']} /> : '群聊';
	switch (args['action']) {
		case 'create': return <>创建群聊「{String(args['name'] ?? '')}」</>;
		case 'update_members': return <>调整{group}成员</>;
		case 'dissolve': return <>解散{group}</>;
		case 'watch': return <>关注{group}</>;
		case 'unwatch': return <>取消关注{group}</>;
		default: return <>管理群聊</>;
	}
}

/** manage_reminders：新建写时间（或从现在起多久）和要做的事，修改、取消写编号。 */
function ReminderCall({ args }: { args: Record<string, unknown> }) {
	const id = typeof args['reminder_id'] === 'string' ? ` ${args['reminder_id']}` : '';
	const delay = args['delay_seconds'];
	const when = typeof args['time'] === 'string'
		? reminderWhen(args['time'], typeof args['repeat'] === 'string' ? args['repeat'] : undefined, Array.isArray(args['week_days']) ? args['week_days'] as number[] : [])
		: typeof delay === 'number' && delay > 0 ? delayText(delay) : '';
	const note = typeof args['note'] === 'string' ? args['note'] : '';
	switch (args['action']) {
		case 'add': return <>新建定时：{when}{note && <span className="text-fg-3"> · {note}</span>}</>;
		case 'update': return <>修改定时{id}{when && `：${when}`}{note && <span className="text-fg-3"> · {note}</span>}</>;
		case 'cancel': return <>取消定时{id}</>;
		default: return <>查看定时</>;
	}
}

function SendTarget({ target }: { target: string }) {
	// 和时间线里收到的消息标法一样：私聊写「私聊 张三」，群聊写「群聊「X」」。
	return <>{!target.startsWith('G_') && '私聊 '}<ConversationName id={target} /></>;
}

/** 成员 ID 写名字，群聊 ID 写「群聊「X」」；找不到时写 ID。 */
export function ConversationName({ id }: { id: string }) {
	const members = useMembers();
	const group = useGroup(id.startsWith('G_') ? id : undefined);
	if (id.startsWith('G_')) return <>群聊「{group.data?.name ?? id}」</>;
	return <>{members.data?.find(member => member.memberId === id)?.name ?? id}</>;
}

/** 展开后的内容：只放第一行没有的信息，每个工具单独定；出错时总是显示错误。 */
function CallBody({ memberId, name, args, describe, result, place, running, task }: {
	memberId: string;
	name: string;
	args: unknown;
	describe: boolean;
	result: CallResult | undefined;
	place: ICallPlace | undefined;
	running: boolean;
	task: ITask | undefined;
}) {
	const record = isRecord(args) ? args : {};
	const code = name === 'run_tool_script' ? place : undefined;
	const error = result?.isError ? <ResultView result={result} /> : null;
	const plain = result ? <ResultView result={result} title={null} /> : null;
	if (describe) return plain;
	switch (name) {
		case 'send_message':
			return <><MessageDetail args={record} />{error}</>;
		case 'shell':
			return <CommandBlock command={String(record['command'] ?? '')} result={result} place={place} running={running} task={task} />;
		case 'write_file':
			return <><FileContent path={String(record['path'] ?? '')} content={String(record['content'] ?? '')} />{error}</>;
		case 'edit_file':
			return <><EditsView edits={editsOf(args)} />{error}</>;
		case 'run_tool_script':
			return (
				<>
					<Pre>{String(record['script'] ?? '')}</Pre>
					{code && <CodeCalls memberId={memberId} runId={code.runId} callId={code.callId} />}
					{result && <ResultView result={result} title="输出" />}
				</>
			);
		case 'view_image':
			return result && !result.isError ? <ImageResult result={result} /> : error;
		case 'manage_reminders': {
			const note = typeof record['note'] === 'string' ? record['note'] : '';
			return <>{note && <div className="whitespace-pre-wrap break-words">{note}</div>}{plain}</>;
		}
		case 'manage_background_tasks':
			return plain;
		case 'manage_memory':
			return <><MemoryDetail args={record} />{plain}</>;
		case 'update_plan': {
			// 清单和概况栏的计划一样画，这里地方够，事项换行写全；成功时不显示结果。
			const items = planItemsOf(record);
			return <>{items.length > 0 && <PlanItems items={items} wrap />}{error}</>;
		}
		case 'browser':
			return record['action'] === 'evaluate' ? <><Pre>{String(record['script'] ?? '')}</Pre>{result && <ResultView result={result} />}</> : plain;
		case 'terminal':
		case 'read_pdf':
		case 'read_skill':
		case 'search_history':
		case 'manage_group':
			return plain;
		default:
			return <><ArgList args={args} />{result && <ResultView result={result} />}</>;
	}
}

/** manage_memory：完整的内容，修改时原文划掉写在上面。 */
function MemoryDetail({ args }: { args: Record<string, unknown> }) {
	const string = (key: string) => typeof args[key] === 'string' ? args[key] : '';
	if (args['action'] === 'add') return <div className="whitespace-pre-wrap break-words">{string('text')}</div>;
	return (
		<div className="space-y-1 whitespace-pre-wrap break-words">
			<div className="text-fg-3 line-through">{string('old_text')}</div>
			{string('new_text') && <div>{string('new_text')}</div>}
		</div>
	);
}

/** send_message：完整正文、点名、附件。 */
function MessageDetail({ args }: { args: Record<string, unknown> }) {
	return (
		<div className="space-y-1">
			<div className="whitespace-pre-wrap break-words">{String(args['text'] ?? '')}</div>
			<MessageExtras args={args} />
		</div>
	);
}

/** send_message 的点名和附件（「N 张图片 · M 个文件」）。 */
export function MessageExtras({ args }: { args: Record<string, unknown> }) {
	const mentions = Array.isArray(args['mentions']) ? args['mentions'] : [];
	const attachments = Array.isArray(args['attachments']) ? args['attachments'] : [];
	return (
		<>
			{mentions.length > 0 && <div className="text-xs text-fg-2">点名：<MentionNames ids={mentions.map(String)} /></div>}
			{attachments.length > 0 && (
				<div className="text-xs text-fg-2" title={attachments.join('\n')}>
					附件：{attachmentLabel(attachments.map(path => IMAGE_PATH.test(String(path)) ? 'image' : 'file'))}
				</div>
			)}
		</>
	);
}

/** 一次调用在哪次运行、哪个调用。 */
export interface ICallPlace {
	readonly runId: number;
	readonly callId: string;
}

/**
 * shell：终端样式的一块，命令后面接输出；出错（没执行）时命令下面单独写原因。
 * 执行中（不管转没转后台）看到目前为止的输出，跟着更新；转为后台的结束后看任务的结果，不看「已转为后台任务」那句。
 */
function CommandBlock({ command, result, place, running, task }: { command: string; result: CallResult | undefined; place: ICallPlace | undefined; running: boolean; task: ITask | undefined }) {
	if (task) {
		if (task.status === 'running' && place) return <LiveCommand command={command} place={place} />;
		return <Pre>{`$ ${command}\n${task.output ?? (task.status === 'interrupted' ? '（输出未保存）' : '')}`}</Pre>;
	}
	if (!result && running && place) return <LiveCommand command={command} place={place} />;
	return (
		<>
			<Pre>{result && !result.isError ? `$ ${command}\n${result.output}` : `$ ${command}`}</Pre>
			{result?.isError && <ResultView result={result} />}
		</>
	);
}

/** 执行中的命令：到目前为止的输出，跟着新输出滚到最新一行。只在这一步展开时取。 */
function LiveCommand({ command, place }: { command: string; place: ICallPlace }) {
	const live = useCallOutput(place.runId, place.callId, true);
	if (live.isError) return <><Pre>{`$ ${command}`}</Pre><div className="text-xs text-danger">读取输出失败：{live.error.message}</div></>;
	return <FollowOutput text={live.data ? `$ ${command}\n${live.data}` : `$ ${command}`} live className="max-h-80" />;
}

/** view_image：图片；读不了的写原因。 */
function ImageResult({ result }: { result: CallResult }) {
	const problems = result.output.split('\n').filter(line => line && !/：第 \d+ 张$/.test(line));
	return <ResultView result={{ ...result, output: problems.join('\n') }} title={null} />;
}

/** 参数每个一行：参数名和值。 */
function ArgList({ args }: { args: unknown }) {
	if (!isRecord(args)) return typeof args === 'string' && args ? <Section title="参数"><Pre>{args}</Pre></Section> : null;
	const entries = Object.entries(args).filter(([, value]) => value !== undefined).map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)] as const);
	if (entries.length === 0) return null;
	return (
		<Section title="参数">
			<CopyCorner text={entries.map(([key, value]) => `${key}: ${value}`).join('\n')}>
				<div className="space-y-0.5 rounded-md bg-code py-1.5 pl-2 pr-7 font-mono text-xs">
					{entries.map(([key, value]) => (
						<div key={key} className="whitespace-pre-wrap break-words"><span className="text-fg-3">{key}: </span>{value}</div>
					))}
				</div>
			</CopyCorner>
		</Section>
	);
}

function MentionNames({ ids }: { ids: readonly string[] }) {
	const members = useMembers();
	return <>{ids.map(id => id === 'all' ? '所有人' : members.data?.find(member => member.memberId === id)?.name ?? id).join('、')}</>;
}

/** 结果的文字和图片。title 是 null 时不写标题；出错时总写「出错」。 */
function ResultView({ result, title = '结果' }: { result: CallResult; title?: string | null }) {
	const body = (
		<>
			{result.output && <Pre className={result.isError ? 'text-danger' : undefined}>{result.output}</Pre>}
			{result.images && result.images.length > 0 && (
				<div className="mt-1 flex flex-wrap gap-2">
					{result.images.map(id => (
						<a key={id} href={resourceUrl(id)} target="_blank" rel="noreferrer">
							<img src={resourceUrl(id)} alt="" className="max-h-48 max-w-full rounded-md border border-line object-contain" />
						</a>
					))}
				</div>
			)}
		</>
	);
	if (result.isError) return <Section title="出错">{body}</Section>;
	return title === null ? body : <Section title={title}>{body}</Section>;
}

/** 收起时，出错的调用在第一行下面写一行错误开头。 */
export function ErrorLine({ output, className }: { output: string; className?: string }) {
	return <div className={clsx('truncate text-xs text-danger', className)} title={output}>{firstLine(output)}</div>;
}

/** 「原始数据」：参数 JSON 和结果原文，默认收起，排查问题用。 */
function RawData({ args, result }: { args: unknown; result: CallResult | undefined }) {
	const [open, setOpen] = useState(false);
	return (
		<div>
			<button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)} className="flex items-center gap-1 text-xs text-fg-3 hover:text-fg-2">
				<ChevronRight size={12} className={clsx('transition-transform', open && 'rotate-90')} />原始数据
			</button>
			{open && (
				<div className="mt-1 space-y-2">
					<Section title="参数"><Pre>{typeof args === 'string' ? args : JSON.stringify(args, null, 2)}</Pre></Section>
					{result && <Section title="结果"><Pre>{result.output}</Pre></Section>}
				</div>
			)}
		</div>
	);
}

function resourceUrl(id: string): string {
	return `/v1/resources?id=${encodeURIComponent(id)}`;
}

function CodeCalls({ memberId, runId, callId }: { memberId: string; runId: number; callId: string }) {
	const calls = useCodeCalls(memberId, runId, callId, true);
	if (calls.isPending) return <div className="text-xs text-fg-3">正在加载工具调用…</div>;
	if (calls.isError) return <div className="text-xs text-danger">加载失败：{calls.error.message}</div>;
	if (calls.data.length === 0) return <div className="text-xs text-fg-3">未调用工具</div>;
	return (
		<Section title="工具调用">
			<div className="space-y-0.5">
				{calls.data.map(call => <CodeCallStep key={call.callIndex} memberId={memberId} call={call} />)}
			</div>
		</Section>
	);
}

/** 脚本里的一次调用：和过程里的步骤显示一样。 */
function CodeCallStep({ memberId, call }: { memberId: string; call: ICodeCall }) {
	return (
		<CallStep
			memberId={memberId}
			name={call.toolName}
			args={call.arguments}
			result={call.output === null ? undefined : { output: call.output, isError: call.status === 'failed' }}
			status={call.status === 'running' ? 'running' : call.status === 'failed' ? 'error' : 'success'}
			task={undefined}
			place={undefined}
		/>
	);
}

/** 后台任务「取消」的悬停提示。终端的等待任务取消了只是不再等，写明，免得以为会把终端里的程序停掉；别的任务不写。 */
export function cancelTitle(task: ITask): string | undefined {
	return task.toolName === 'terminal' ? '仅结束等待，不影响终端中的程序' : undefined;
}

function TaskBar({ task }: { task: ITask }) {
	const [error, setError] = useState<string>();
	const [busy, setBusy] = useState(false);
	const cancel = async () => {
		setBusy(true);
		setError(undefined);
		try {
			await api('POST', `/v1/tasks/${task.taskId}/cancel`);
		} catch (caught) {
			setError(errorMessage(caught));
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="ml-[18px] flex flex-wrap items-center gap-2 py-0.5 text-xs text-fg-2">
			{task.status === 'running' && <LoaderCircle size={12} className="animate-spin text-accent" />}
			<span>后台任务 {TASK_STATUS[task.status]}</span>
			{task.status === 'running' && <TextButton problem={busy && '正在取消'} title={cancelTitle(task)} onClick={() => void cancel()}>取消</TextButton>}
			{error && <span className="text-danger">取消失败：{error}</span>}
		</div>
	);
}

/** write_file 的内容：按文件的扩展名高亮，太长时在框里滚动。 */
export function FileContent({ path, content }: { path: string; content: string }) {
	const extension = /\.([^./\\]+)$/.exec(path)?.[1] ?? '';
	return <div className="max-h-96 overflow-auto rounded-lg [&>div]:my-0"><CodeBlock code={content.replace(/\n$/, '')} language={extension} /></div>;
}

/** edit_file 的每一处改动；不止一处时每处前面写第几处。 */
export function EditsView({ edits }: { edits: readonly IFileEdit[] }) {
	return (
		<div className="space-y-2">
			{edits.map((edit, index) => (
				<div key={index} className="overflow-hidden rounded-md border border-line">
					{(edits.length > 1 || edit.replaceAll) && (
						<div className="border-b border-line bg-hover px-2 py-1 text-xs text-fg-3">
							{edits.length > 1 && `第 ${index + 1} 处`}{edits.length > 1 && edit.replaceAll && '，'}{edit.replaceAll && '全部替换'}
						</div>
					)}
					<DiffLines lines={editLines(edit)} />
				</div>
			))}
		</div>
	);
}

/** edit_file 的一处替换。 */
export interface IFileEdit {
	readonly oldText: string;
	readonly newText: string;
	readonly replaceAll: boolean;
}

/** edit_file 参数里的几处替换；写错的项跳过。 */
export function editsOf(args: unknown): IFileEdit[] {
	const edits = isRecord(args) && Array.isArray(args['edits']) ? args['edits'] : [];
	return edits.filter(isRecord).filter(edit => typeof edit['old_text'] === 'string' && typeof edit['new_text'] === 'string')
		.map(edit => ({ oldText: edit['old_text'] as string, newText: edit['new_text'] as string, replaceAll: edit['replace_all'] === true }));
}

/** 一处替换按 diff 的样子写：原文和新文开头、末尾相同的行不变，中间原文的行是 -，新文的行是 +。两边都以换行结尾时，最后的换行不算一行。 */
function editLines({ oldText, newText }: IFileEdit): string[] {
	const trim = oldText.endsWith('\n') && newText.endsWith('\n');
	const before = splitLines(trim ? oldText.replace(/\r?\n$/, '') : oldText);
	const after = splitLines(trim ? newText.replace(/\r?\n$/, '') : newText);
	let head = 0;
	while (head < before.length && head < after.length && before[head] === after[head]) head++;
	let tail = 0;
	while (tail < before.length - head && tail < after.length - head && before.at(-1 - tail) === after.at(-1 - tail)) tail++;
	return [
		...before.slice(0, head).map(line => ` ${line}`),
		...before.slice(head, before.length - tail).map(line => `-${line}`),
		...after.slice(head, after.length - tail).map(line => `+${line}`),
		...before.slice(before.length - tail).map(line => ` ${line}`),
	];
}

/** edit_file 一共增减多少行。 */
export function editCounts(edits: readonly IFileEdit[]): { added: number; removed: number } {
	const lines = edits.flatMap(editLines);
	return { added: lines.filter(line => line.startsWith('+')).length, removed: lines.filter(line => line.startsWith('-')).length };
}

function splitLines(text: string): string[] {
	return text ? text.replace(/\r\n/g, '\n').split('\n') : [];
}

/** 文件内容有几行，和运行时的结果一样算：末尾的换行不算一行。 */
export function lineCount(text: string): number {
	if (!text) return 0;
	return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

export function DiffLines({ lines }: { lines: readonly string[] }) {
	return (
		<pre className="max-h-96 overflow-auto font-mono text-xs leading-5">
			{lines.map((line, index) => (
				<div
					key={index}
					className={clsx('whitespace-pre px-2', line.startsWith('+') && 'bg-success/12 text-success', line.startsWith('-') && 'bg-danger/12 text-danger', line.startsWith('@@') && 'text-fg-3')}
				>
					{line || ' '}
				</div>
			))}
		</pre>
	);
}

export function ContextTag({ state }: { state: ContextState | undefined }) {
	if (!state || state === 'visible') return null;
	const label = { summarized: '已压缩', pruned: '已删除', omitted: '未放入上下文', unreturned: '未带回上下文' }[state];
	return <span className="shrink-0 rounded bg-hover px-1 text-[11px] leading-4 text-fg-3">{label}</span>;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
	return (
		<div>
			<div className="mb-0.5 text-xs text-fg-3">{title}</div>
			{children}
		</div>
	);
}

/** 灰底等宽的一块，右上角复制整块。 */
export function Pre({ children, className }: { children: string; className?: string }) {
	return (
		<CodeScroll text={children} className={clsx('max-h-80', className)} />
	);
}

/** 工具参数里的文件路径：照模型写的显示，算得出完整路径时可以点开，在工作台里预览。 */
function PathMono({ memberId, path }: { memberId: string; path: string }) {
	return <ToolFileLink memberId={memberId} path={path}><Mono>{path}</Mono></ToolFileLink>;
}

function Mono({ children, className }: { children: ReactNode; className?: string }) {
	return <span className={clsx('font-mono text-[12px] leading-none', className)}>{children}</span>;
}

function pages(record: Record<string, unknown>): string {
	const first = record['first_page'];
	const last = record['last_page'];
	if (typeof first !== 'number' && typeof last !== 'number') return '';
	return ` 第 ${first ?? 1}–${last ?? ''} 页`;
}

/** 没有专门写法的工具，第一行写「参数名: 值」。 */
function argsSnippet(args: unknown): string {
	if (!isRecord(args)) return typeof args === 'string' ? args : '';
	return Object.entries(args).filter(([, value]) => value !== undefined && value !== null && value !== '')
		.map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`).join(' · ');
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
