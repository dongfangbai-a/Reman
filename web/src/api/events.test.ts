import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QueryClient } from '@tanstack/react-query';
import { reconnected } from './events.ts';
import { queryKeys } from './keys.ts';
import { useStreams } from './member.ts';

test('重连：说了收到哪里时只重新取下载进度和执行中的输出，其余靠补发；说不了时全部重新拉取', () => {
	const queryClient = new QueryClient();
	const keys = [queryKeys.portableGit, queryKeys.callOutput(1, 'C_A'), queryKeys.members, queryKeys.timeline('M_A')];
	for (const key of keys) queryClient.setQueryData(key, 1);
	const invalidated = () => keys.map(key => queryClient.getQueryState(key)!.isInvalidated);
	useStreams.setState({ streams: { M_A: { runId: 1, requestId: 1, attempt: 1, reasoning: '想', text: '', optimizingSince: null } } });

	reconnected(queryClient, true);
	assert.deepEqual(invalidated(), [true, true, false, false]);
	assert.deepEqual(useStreams.getState().streams, {});

	reconnected(queryClient, false);
	assert.deepEqual(invalidated(), [true, true, true, true]);
});
