import { randomInt } from 'node:crypto';

/** ID 用的字符：去掉了容易看错的 0/O、1/I。资源文件的名字也用它（见 resources.ts）。 */
export const ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** ID 的开头和它是什么。分组只在网页端用。 */
const KINDS = { M: '成员', G: '群聊', T: '终端', B: '后台任务', R: '定时', A: '附件', L: '分组' } as const;

export type IdPrefix = keyof typeof KINDS;

/**
 * 前缀后面随机部分的长度，按会有多少个定：成员、群聊、分组一个数据目录里最多几百个，4 位（约 100 万种）；
 * 终端、后台任务、定时、附件会一直累积，5 位（约 3300 万种）。越短越省上下文，模型也越不容易抄错。
 */
const LENGTHS: Readonly<Record<IdPrefix, number>> = { M: 4, G: 4, L: 4, T: 5, B: 5, R: 5, A: 5 };

/** 重新抽这么多次还撞，说明快用满了，报错而不是一直抽下去。 */
const MAX_ATTEMPTS = 100;

/**
 * 生成 `M_7KQ2`、`T_7KQ2M` 这样的 ID，前缀区分实体类型。taken 查这个 ID 有没有被用过，用过就重新抽。
 * 用随机字符不用顺序编号：写错一位或编出来的 ID 基本不存在，会报错让模型改正，不会悄悄落到另一个真实的成员上。
 */
export function newId(prefix: IdPrefix, taken: (id: string) => boolean): string {
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		let suffix = '';
		for (let index = 0; index < LENGTHS[prefix]; index++) {
			suffix += ID_ALPHABET[randomInt(ID_ALPHABET.length)];
		}
		const id = `${prefix}_${suffix}`;
		if (!taken(id)) return id;
	}
	throw new Error(`${KINDS[prefix]}的 ID 快用满了`);
}

/** 要的是 expected 类型的 ID，给的却是别的类型时，说明它是什么，如「T_7KQ2M 是终端，不是后台任务」；其他情况返回 undefined。 */
export function wrongKind(id: string, expected: IdPrefix): string | undefined {
	const prefix = /^([A-Z])_/.exec(id)?.[1];
	if (!prefix || prefix === expected || !(prefix in KINDS)) return undefined;
	return `${id} 是${KINDS[prefix as IdPrefix]}，不是${KINDS[expected]}`;
}
