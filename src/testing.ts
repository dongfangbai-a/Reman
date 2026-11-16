import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { runtimeDirectories } from './dataDirectory.ts';
import type { IMemberDefinition } from './members/definition.ts';
import type { IMember } from './members/members.ts';
import { ModelConfig } from './models/config.ts';
import { Runtime, type IRuntimeOptions } from './runtime.ts';

/** 测试结束时删掉的临时目录。 */
export function temporaryDirectory(t: TestContext): string {
	const directory = mkdtempSync(join(tmpdir(), 'reman-runtime-test-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	return directory;
}

/** 路径的真实写法：Windows 的临时目录可能是 8.3 短名（RUNNER~1、SRT-SA~1），比较前两边都过一遍。 */
export function realPath(path: string): string {
	try {
		return realpathSync.native(path);
	} catch {
		return path;
	}
}

/** 写进上下文的时间默认停在这一刻：测试跨过午夜时，不会多出一行追加的时间。 */
const TEST_NOW = Date.UTC(2026, 10, 5, 20, 0);

/** 测试用的运行时：内存数据库，各个目录放在临时目录里。 */
export function testRuntime(t: TestContext, options: Partial<IRuntimeOptions> = {}): Runtime {
	const directory = temporaryDirectory(t);
	return new Runtime(':memory:', {
		dataDirectory: directory, ...runtimeDirectories(directory), portableGitDirectory: null, now: () => TEST_NOW, ...options,
	});
}

/** 把成员时间线里还在上下文里的内容都标成已删除：查历史不查还在上下文里的内容，这样就都查得到。 */
export function leaveContext(runtime: Runtime, memberId: string): void {
	runtime.db.run(`UPDATE timeline_items SET context_state = 'pruned' WHERE member_id = ? AND context_state = 'visible'`, memberId);
}

/** 建一个 AI 成员（写成员文件夹）。 */
export function addAi(runtime: Runtime, name: string, definition: IMemberDefinition = {}): IMember {
	return runtime.memberFolders.create(name, { definition });
}

/** 测试用的模型配置：一个供应商 test，默认用第一个模型。 */
export function testModels(models: readonly object[] = [{ model: 'fake' }]): ModelConfig {
	const first = (models[0] as { model: string } | undefined)?.model ?? 'fake';
	return new ModelConfig(() => ({
		defaultModel: { provider: 'test', model: first },
		providers: [{ id: 'test', baseUrl: 'http://127.0.0.1:1', apiKey: 'test', models }],
	}));
}

/** 请求里的时间线部分（压缩请求还有最后的任务说明）：去掉开头的身份和规则、成员设定到通讯录那条用户消息。 */
export function timelineOf(input: readonly object[]): object[] {
	return input.filter(raw => {
		const item = raw as Record<string, any>;
		if (item['role'] === 'developer') return false;
		const text = item['role'] === 'user' && Array.isArray(item['content']) ? item['content'][0]?.text : undefined;
		return !(typeof text === 'string' && /^# (成员设定|你的记忆|运行环境)\n/.test(text));
	});
}

/** 请求开头那条用户消息的正文：成员设定、记忆、运行环境和通讯录。 */
export function openingOf(input: readonly object[]): string {
	return String((input[1] as Record<string, any>)['content'][0].text);
}

/** 请求开头「# 你的记忆」一节的正文，没有这一节时是 undefined。 */
export function memoryOf(input: readonly object[]): string | undefined {
	return /^# 你的记忆\n以下是你自己记录的内容。\n\n([\s\S]*?)\n\n# 运行环境\n/m.exec(openingOf(input))?.[1];
}

/** 去掉上下文里收到的内容和工具结果开头的编号行（连同写在编号后面的时间），方便对比。时间单独在「时间」的测试里看。 */
export function withoutNumbers(input: readonly object[]): object[] {
	const strip = (text: string) => text.replace(/^\[内容编号 \d+\]( 时间：[^\n]*)?(\n|$)/, '');
	return input.map(raw => {
		const item = raw as Record<string, any>;
		if (item['type'] === 'function_call_output') {
			const output = item['output'];
			return {
				...item,
				output: typeof output === 'string' ? strip(output)
					: (output as Record<string, any>[]).map((part, index) => index === 0 && part['type'] === 'input_text' ? { ...part, text: strip(part['text']) } : part),
			};
		}
		if (item['role'] !== 'user' || !Array.isArray(item['content']) || item['content'][0]?.type !== 'input_text') return item;
		const [first, ...rest] = item['content'] as Record<string, any>[];
		const text = strip(first!['text']);
		return { ...item, content: text ? [{ ...first, text }, ...rest] : rest };
	});
}
