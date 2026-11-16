import { useQuery } from '@tanstack/react-query';
import { api } from './client.ts';
import { queryKeys } from './keys.ts';
import type { IUsage, UsageGroupBy } from './types.ts';

/**
 * 某个时间范围、某种分组的用量。since 不传是一直以来的。
 * 页面开着时半分钟拉一次：成员跑完，数字就在；切回这个页面时先用缓存里的，不用白等一次。
 */
export function useUsage(groupBy: UsageGroupBy, since: number | undefined) {
	return useQuery({
		queryKey: queryKeys.usage(groupBy, since),
		staleTime: 30_000,
		refetchInterval: 30_000,
		queryFn: async () => (await api<{ usage: IUsage }>('GET', `/v1/usage?groupBy=${groupBy}${since === undefined ? '' : `&since=${since}`}`)).usage,
	});
}
