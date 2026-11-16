import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { temporaryDirectory } from '../testing.ts';
import { BrowserBlocklist, parseBlockedHost } from './blocklist.ts';

test('禁止访问的网址的写法：主机名或 IP 可以带端口，整个网址只取主机名和端口，统一成小写；不支持通配符', () => {
	const text = (input: string) => parseBlockedHost(input).text;
	assert.equal(text(' Example.COM '), 'example.com');
	assert.equal(text('example.com.'), 'example.com');
	assert.equal(text('localhost:8888'), 'localhost:8888');
	assert.equal(text('example.com:80'), 'example.com:80');
	assert.equal(text('example.com/path?q=1'), 'example.com');
	assert.equal(text('https://Sub.Example.com/a/b#c'), 'sub.example.com');
	assert.equal(text('http://192.168.1.1:8080/admin'), '192.168.1.1:8080');
	assert.equal(text('[::1]:3000'), '[::1]:3000');
	assert.equal(text('例子.中国'), 'xn--fsqu00a.xn--fiqs8s');
	assert.throws(() => parseBlockedHost('  '), /不能为空/);
	assert.throws(() => parseBlockedHost('*.example.com'), /不支持通配符/);
	assert.throws(() => parseBlockedHost('example.com:99999'), /端口/);
	assert.throws(() => parseBlockedHost('file:///C:/a.html'), /缺少主机名/);
	assert.throws(() => parseBlockedHost('exa mple.com'), /主机名格式有误/);
	for (const input of ['sds', 'abc!!', 'a_b.com', 'x..com', '-x-.com', 'a$b.com']) assert.throws(() => parseBlockedHost(input), /不是有效的域名或 IP/, input);
	for (const input of ['1.2.3', '2852039166', '010.1.1.1']) assert.throws(() => parseBlockedHost(input), /4 段数字/, input);
});

test('禁止访问的网址怎么算：域名包括子域名，不写端口时所有端口，本机地址算同一个，IP 要完全一样；运行时的网页端总是禁止', () => {
	let port: number | undefined;
	const blocklist = new BrowserBlocklist(undefined, () => port);
	blocklist.set(['example.com', 'localhost:8888', '192.168.1.1']);
	const reason = (url: string) => blocklist.reason(new URL(url));
	assert.equal(reason('https://example.com/'), '用户禁止访问 example.com');
	assert.equal(reason('http://a.b.example.com:8080/x'), '用户禁止访问 example.com');
	assert.equal(reason('wss://example.com/socket'), '用户禁止访问 example.com');
	assert.equal(reason('https://notexample.com/'), undefined);
	assert.equal(reason('http://127.0.0.1:8888/'), '用户禁止访问 localhost:8888');
	assert.equal(reason('http://[::1]:8888/'), '用户禁止访问 localhost:8888');
	assert.equal(reason('http://localhost:8889/'), undefined);
	assert.equal(reason('http://192.168.1.1/'), '用户禁止访问 192.168.1.1');
	assert.equal(reason('http://192.168.1.10/'), undefined);
	assert.equal(reason('file:///C:/example.com'), undefined);

	assert.equal(reason('http://127.0.0.1:4800/'), undefined);
	assert.deepEqual(blocklist.snapshot(), { runtime: null, hosts: ['example.com', 'localhost:8888', '192.168.1.1'] });
	port = 4800;
	assert.equal(reason('http://localhost:4800/v1/state'), '不能打开运行时的网页端');
	assert.equal(reason('ws://127.0.0.1:4800/'), '不能打开运行时的网页端');
	assert.equal(blocklist.snapshot().runtime, '127.0.0.1:4800');
});

test('禁止访问的网址存在文件里：整个替换、去掉重复，有一项不对时什么都不改；读文件时写错的项跳过，读不出来当作没有', t => {
	const directory = temporaryDirectory(t);
	const path = join(directory, 'browser-blocklist.json');
	let changes = 0;
	const blocklist = new BrowserBlocklist(path, () => undefined, () => changes++);
	assert.deepEqual(blocklist.snapshot().hosts, []);
	blocklist.set(['Example.com', 'https://example.com/a', 'localhost:8888']);
	assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), ['example.com', 'localhost:8888']);
	assert.equal(changes, 1);
	assert.throws(() => blocklist.set(['a.com', '*.b.com']), /「\*\.b\.com」格式有误：不支持通配符/);
	assert.throws(() => blocklist.set('a.com'), /hosts 必须是字符串数组/);
	assert.deepEqual(blocklist.snapshot().hosts, ['example.com', 'localhost:8888']);
	assert.equal(changes, 1);
	assert.deepEqual(new BrowserBlocklist(path, () => undefined).snapshot().hosts, ['example.com', 'localhost:8888']);

	t.mock.method(console, 'warn', () => undefined);
	writeFileSync(path, JSON.stringify(['a.com', '*.b.com', 'c.com:0']));
	assert.deepEqual(new BrowserBlocklist(path, () => undefined).snapshot().hosts, ['a.com']);
	writeFileSync(path, '{ broken');
	assert.deepEqual(new BrowserBlocklist(path, () => undefined).snapshot().hosts, []);
});
