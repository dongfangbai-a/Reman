import { mkdirSync } from 'node:fs';
import type { Members } from './members.ts';

/** 成员的工作目录：成员设置里指定的目录，没指定时用运行时给它分配的目录。 */
export class Workspaces {
	private readonly members: Members;

	constructor(members: Members) {
		this.members = members;
	}

	/** 返回工作目录。默认目录第一次用到时创建；用户指定的目录不自动创建，不存在时由用到它的工具报错。 */
	directory(memberId: string): string {
		const member = this.members.require(memberId);
		if (member.workingDirectory) return member.workingDirectory;
		const directory = member.defaultWorkingDirectory!;
		mkdirSync(directory, { recursive: true });
		return directory;
	}
}
