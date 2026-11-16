import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IScenario } from './scenarios.ts';

const ASSISTANT_PROMPT = '你是一名细心的工程师助手。做事前先想清楚，做完后简洁地汇报结果。';

export const SCENARIOS: Record<string, IScenario> = {
	single: {
		description: '单个成员干活：建文件、执行命令、按要求修改，结果私聊汇报',
		async run({ ai, say, settle, log, runtime }) {
			log(`shell：${runtime.shells.current().kind}`);
			const member = ai('小林', {}, ASSISTANT_PROMPT);
			const chat = { kind: 'direct', memberId: member.memberId } as const;
			say(chat, '请在你的工作目录里新建 notes/todo.md，写三条本周待办（内容自己编）。然后用命令统计这个文件有几行，再把文件内容和行数私聊告诉我。');
			await settle();
			say(chat, '把第二条待办删掉，改完再告诉我现在有几行。');
		},
	},

	group: {
		description: '群聊协作：主持人在群里按点名组织三轮成语接龙，最后总结',
		async run({ ai, say, runtime, human }) {
			const host = ai('老周', {}, '你是一个活跃气氛的主持人，说话简短。');
			const players = [
				ai('阿青', {}, '你说话温和，喜欢用典。'),
				ai('小满', {}, '你性格急躁，说话很快。'),
				ai('大熊', {}, '你憨厚老实，偶尔会想不出来。'),
			];
			const group = runtime.groups.create(human.memberId, '接龙群', [host, ...players].map(member => member.memberId));
			say({ kind: 'group', groupId: group.groupId },
				'老周，请你主持一个成语接龙：一共三轮，每轮点名一位成员（阿青、小满、大熊各一次）接一个成语，要接上一个成语的最后一个字（同音也算）。第一个成语由你出。三轮结束后在群里做个总结。',
				{ mentions: [host.memberId] });
		},
	},

	attachments: {
		description: '附件和看图：发图片和 PDF，成员看懂、读完后把整理结果作为附件发回',
		async run({ ai, say, directory }) {
			const member = ai('小林', {}, ASSISTANT_PROMPT);
			const imagePath = join(directory, 'shapes.png');
			writeFileSync(imagePath, await drawShapes());
			const pdfPath = join(directory, 'notes.pdf');
			writeFileSync(pdfPath, pdf(['Meeting notes', 'Launch date: March 14. Budget: 2400 dollars.']));
			say({ kind: 'direct', memberId: member.memberId },
				'附件里有一张图和一个 PDF。请告诉我图里有哪些图形、分别是什么颜色、写了什么字；再读 PDF，告诉我发布日期和预算。最后把这些整理成 summary.md，作为附件私聊发给我。',
				{ files: [imagePath, pdfPath] });
		},
	},

	long: {
		description: '长任务：后台任务、run_tool_script 批量调用、more_tools 查历史',
		async run({ ai, say, log, runtime }) {
			log(`shell：${runtime.shells.current().kind}`);
			const member = ai('小林', {}, ASSISTANT_PROMPT);
			say({ kind: 'direct', memberId: member.memberId }, [
				'请做三件事：',
				'1. 用 shell 执行 `sleep 40 && echo 构建完成`。它会转到后台，不用等它，先做后面的。',
				'2. 用 run_tool_script 写一段脚本，在脚本里调用三次 shell，分别取 node 版本、当前目录、当前时间，最后只输出一行汇总。',
				'3. 查一下你自己的聊天历史，找到我这条消息是什么时候发的。',
				'等第 1 步的后台任务结束后，私聊告诉我三件事的结果。',
			].join('\n'));
		},
	},

	compaction: {
		description: '上下文压缩：上下文长度调小，连续发几份长资料，最后问前面资料里的细节',
		models(config) {
			for (const provider of config['providers']) for (const model of provider['models']) model['contextWindow'] = 16_000;
		},
		async run({ ai, say, settle }) {
			const member = ai('小林', {}, ASSISTANT_PROMPT);
			const chat = { kind: 'direct', memberId: member.memberId } as const;
			const facts = [
				'项目代号是「青鸟」，负责人是周岚。',
				'项目代号是「白鹭」，负责人是何川，预算 38 万。',
				'服务器放在杭州机房，共 12 台。',
				'截止日期是 11 月 28 日，逾期每天罚款 2000 元。',
				'验收标准是首页加载不超过 1.5 秒。',
			];
			for (const [index, fact] of facts.entries()) {
				say(chat, `资料 ${index + 1}：${filler(index)}其中关键信息：${fact}${filler(index + 7)}\n\n先记住这份资料，只回复「收到 ${index + 1}」。`);
				await settle();
			}
			say(chat, '资料 2 里的项目代号和预算是什么？资料 4 里的截止日期是什么？');
		},
	},
};

/** 一段没有关键信息的填充文字，约 2500 字。 */
function filler(seed: number): string {
	const sentences = ['会议从上午九点开始，大家先回顾了上周的进展。', '讨论中提到了一些流程上的小问题，暂时没有定论。', '有人建议下次会议提前把材料发出来。',
		'中间休息了十分钟，大家喝了点茶。', '技术方案部分还需要再细化，下周继续讨论。', '最后确认了几项需要跟进的事项。'];
	let text = '';
	for (let index = 0; text.length < 2500; index++) text += sentences[(index + seed) % sentences.length];
	return text;
}

/** 画一张图：白底，左边蓝色三角形，右边红色圆形，下面写着「订单号 7351」。 */
async function drawShapes(): Promise<Buffer> {
	const { createCanvas } = await import('@napi-rs/canvas');
	const canvas = createCanvas(480, 320);
	const context = canvas.getContext('2d');
	context.fillStyle = '#ffffff';
	context.fillRect(0, 0, 480, 320);
	context.fillStyle = '#1e5bd8';
	context.beginPath();
	context.moveTo(60, 200);
	context.lineTo(140, 50);
	context.lineTo(220, 200);
	context.closePath();
	context.fill();
	context.fillStyle = '#d82a1e';
	context.beginPath();
	context.arc(340, 125, 75, 0, Math.PI * 2);
	context.fill();
	context.fillStyle = '#000000';
	context.font = '36px sans-serif';
	context.fillText('订单号 7351', 140, 280);
	return canvas.encode('png');
}

/** 每页一行文字的最简单的 PDF。 */
function pdf(pages: readonly string[]): Buffer {
	const objects = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${pages.map((_, index) => `${4 + index * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`,
		'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
	for (const [index, text] of pages.entries()) {
		const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`;
		objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`);
		objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
	}
	let body = '%PDF-1.4\n';
	const offsets = objects.map((object, index) => {
		const offset = body.length;
		body += `${index + 1} 0 obj\n${object}\nendobj\n`;
		return offset;
	});
	const xref = body.length;
	body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
	body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(body, 'latin1');
}
