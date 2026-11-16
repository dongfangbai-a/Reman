/** 「自己」的名字：视角成员、时间线主人的名字用强调色加粗，一眼分出是自己。 */
export function SelfName({ name }: { name: string }) {
	return <span className="font-semibold text-accent">{name}</span>;
}
