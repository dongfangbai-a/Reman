import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Secrets } from '../common/secrets.ts';
import { temporaryDirectory } from '../testing.ts';
import { parseHostList, parseHostname, Tunnel } from './tunnel.ts';

/** 只测不启动进程的部分：域名校验、设置的存取、状态里拼出来的地址。 */
function testTunnel(t: Parameters<typeof temporaryDirectory>[0], options: { port?: number } = {}) {
	const directory = temporaryDirectory(t);
	return { directory, tunnel: new Tunnel({
		settingsPath: join(directory, 'remote.json'),
		secrets: Secrets.temporary(),
		port: () => options.port ?? 6001,
		accessToken: () => 'TOKEN',
	}) };
}

test('公网访问的域名：只收自己的域名，本机地址、IP、带协议端口路径的不收', () => {
	assert.equal(parseHostname(' Human.Example.COM. '), 'human.example.com');
	assert.equal(parseHostname('myreman.mingyue.work'), 'myreman.mingyue.work');
	assert.equal(parseHostname(''), null);
	assert.equal(parseHostname(null), null);
	assert.equal(parseHostname('human.example.com.'), 'human.example.com', '结尾的点去掉');
	for (const value of ['localhost', 'a.localhost', '127.0.0.1', 'https://a.com', 'a.com:443', 'a.com/x', 'a_b.com', 'a..b', '::1', '[::1]', 'http://a.com/']) {
		assert.throws(() => parseHostname(value), value);
	}
});

test('Tailscale 之类的额外域名：数组或逗号分开的字符串都收，去重，不合法的不收', () => {
	assert.deepEqual(parseHostList(['a.example.com', 'B.example.com', 'a.example.com']), ['a.example.com', 'b.example.com']);
	assert.deepEqual(parseHostList('a.example.com, b.example.com'), ['a.example.com', 'b.example.com']);
	assert.deepEqual(parseHostList(''), []);
	assert.deepEqual(parseHostList(null), []);
	assert.throws(() => parseHostList(42), /字符串或字符串数组/);
	assert.throws(() => parseHostList(['a.example.com', 'http://b.example.com']), /只填域名/);
	assert.throws(() => parseHostList(['127.0.0.1']), /IP 地址/);
});

test('额外域名不用打开隧道也接受，链接只给配过的域名', async t => {
	const { tunnel } = testTunnel(t);
	t.after(() => tunnel.shutdown());
	assert.equal(tunnel.allowsHost('human.tail1234.ts.net'), false);
	const status = tunnel.update({ hostnames: ['human.tail1234.ts.net'] });
	assert.deepEqual(status.hostnames, ['human.tail1234.ts.net']);
	assert.equal(tunnel.allowsHost('human.tail1234.ts.net'), true);
	assert.equal(tunnel.allowsHost('human.example.com'), false);
	assert.equal(tunnel.linkTo('human.tail1234.ts.net'), 'https://human.tail1234.ts.net/#token=TOKEN');
	assert.equal(tunnel.linkTo('other.example.com'), null);
	// 隧道自己的域名照旧跟着开关走
	tunnel.update({ hostname: 'human.example.com', token: 'abcdef1234', enabled: true });
	assert.equal(tunnel.allowsHost('human.example.com'), true);
	assert.equal(tunnel.linkTo('human.example.com'), 'https://human.example.com/#token=TOKEN', '隧道域名也认');
	tunnel.update({ enabled: false });
	assert.equal(tunnel.allowsHost('human.example.com'), false);
	assert.equal(tunnel.linkTo('human.example.com'), null);
	assert.equal(tunnel.allowsHost('human.tail1234.ts.net'), true, '额外域名和隧道开关无关');
	// 清空
	assert.deepEqual(tunnel.update({ hostnames: [] }).hostnames, []);
});

test('公网访问：打开前要填域名和 token，token 加密保存，链接带令牌', async t => {
	const { directory, tunnel } = testTunnel(t);
	t.after(() => tunnel.shutdown());
	assert.throws(() => tunnel.update({ enabled: true }), /主机名和隧道 token/);

	const status = tunnel.update({ hostname: 'human.example.com', token: 'abcdef1234', enabled: true });
	assert.equal(status.enabled, true);
	assert.equal(status.hostname, 'human.example.com');
	assert.equal(status.tokenTail, '1234');
	assert.equal(status.origin, 'http://127.0.0.1:6001');
	assert.equal(tunnel.link(), 'https://human.example.com/#token=TOKEN');
	// 关掉以后不再给链接：那个域名这时已经不接受请求了。
	tunnel.update({ enabled: false });
	assert.equal(tunnel.link(), null);
	tunnel.update({ enabled: true });
	// 文件里只有密文
	const saved = readFileSync(join(directory, 'remote.json'), 'utf8');
	assert.ok(saved.includes('enc:v1:'));
	assert.ok(!saved.includes('abcdef1234'));
	// 没有 cloudflared 时不会起进程
	assert.equal(status.process.kind, 'off');
	assert.equal(tunnel.running, false);
});

test('公网访问：关掉以后域名不再被接受，设置重启后还在', async t => {
	const { directory, tunnel } = testTunnel(t);
	t.after(() => tunnel.shutdown());
	tunnel.update({ hostname: 'human.example.com', token: 'abcdef1234', enabled: true });
	assert.equal(tunnel.hostname, 'human.example.com');
	tunnel.update({ enabled: false });
	assert.equal(tunnel.hostname, null);
	// 换一个实例读同一份设置
	const again = new Tunnel({ settingsPath: join(directory, 'remote.json'), secrets: Secrets.temporary(), port: () => 6001, accessToken: () => 'TOKEN' });
	assert.equal(again.status().enabled, false);
	assert.equal(again.status().hostname, 'human.example.com');
	assert.equal(again.status().tokenTail, null, '换了钥匙解不开 token，就不显示末四位');
	await again.shutdown();
});

test('公网访问：上次强杀留下的 pid 不是 cloudflared 就不动它，文件照样清掉', async t => {
	const directory = temporaryDirectory(t);
	const pidPath = join(directory, 'cloudflared.pid');
	// 拿当前这个 node 进程当「pid 被别的程序用了」的情况。
	writeFileSync(pidPath, `${JSON.stringify({ pid: process.pid, startedAt: Date.now() })}\n`);
	const tunnel = new Tunnel({ settingsPath: join(directory, 'remote.json'), directory, port: () => 6001, accessToken: () => 'TOKEN' });
	t.after(() => tunnel.shutdown());
	assert.equal(existsSync(pidPath), false);
	assert.doesNotThrow(() => process.kill(process.pid, 0), '自己的进程还在');
	// 文件内容坏了也不影响启动。
	writeFileSync(pidPath, '不是 JSON');
	new Tunnel({ settingsPath: join(directory, 'remote.json'), directory, port: () => 6001, accessToken: () => 'TOKEN' });
	assert.equal(existsSync(pidPath), false);
});

test('公网访问：端口变了，状态里的服务地址跟着变', async t => {
	let port = 6001;
	const directory = temporaryDirectory(t);
	const tunnel = new Tunnel({ settingsPath: join(directory, 'remote.json'), port: () => port, accessToken: () => 'TOKEN' });
	t.after(() => tunnel.shutdown());
	assert.equal(tunnel.status().origin, 'http://127.0.0.1:6001');
	port = 6002;
	assert.equal(tunnel.status().origin, 'http://127.0.0.1:6002');
});
