import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fitPanes, resizeWithin } from './panes.ts';

// 图标栏 56，列表栏 220–320，中间至少 440，宽的那一栏至少 360、不设上限，概况栏 280–480。
test('放得下时用拖出来的宽度，超出范围的按最窄、最宽算；没打开的栏是 0', () => {
	assert.deepEqual(fitPanes(1800, { list: 300, wide: 560, overview: 320 }), { list: 300, wide: 560, overview: 320, docked: true });
	assert.deepEqual(fitPanes(3000, { list: 100, wide: 2000, overview: 100 }), { list: 220, wide: 2000, overview: 280, docked: true });
	assert.deepEqual(fitPanes(3000, { list: 420, wide: 300, overview: 600 }), { list: 320, wide: 360, overview: 480, docked: true });
	assert.deepEqual(fitPanes(1600, { list: 300, wide: 0, overview: 0 }), { list: 300, wide: 0, overview: 0, docked: true });
});

test('窗口变窄时依次挤概况栏、宽的那一栏、列表栏，还放不下时功能区盖在中间上', () => {
	// 1600 - 56 - 440 - 300 - 560 = 244：概况栏 320 挤到最窄 280 还多 36，宽的那一栏挤到 524。
	assert.deepEqual(fitPanes(1600, { list: 300, wide: 560, overview: 320 }), { list: 300, wide: 524, overview: 280, docked: true });
	// 1400 - 56 - 440 = 904：概况栏 280、宽的那一栏 360，列表栏挤到 264。
	assert.deepEqual(fitPanes(1400, { list: 300, wide: 560, overview: 320 }), { list: 264, wide: 360, overview: 280, docked: true });
	// 1300：都挤到最窄也放不下，功能区盖在中间上，用拖的宽度；列表栏按没有功能区算。
	assert.deepEqual(fitPanes(1300, { list: 300, wide: 560, overview: 320 }), { list: 300, wide: 560, overview: 320, docked: false });
	// 700：列表栏挤到最窄，中间只能比最窄宽度更窄；功能区最多占 630，先挤概况栏，再挤宽的那一栏。
	assert.deepEqual(fitPanes(700, { list: 300, wide: 560, overview: 320 }), { list: 220, wide: 360, overview: 270, docked: false });
});

test('终端最大化时中间隐藏，只给终端留最窄宽度', () => {
	assert.deepEqual(fitPanes(1200, { list: 300, wide: 0, overview: 320 }, 360), { list: 300, wide: 0, overview: 320, docked: true });
});

test('宽的那一栏不设上限：大窗口里也能拖到中间只剩最窄宽度', () => {
	// 2560 - 56 - 288 - 440 = 1776，两边都是同样的 440。
	assert.deepEqual(fitPanes(2560, { list: 288, wide: 1776, overview: 0 }), { list: 288, wide: 1776, overview: 0, docked: true });
	assert.deepEqual(fitPanes(1920, { list: 288, wide: 1136, overview: 0 }), { list: 288, wide: 1136, overview: 0, docked: true });
});

test('拖宽一栏：先用空着的，再挤另一栏到它的最窄；往回拖另一栏跟着回来，但不比开始时宽', () => {
	const overview = { min: 280, max: 480 };
	// 两栏最多 1200，工作台 800：概况栏 320 → 400 用空着的 80，工作台不动。
	assert.deepEqual(resizeWithin(400, overview, 1200, { width: 800, min: 360 }), [400, 800]);
	// 空着的没有了，概况栏拉到 450，工作台让出 50。
	assert.deepEqual(resizeWithin(450, overview, 1200, { width: 800, min: 360 }), [450, 750]);
	// 概况栏自己最宽 480。
	assert.deepEqual(resizeWithin(700, overview, 1200, { width: 800, min: 360 }), [480, 720]);
	// 另一栏挤到它的最窄 360 为止。
	assert.deepEqual(resizeWithin(470, overview, 800, { width: 500, min: 360 }), [440, 360]);
	// 往回拖到 300：另一栏回到开始时的 800，不会更宽。
	assert.deepEqual(resizeWithin(300, overview, 1200, { width: 800, min: 360 }), [300, 800]);
	// 没有另一栏时只受 room 和自己的范围限制；小数四舍五入。
	assert.deepEqual(resizeWithin(2000.4, { min: 360, max: Infinity }, 1500, { width: 0, min: 0 }), [1500, 0]);
	assert.deepEqual(resizeWithin(100, overview, 1500, { width: 0, min: 0 }), [280, 0]);
});
