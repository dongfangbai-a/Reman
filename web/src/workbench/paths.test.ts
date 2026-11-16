import assert from 'node:assert/strict';
import { test } from 'node:test';
import { directoryOf, fixSpacedLinks, isFullPath, linkedFile, resolvePath, toolFilePath } from './paths.ts';

test('完整路径：盘符路径总是认，/ 开头的只在运行时不在 Windows 上时认', () => {
	assert.equal(isFullPath('E:\\work\\a.md', 'win32'), true);
	assert.equal(isFullPath('E:/work/a.md', 'linux'), true);
	assert.equal(isFullPath('/v1/state', 'win32'), false);
	assert.equal(isFullPath('/home/me/a.md', 'linux'), true);
	assert.equal(isFullPath('docs/a.md', 'linux'), false);
});

test('链接指向的文件：网址和相对路径不算，file: 网址和编码过的路径解开', () => {
	assert.equal(linkedFile('https://example.com/a.md', 'win32'), undefined);
	assert.equal(linkedFile('docs/a.md', 'win32'), undefined);
	assert.equal(linkedFile('E:/My%20Docs/a.md', 'win32'), 'E:/My Docs/a.md');
	assert.equal(linkedFile('file:///E:/work/a.md', 'win32'), 'E:/work/a.md');
	assert.equal(linkedFile('file:///home/me/a.md', 'linux'), '/home/me/a.md');
});

test('相对路径按文件所在的目录算，分隔符跟着目录', () => {
	assert.equal(resolvePath(directoryOf('E:\\work\\docs\\a.md'), '../img/b.png'), 'E:\\work\\img\\b.png');
	assert.equal(resolvePath(directoryOf('/home/me/a.md'), './b.md'), '/home/me/b.md');
	assert.equal(resolvePath(directoryOf('E:/a.md'), 'b.md'), 'E:/b.md');
});

test('有空格的完整路径写进链接时补成 <...>，别的不动', () => {
	assert.equal(fixSpacedLinks('看 [报告](E:/My Docs/a.md) 和 [站](https://a.com/x)'), '看 [报告](<E:/My Docs/a.md>) 和 [站](https://a.com/x)');
	assert.equal(fixSpacedLinks('[a](docs/my file.md)'), '[a](docs/my file.md)');
});

test('工具参数里的路径和运行时执行时一样算：相对工作目录，去引号，认 file: 网址和 Windows 上的 bash 写法', () => {
	const directory = 'C:\\Users\\me\\workspaces\\M_UVT7';
	assert.equal(toolFilePath('大宋瓦舍-第二卷.txt', directory, 'win32'), 'C:\\Users\\me\\workspaces\\M_UVT7\\大宋瓦舍-第二卷.txt');
	assert.equal(toolFilePath(' "docs/../a.md" ', directory, 'win32'), 'C:\\Users\\me\\workspaces\\M_UVT7\\a.md');
	assert.equal(toolFilePath('E:/work/a.md', directory, 'win32'), 'E:/work/a.md');
	assert.equal(toolFilePath('/c/Users/me/a.md', directory, 'win32'), 'C:\\Users\\me\\a.md');
	assert.equal(toolFilePath('/cygdrive/e/a.md', directory, 'win32'), 'E:\\a.md');
	assert.equal(toolFilePath('/E:/work/a.md', directory, 'win32'), 'E:/work/a.md');
	assert.equal(toolFilePath('\\tmp\\a.md', directory, 'win32'), 'C:\\tmp\\a.md');
	assert.equal(toolFilePath('\\\\server\\share\\a.md', directory, 'win32'), undefined);
	assert.equal(toolFilePath('file:///E:/My%20Docs/a.md', directory, 'win32'), 'E:/My Docs/a.md');
	assert.equal(toolFilePath('a.md', '/home/me/work', 'linux'), '/home/me/work/a.md');
	assert.equal(toolFilePath('/etc/hosts', '/home/me/work', 'linux'), '/etc/hosts');
	// 不知道工作目录或运行时的系统时，相对路径算不出来。
	assert.equal(toolFilePath('a.md', undefined, 'win32'), undefined);
	assert.equal(toolFilePath('a.md', directory, undefined), undefined);
	assert.equal(toolFilePath('  ', directory, 'win32'), undefined);
});
