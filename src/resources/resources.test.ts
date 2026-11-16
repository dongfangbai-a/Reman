import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { imageResourceId, resourceImage, Resources } from './resources.ts';

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
const png = (tail: string) => Buffer.concat([PNG, Buffer.from(tail)]);

function directory(t: TestContext): string {
	const path = mkdtempSync(join(tmpdir(), 'resources-'));
	t.after(() => rmSync(path, { recursive: true, force: true }));
	return path;
}

test('资源文件按内容取 8 位的短名：同样的内容只存一份，内容不同名字不同', t => {
	const resources = new Resources(directory(t));
	const id = resources.saveImage(png('一'));
	assert.match(id, /^[A-HJ-NP-Z2-9]{8}\.png$/);
	assert.equal(resources.saveImage(png('一')), id);
	assert.notEqual(resources.saveImage(png('二')), id);
	assert.deepEqual(readFileSync(resources.path(id)!), png('一'));

	const file = resources.saveFile(Buffer.from('报告内容'), '报告.pdf');
	assert.match(file, /^attachments\/[A-HJ-NP-Z2-9]{8}\/报告\.pdf$/);
	// 同样的内容换个文件名，放在同一个目录里。
	const renamed = resources.saveFile(Buffer.from('报告内容'), '副本.pdf');
	assert.equal(renamed.split('/')[1], file.split('/')[1]);
	assert.deepEqual(readFileSync(resources.path(renamed)!), Buffer.from('报告内容'));
});

test('两份不同的内容撞了名时，后存的多取一位，不会混成一个文件；再存时还能找到', t => {
	const learned = new Resources(directory(t));
	const image = learned.saveImage(png('一'));
	const file = learned.saveFile(Buffer.from('报告内容'), '报告.pdf');

	// 在另一个资源目录里，先让别的内容占住这两个名字。
	const root = directory(t);
	const resources = new Resources(root);
	writeFileSync(join(root, image), png('别的'));
	mkdirSync(join(root, 'attachments', file.split('/')[1]!), { recursive: true });
	writeFileSync(join(root, 'attachments', file.split('/')[1]!, '别的.txt'), '别的内容');

	const longer = resources.saveImage(png('一'));
	assert.equal(longer, `${image.slice(0, 8)}${longer.slice(8, 9)}.png`);
	assert.deepEqual(readFileSync(join(root, image)), png('别的'));
	assert.equal(resources.saveImage(png('一')), longer);

	const moved = resources.saveFile(Buffer.from('报告内容'), '报告.pdf');
	assert.match(moved, new RegExp(`^attachments/${file.split('/')[1]}[A-HJ-NP-Z2-9]/报告\\.pdf$`));
	assert.equal(resources.saveFile(Buffer.from('报告内容'), '报告.pdf'), moved);
});

test('不合法的 ID 不给路径', t => {
	const resources = new Resources(directory(t));
	assert.ok(resources.path('K7M2QX9P.png'));
	assert.ok(resources.path('attachments/K7M2QX9P/报告.pdf'));
	assert.equal(imageResourceId(resourceImage('K7M2QX9P.png')), 'K7M2QX9P.png');
	for (const id of ['k7m2qx9p.png', 'K7M2QX9.png', 'K7M2QX0P.png', 'K7M2QX9P', '../K7M2QX9P.png', 'attachments/K7M2QX9P/../x', 'attachments/K7M2QX9P/a\\b', `${'K'.repeat(52)}.png`]) {
		assert.equal(resources.path(id), undefined, id);
	}
	assert.equal(imageResourceId(resourceImage('attachments/K7M2QX9P/报告.pdf')), undefined);
});
