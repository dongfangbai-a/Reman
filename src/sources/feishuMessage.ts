/** 消息里点名的人：正文里写成 key（如 @_user_1）。 */
export interface IMention {
	readonly key: string;
	readonly name: string;
}

/** 正文里只能写成占位的消息。 */
const PLACEHOLDERS: Readonly<Record<string, string>> = {
	image: '[图片]',
	audio: '[语音]',
	sticker: '[表情]',
	interactive: '[卡片]',
	share_chat: '[群名片]',
	share_user: '[个人名片]',
	merge_forward: '[合并转发的消息]',
	system: '[系统消息]',
};

/** 收到的飞书消息转成文字：文本、富文本照写，@ 换成名字；图片、文件等写成「[图片]」「[文件 名字]」。 */
export function messageText(type: string, content: string, mentions: readonly IMention[] = []): string {
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(content) as Record<string, unknown>;
	} catch {
		return content;
	}
	const string = (key: string) => typeof parsed[key] === 'string' ? parsed[key] : '';
	switch (type) {
		case 'text':
			return replaceMentions(string('text'), mentions);
		case 'post':
			return postText(parsed, mentions);
		case 'file':
			return `[文件 ${string('file_name')}]`;
		case 'media':
			return `[视频 ${string('file_name')}]`;
		case 'location':
			return `[位置 ${string('name')}]`;
		default:
			return PLACEHOLDERS[type] ?? `[${type} 消息]`;
	}
}

function replaceMentions(text: string, mentions: readonly IMention[]): string {
	let result = text.replaceAll('@_all', '@所有人');
	for (const mention of mentions) result = result.replaceAll(mention.key, `@${mention.name}`);
	return result;
}

/** 富文本：标题一行，下面每段一行。收到的内容可能直接是 { title, content }，也可能按语言包一层。 */
function postText(parsed: Record<string, unknown>, mentions: readonly IMention[]): string {
	const post = (Array.isArray(parsed['content']) ? parsed : Object.values(parsed).find(value => typeof value === 'object' && value !== null && Array.isArray((value as Record<string, unknown>)['content']))) as
		{ title?: unknown; content: unknown[] } | undefined;
	if (!post) return '';
	const lines = post.content.map(paragraph => Array.isArray(paragraph) ? paragraph.map(element => elementText(element as Record<string, unknown>, mentions)).join('') : '');
	return [typeof post.title === 'string' ? post.title : '', ...lines].filter(line => line !== '').join('\n');
}

function elementText(element: Record<string, unknown>, mentions: readonly IMention[]): string {
	const field = (key: string) => typeof element[key] === 'string' ? element[key] : '';
	switch (element['tag']) {
		case 'text':
			return replaceMentions(field('text'), mentions);
		case 'a':
			return field('text') && field('text') !== field('href') ? `${field('text')}（${field('href')}）` : field('href');
		case 'at': {
			const name = field('user_name') || mentions.find(mention => mention.key === field('user_id'))?.name;
			return field('user_id') === '@_all' ? '@所有人' : `@${name ?? field('user_id')}`;
		}
		case 'img':
			return '[图片]';
		case 'media':
			return '[视频]';
		case 'emotion':
			return `[${field('emoji_type')}]`;
		case 'code_block':
			return `\n\`\`\`${field('language').toLowerCase()}\n${field('text')}\n\`\`\`\n`;
		case 'hr':
			return '\n---\n';
		default:
			return field('text');
	}
}
