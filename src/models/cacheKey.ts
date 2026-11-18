import { createHash } from 'node:crypto';

/**
 * 哈希截取的位数：32 个十六进制字符（128 位）。上游对 prompt_cache_key 的长度上限是 64，
 * 前缀 14 个字符加这里 32 个，一共 46，够用；再长就会 400。
 */
const HEX_CHARS = 32;

/**
 * 发请求时带的 prompt_cache_key。上游拿它做缓存路由：同一个 key 的请求尽量落到同一处缓存，
 * 前缀相同才命中，所以 key 只需「同一个成员恒定、每个数据目录各不相同」。
 *
 * 不能只用成员 ID：成员 ID 在每个运行时里都从 M_ 开头重新编号，不同数据目录之间必然撞上同一个 key，
 * 互不相关的请求会被引到同一处缓存——命中率没提高，落点还集中，可能撞上按 key 的限流。
 * 拼上这台运行时的盐（数据目录里 secret-key 派生出来的值，见 common/secrets.ts）再取哈希：
 * 同一成员恒定、每个数据目录各不相同，也不把内部的成员 ID 发给上游。
 */
export function cacheKeyFor(salt: string, memberId: string): string {
	return `reman-runtime:${createHash('sha256').update(`${salt}\n${memberId}`).digest('hex').slice(0, HEX_CHARS)}`;
}
