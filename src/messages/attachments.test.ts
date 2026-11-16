import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatSize } from './attachments.ts';

test('附件大小：B、KB、MB，先取整再定单位', () => {
	assert.equal(formatSize(500), '500 B');
	assert.equal(formatSize(1536), '1.5 KB');
	assert.equal(formatSize(1024 * 1024 - 1), '1.0 MB');
	assert.equal(formatSize(3 * 1024 * 1024), '3.0 MB');
});
