/**
 * 成员最多同时保留几个自己建的终端（只算这个成员建的、还没关闭的）。
 * 省略 member.json 里的 maxTerminals 时按这个数。
 */
export const DEFAULT_MAX_TERMINALS = 3;

/** 成员自己的上限能设的最大值。 */
export const MAX_TERMINALS_PER_MEMBER = 16;

/** AI 成员一共能创建多少个终端（只算 shell 还在跑的）；terminals.json 没配时按这个数。 */
export const DEFAULT_MAX_AI_TERMINALS = 16;

/** AI 成员上限能配的最大值。 */
export const MAX_AI_TERMINALS = 32;

/** 用户自己建的终端最多几个：不提供配置，取一个正常用不到的数。 */
export const MAX_HUMAN_TERMINALS = 20;
