import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertMemberName } from '../../../src/common/names.ts';
import { MEMBER_NAME_CANDIDATES, MEMBER_NAME_GIVEN, MEMBER_NAME_SURNAMES, suggestMemberName } from './memberNames.ts';

function validName(name: string): boolean {
	try {
		assertMemberName(name);
		return name.length >= 2 && name.length <= 3;
	} catch {
		return false;
	}
}

test('名单不重复，每个都是 2 到 3 个字的合法成员名', () => {
	const invalid = MEMBER_NAME_CANDIDATES.filter(name => !validName(name));
	const duplicates = MEMBER_NAME_CANDIDATES.filter((name, index) => MEMBER_NAME_CANDIDATES.indexOf(name) !== index);
	assert.deepEqual({ count: MEMBER_NAME_CANDIDATES.length, invalid, duplicates }, { count: 500, invalid: [], duplicates: [] });
});

test('名单和组合用字都是最常用的 3755 个汉字（GB2312 一级字），容易用输入法打出来', () => {
	const decoder = new TextDecoder('gb18030');
	const common = new Set<string>();
	for (let high = 0xB0; high <= 0xD7; high++) {
		for (let low = 0xA1; low <= (high === 0xD7 ? 0xF9 : 0xFE); low++) common.add(decoder.decode(new Uint8Array([high, low])));
	}
	const uncommon = [...MEMBER_NAME_CANDIDATES.join(''), ...MEMBER_NAME_SURNAMES, ...MEMBER_NAME_GIVEN].filter(char => !common.has(char));
	assert.deepEqual(uncommon, []);
});

test('避开被占用的名字和当前名字', () => {
	const occupied = MEMBER_NAME_CANDIDATES.slice(0, -2);
	const [second, last] = MEMBER_NAME_CANDIDATES.slice(-2);
	assert.deepEqual([suggestMemberName(occupied, undefined, () => 0), suggestMemberName(occupied, second, () => 0)], [second, last]);
});

test('名单用完后随机组合，组合出的名字也合法、不重复', () => {
	let seed = 1;
	const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
	const occupied = new Set(MEMBER_NAME_CANDIDATES);
	for (let index = 0; index < 50; index++) {
		const name = suggestMemberName(occupied, undefined, random);
		assert.ok(name && !occupied.has(name) && validName(name), name);
		occupied.add(name);
	}
});
