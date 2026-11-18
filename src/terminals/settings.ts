import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { errorMessage, invalid } from '../common/errors.ts';
import { DEFAULT_MAX_AI_TERMINALS, MAX_AI_TERMINALS } from './limits.ts';

/** 终端的全局上限：AI 成员合计能创建几个。用户自己建的另有固定上限，见 limits.ts 的 MAX_HUMAN_TERMINALS。 */
export interface ITerminalLimits {
	readonly maxAiTerminals: number;
	/** terminals.json 里写错了的原因；文件没问题或是默认值时是 null。 */
	readonly problem: string | null;
}

/**
 * 数据目录里的 terminals.json：`{ "maxAiTerminals": 16 }`。
 * 文件不存在时用默认值；读不出来或值不合法时也用默认值，并把原因记下来给网页端显示，不静默吞掉。
 */
export class TerminalSettings {
	private readonly path: string | undefined;
	private maxAiTerminals = DEFAULT_MAX_AI_TERMINALS;
	private problem: string | null = null;

	constructor(path: string | undefined) {
		this.path = path;
		this.load();
	}

	get limits(): ITerminalLimits {
		return { maxAiTerminals: this.maxAiTerminals, problem: this.problem };
	}

	/** 改 AI 成员的上限并写回文件；值不合法时报错，什么都不写。 */
	setMaxAiTerminals(value: unknown): ITerminalLimits {
		this.maxAiTerminals = checkMaxAiTerminals(value);
		this.problem = null;
		if (this.path) writeFileSync(this.path, `${JSON.stringify({ maxAiTerminals: this.maxAiTerminals }, null, '\t')}\n`);
		return this.limits;
	}

	private load(): void {
		if (!this.path || !existsSync(this.path)) return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(this.path, 'utf8'));
		} catch (error) {
			this.problem = `terminals.json 读不出来，按默认值 ${DEFAULT_MAX_AI_TERMINALS} 处理：${errorMessage(error)}`;
			return;
		}
		const value = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>)['maxAiTerminals'] : undefined;
		if (value === undefined) return;
		try {
			this.maxAiTerminals = checkMaxAiTerminals(value);
		} catch (error) {
			this.problem = `terminals.json 里的设置有误，按默认值 ${DEFAULT_MAX_AI_TERMINALS} 处理：${errorMessage(error)}`;
		}
	}
}

/** 只认 1 到 MAX_AI_TERMINALS 的整数。 */
function checkMaxAiTerminals(value: unknown): number {
	const ok = typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_AI_TERMINALS;
	if (!ok) throw invalid(`maxAiTerminals 必须是 1 到 ${MAX_AI_TERMINALS} 的整数`);
	return value;
}
