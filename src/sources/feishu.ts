/**
 * 内置的飞书事件来源：用官方 SDK 的长连接接收「接收消息」事件，每条消息推一个事件；工具 reply 发消息。
 * 环境变量 FEISHU_APP_ID、FEISHU_APP_SECRET 是飞书开放平台上企业自建应用的凭证。
 */
import { inspect } from 'node:util';
import * as lark from '@larksuiteoapi/node-sdk';
import { errorMessage } from '../common/errors.ts';
import { Channel, requiredEnv, type IChannelTool } from './channel.ts';
import { messageText } from './feishuMessage.ts';

/** 查名字最多等多久，免得卡住后面的消息。 */
const LOOKUP_TIMEOUT_MS = 5000;
/** 查名字失败后多久内不再查。 */
const LOOKUP_RETRY_MS = 10 * 60 * 1000;

type ReceiveEvent = Parameters<NonNullable<Parameters<lark.EventDispatcher['register']>[0]['im.message.receive_v1']>>[0];

/** 调接口用的 SDK 不写日志：出错时它的日志带着请求内容，错误由调用的地方处理。 */
const silent = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {}, trace: () => {} };

/** 长连接的警告和错误（断开、重连失败）写到 stderr，成为来源的警告：断开期间的消息收不到。 */
const connectionLogger = {
	...silent,
	error: (...args: unknown[]) => console.error(`飞书长连接：${logText(args)}`),
	warn: (...args: unknown[]) => console.error(`飞书长连接：${logText(args)}`),
};

/** SDK 日志的参数写成一行。 */
function logText(args: readonly unknown[]): string {
	return args
		.filter(arg => arg !== '[ws]')
		.map(arg => arg instanceof Error ? arg.message : typeof arg === 'string' ? arg : inspect(arg, { breakLength: Infinity }))
		.join(' ')
		.replace(/\s*\n\s*/g, ' ');
}

interface IFeishuResponse<T> {
	readonly code?: number;
	readonly msg?: string;
	readonly data?: T;
}

/** 飞书接口的结果；出错时抛出飞书给的原因。 */
function unwrap<T>(response: IFeishuResponse<T>): T | undefined {
	if (response.code !== undefined && response.code !== 0) throw new Error(`飞书返回错误 ${response.code}：${response.msg ?? ''}`);
	return response.data;
}

/** 出错的原因：飞书接口返回的错误（如缺权限时 HTTP 400）写飞书给的错误码和说明。 */
export function errorText(error: unknown): string {
	const data = (error as { response?: { data?: unknown } } | null | undefined)?.response?.data as { code?: unknown; msg?: unknown } | undefined;
	if (typeof data?.code === 'number') return `飞书返回错误 ${data.code}：${typeof data.msg === 'string' ? data.msg : ''}`;
	return errorMessage(error);
}

/** 查过的名字：查到的一直用，查不到的过一阵再查。 */
class Names {
	private readonly found = new Map<string, string>();
	private readonly failed = new Map<string, number>();

	/** what：查的是什么，写在警告里，如「发送人 ou_…」。 */
	async get(key: string, what: string, lookup: () => Promise<string | undefined>): Promise<string | undefined> {
		const known = this.found.get(key);
		if (known !== undefined) return known;
		if (Date.now() - (this.failed.get(key) ?? -Infinity) < LOOKUP_RETRY_MS) return undefined;
		try {
			const name = await Promise.race([lookup(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('超时')), LOOKUP_TIMEOUT_MS))]);
			if (name) {
				this.found.set(key, name);
				return name;
			}
			console.error(`查询${what}的名称无结果`);
		} catch (error) {
			console.error(`查询${what}的名称失败：${errorText(error)}`);
		}
		this.failed.set(key, Date.now());
		return undefined;
	}
}

function replyTool(client: lark.Client): IChannelTool {
	return {
		name: 'reply',
		description: '在飞书发送一条文本消息：提供 message_id 时回复该消息，否则发送到 chat_id 对应的会话。两个 ID 均位于事件的 meta 中。',
		inputSchema: {
			type: 'object',
			properties: {
				text: { type: 'string', description: '消息文本' },
				message_id: { type: 'string', description: '要回复的消息' },
				chat_id: { type: 'string', description: '要发送到的会话' },
			},
			required: ['text'],
		},
		call: async args => {
			const text = args['text'];
			const messageId = args['message_id'];
			const chatId = args['chat_id'];
			if (typeof text !== 'string' || !text.trim()) throw new Error('text 不能为空');
			const content = JSON.stringify({ text });
			const reply = typeof messageId === 'string' && messageId;
			if (!reply && !(typeof chatId === 'string' && chatId)) throw new Error('须提供 message_id 或 chat_id');
			let data: { message_id?: string } | undefined;
			try {
				data = reply
					? unwrap(await client.im.v1.message.reply({ path: { message_id: messageId }, data: { content, msg_type: 'text' } }))
					: unwrap(await client.im.v1.message.create({ params: { receive_id_type: 'chat_id' }, data: { receive_id: chatId as string, content, msg_type: 'text' } }));
			} catch (error) {
				throw new Error(errorText(error));
			}
			return `已发送，消息 ID ${data?.message_id ?? '未知'}`;
		},
	};
}

async function main(): Promise<void> {
	const appId = requiredEnv('FEISHU_APP_ID');
	const appSecret = requiredEnv('FEISHU_APP_SECRET');
	const client = new lark.Client({ appId, appSecret, logger: silent });
	// 先查机器人自己：凭证不对时在这里就失败，运行时显示原因。
	let botOpenId: string;
	try {
		const info = await client.request<{ code?: number; msg?: string; bot?: { open_id?: string } }>({ method: 'GET', url: '/open-apis/bot/v3/info' });
		if (info.code !== 0 || !info.bot?.open_id) throw new Error(`飞书返回错误 ${info.code}：${info.msg ?? ''}，须开启机器人能力`);
		botOpenId = info.bot.open_id;
	} catch (error) {
		console.error(`连接飞书应用失败：${errorText(error)}`);
		process.exit(1);
	}

	const channel = new Channel('feishu', [replyTool(client)]);
	await channel.start();
	const names = new Names();

	/** 一条消息变成事件：查发送人和群的名字，查不到的不写。 */
	const handle = async (event: ReceiveEvent) => {
		const { message, sender } = event;
		const openId = sender.sender_id?.open_id;
		const user = sender.sender_type === 'user';
		const mentions = (message.mentions ?? []).map(mention => ({ key: mention.key, name: mention.name, openId: mention.id.open_id }));
		const senderName = openId && user
			? await names.get(openId, `发送人 ${openId} `, async () => unwrap(await client.contact.v3.user.get({ path: { user_id: openId }, params: { user_id_type: 'open_id' } }))?.user?.name)
			: undefined;
		const chatName = message.chat_type === 'group'
			? await names.get(message.chat_id, `群 ${message.chat_id} `, async () => unwrap(await client.im.v1.chat.get({ path: { chat_id: message.chat_id } }))?.name)
			: undefined;
		await channel.emit(messageText(message.message_type, message.content, mentions), {
			event_id: event.event_id,
			chat_id: message.chat_id,
			chat_type: message.chat_type,
			chat_name: chatName,
			message_id: message.message_id,
			sender_id: openId,
			sender_name: senderName,
			sender_type: user ? 'user' : 'bot',
			mentioned_bot: String(mentions.some(mention => mention.openId === botOpenId)),
		});
	};

	// 收到就确认（飞书要求 3 秒内），查名字、推送放在后面，按收到的先后一个一个来。
	let queue = Promise.resolve();
	const dispatcher = new lark.EventDispatcher({ logger: silent }).register({
		'im.message.receive_v1': event => {
			queue = queue.then(() => handle(event)).catch(error => console.error(`处理飞书消息失败：${errorText(error)}`));
		},
	});
	const ws = new lark.WSClient({
		appId, appSecret, logger: connectionLogger, loggerLevel: lark.LoggerLevel.warn,
		// 重连用完了还连不上：退出，运行时显示连接失败和原因。
		onError: error => {
			console.error(`飞书长连接失败：${error.message}`);
			process.exit(1);
		},
	});
	await ws.start({ eventDispatcher: dispatcher });
}

if (import.meta.main) await main();
