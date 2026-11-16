import assert from 'node:assert/strict';
import { test } from 'node:test';
import { errorText } from './feishu.ts';
import { messageText } from './feishuMessage.ts';

test('飞书接口出错的原因：写飞书返回的错误码和说明，不是 HTTP 状态', () => {
	const denied = Object.assign(new Error('Request failed with status code 400'), { response: { status: 400, data: { code: 99991672, msg: 'Access denied' } } });
	assert.equal(errorText(denied), '飞书返回错误 99991672：Access denied');
	assert.equal(errorText(new Error('超时')), '超时');
});

test('飞书消息转成文字：文本、富文本照写，@ 换成名字；图片、文件写成占位', () => {
	const mentions = [{ key: '@_user_1', name: '机器人' }, { key: '@_user_2', name: '张三' }];
	assert.equal(messageText('text', JSON.stringify({ text: '@_user_1 帮 @_user_2 看下 @_all' }), mentions), '@机器人 帮 @张三 看下 @所有人');
	const post = {
		title: '发布说明',
		content: [
			[{ tag: 'at', user_id: '@_user_1', user_name: '机器人' }, { tag: 'text', text: ' 看这里：' }, { tag: 'a', text: '文档', href: 'https://example.com/doc' }],
			[{ tag: 'img', image_key: 'img_1' }, { tag: 'emotion', emoji_type: 'SMILE' }],
			[{ tag: 'code_block', language: 'JS', text: 'run()' }],
		],
	};
	assert.equal(messageText('post', JSON.stringify(post), mentions), '发布说明\n@机器人 看这里：文档（https://example.com/doc）\n[图片][SMILE]\n\n```js\nrun()\n```\n');
	assert.equal(messageText('post', JSON.stringify({ zh_cn: { title: '', content: [[{ tag: 'text', text: '按语言包一层' }]] } })), '按语言包一层');
	assert.equal(messageText('image', JSON.stringify({ image_key: 'img_1' })), '[图片]');
	assert.equal(messageText('file', JSON.stringify({ file_key: 'f', file_name: '周报.pdf' })), '[文件 周报.pdf]');
	assert.equal(messageText('vote', '{}'), '[vote 消息]');
});
