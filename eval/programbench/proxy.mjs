// ProgramBench 用的白名单代理：容器出网只放行指定的域名，别的一律拒绝。
//
//   node eval/programbench/proxy.mjs            # 监听 0.0.0.0:3128，只放行 api.deepseek.com:443
//   ALLOW=api.deepseek.com,hf.co PORT=3129 node eval/programbench/proxy.mjs
//
// 为什么不用 docker 的网络规则：iptables 只能按 IP/端口过滤，而 api.deepseek.com 是 CDN，IP 会变；
// 域名级白名单只能在这一层做。真正的「出不去」由 docker 的内网（`docker network create --internal`）
// 保证——任务容器只接内网，唯一能连的另一个容器就是本代理。
//
// 支持的两种请求：
//   CONNECT host:443          HTTPS 隧道，按 host 判断
//   GET http://host/path     明文代理，按 URL 里的 host 判断
import { createServer, request } from 'node:http';
import { connect } from 'node:net';

const PORT = Number(process.env.PORT ?? 3128);
const HOST = process.env.HOST ?? '0.0.0.0';
/** 允许的域名，逗号分隔；只写域名（不带端口），子域按后缀匹配。 */
const ALLOW = (process.env.ALLOW ?? 'api.deepseek.com')
	.split(',').map(item => item.trim().toLowerCase()).filter(Boolean);

function allowed(hostname) {
	const host = hostname.toLowerCase();
	return ALLOW.some(domain => host === domain || host.endsWith(`.${domain}`));
}

function log(message) {
	process.stdout.write(`${new Date().toISOString().slice(11, 19)} ${message}\n`);
}

// 一个连接出错不该把整个代理带走：客户端随时可能重置连接（模型流式输出时尤其常见）。
process.on('uncaughtException', error => log(`未捕获的异常（继续服务）：${error.message}`));
process.on('unhandledRejection', error => log(`未处理的 rejection（继续服务）：${error}`));

const server = createServer((req, res) => {
	// 明文代理：请求行里是绝对 URL。
	let target;
	try {
		target = new URL(req.url ?? '');
	} catch {
		res.writeHead(400).end('代理只接受绝对 URL\n');
		return;
	}
	if (!allowed(target.hostname)) {
		log(`拒绝 ${target.hostname}`);
		res.writeHead(403).end(`不允许访问 ${target.hostname}\n`);
		return;
	}
	const upstream = request({
		host: target.hostname, port: target.port || 80, path: target.pathname + target.search,
		method: req.method, headers: req.headers,
	}, response => {
		res.writeHead(response.statusCode ?? 502, response.headers);
		response.pipe(res);
	});
	upstream.on('error', error => {
		if (!res.headersSent) res.writeHead(502);
		res.end(`上游出错：${error.message}\n`);
	});
	req.on('error', () => upstream.destroy());
	res.on('error', () => upstream.destroy());
	req.pipe(upstream);
});

server.on('connect', (req, socket, head) => {
	const [hostname, portText] = (req.url ?? '').split(':');
	if (!allowed(hostname)) {
		log(`拒绝 CONNECT ${hostname}:${portText}`);
		socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
		return;
	}
	const upstream = connect(Number(portText || 443), hostname, () => {
		socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
		if (head.length > 0) upstream.write(head);
		upstream.pipe(socket);
		socket.pipe(upstream);
	});
	upstream.on('error', error => {
		log(`上游出错 ${hostname}：${error.message}`);
		socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
	});
	socket.on('error', () => upstream.destroy());
	upstream.setTimeout(0);
	upstream.setKeepAlive(true, 30_000);
	socket.setKeepAlive(true, 30_000);
});

// 客户端在 TLS 握手阶段直接断开这类情况，也按连接级错误处理。
server.on('clientError', (error, socket) => {
	log(`客户端连接出错：${error.message}`);
	socket.destroy();
});

server.listen(PORT, HOST, () => {
	log(`白名单代理 ${HOST}:${PORT}，放行：${ALLOW.join('、')}`);
});
