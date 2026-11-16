import { invalid } from '../../common/errors.ts';
import type { Members } from '../../members/members.ts';
import type { Skills } from '../../skills/skills.ts';
import type { ITool } from '../tools.ts';

/** 工具说明里每个技能的说明最多列多少字。 */
const LISTED_DESCRIPTION_CHARS = 160;

/** 技能列表和变动说明里写的技能说明。 */
export function listedDescription(description: string): string {
	return description.replace(/\s+/g, ' ').slice(0, LISTED_DESCRIPTION_CHARS) || '（无说明）';
}

/**
 * 读成员配置的技能，总是提供；能读哪些技能由成员文件的 skills 决定。工具说明列出配置的技能，没有时写「暂无」。
 * 工具列表是快照（见 runs/snapshots.ts），技能的配置变了不改说明，在时间线里追加变动说明。
 */
export function createReadSkillTool(members: Members, skills: Skills): ITool {
	const listing = (memberId: string) => {
		const names = members.get(memberId)?.skills ?? [];
		const all = skills.snapshot().skills;
		return names.flatMap(name => all.filter(skill => skill.name === name)).map(skill => `- ${skill.name}：${listedDescription(skill.description)}`);
	};
	return {
		name: 'read_skill',
		label: '读取技能',
		description: '读取为你配置的技能（skill）的完整内容。技能是完成某类事务的详细方法，需要时先读取再执行。',
		parameters: {
			type: 'object',
			properties: { name: { type: 'string', description: '技能名，使用工具说明中列出的名称' } },
			required: ['name'],
			additionalProperties: false,
		},
		describe(memberId) {
			const lines = listing(memberId);
			return [
				'读取为你配置的技能（skill）的完整内容。技能是完成某类事务的详细方法：要做的事与下方某个技能的说明相符时，先读取该技能，再按其执行。',
				'',
				...lines.length > 0 ? ['为你配置的技能：', ...lines] : ['为你配置的技能：暂无'],
			].join('\n');
		},
		execute(context, args) {
			const name = args['name'];
			if (typeof name !== 'string' || !name.trim()) throw invalid('name 不能为空');
			const member = members.require(context.memberId);
			if (!member.skills.includes(name.trim())) {
				throw invalid(`未为你配置技能 ${name}${member.skills.length > 0 ? `；为你配置的技能：${member.skills.join('、')}` : ''}`);
			}
			const skill = skills.get(name.trim());
			if (!skill) {
				const issue = skills.snapshot().issues.find(item => item.name === name.trim());
				throw invalid(issue ? `技能 ${name} 读取失败：${issue.message}。请告知用户检查技能文件夹` : `技能 ${name} 不存在，可能已被删除`);
			}
			return `技能目录：${skill.directory}\n\n${skill.content}`;
		},
	};
}
