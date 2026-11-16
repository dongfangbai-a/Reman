// 检查「写了不生效」的类：npm run check:classes（在 web 目录下）。
// Tailwind 同一属性的工具类按类名排序，和写的先后无关，组件默认类里的 size-2.5 会盖掉外面传的 size-2。
// 找出「有默认类、又把外面传的类并进去」的地方，用 Tailwind 实际生成的 CSS 判断外面传的类有没有被默认类盖掉。
// 覆盖两种：组件（函数体里 clsx(..., className)）；共用的类常量（clsx(INPUT_CLASS, '...')、`${INPUT_CLASS} ...`）。
// 另外报出用了 ! 的（默认样式放在 components 层后用不着）、和默认一样多余的。默认样式放在 components 层的组件，外面传的总能生效，不会报。
// 只是文本匹配，不解析 TS：写法特别的（类名放在变量里再传）查不到。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from '@tailwindcss/node';

const web = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const files = fs.readdirSync(path.join(web, 'src'), { recursive: true }).filter(f => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f)).map(f => path.join(web, 'src', f));
const sources = Object.fromEntries(files.map(f => [f, fs.readFileSync(f, 'utf8')]));
const constants = {};
for (const s of Object.values(sources)) for (const m of s.matchAll(/(?:export )?const ([A-Z][A-Z_]+) = '([^']*)'/g)) constants[m[1]] = m[2];

function matching(s, i, open, close) {
	let depth = 0;
	for (; i < s.length; i++) {
		if (s[i] === open) depth++;
		else if (s[i] === close && --depth === 0) return i;
	}
	return -1;
}
const literals = text => [...text.matchAll(/'([^']*)'|"([^"]*)"|`([^`$]*)`/g)].flatMap(m => (m[1] ?? m[2] ?? m[3]).split(/\s+/)).filter(Boolean);
const lineOf = (s, index) => s.slice(0, index).split('\n').length;
const rel = file => path.relative(path.join(web, 'src'), file);

const components = {};
for (const [file, s] of Object.entries(sources)) {
	for (const m of s.matchAll(/(?:export )?function ([A-Z]\w*)\s*\(/g)) {
		const bodyStart = s.indexOf('{', matching(s, m.index + m[0].length - 1, '(', ')'));
		const body = s.slice(bodyStart, matching(s, bodyStart, '{', '}'));
		for (const c of body.matchAll(/clsx\(/g)) {
			const end = matching(body, c.index + 4, '(', ')');
			const args = body.slice(c.index + 5, end);
			if (!/(^|[\s,(])className\s*(,|$)/.test(args)) continue;
			const defaults = [...literals(args), ...[...args.matchAll(/\b([A-Z][A-Z_]+)\b/g)].flatMap(x => (constants[x[1]] ?? '').split(/\s+/).filter(Boolean))];
			components[m[1]] = { file: rel(file), defaults: [...new Set([...(components[m[1]]?.defaults ?? []), ...defaults])] };
		}
	}
}

const calls = [];
for (const [file, s] of Object.entries(sources)) {
	for (const m of s.matchAll(/<([A-Z]\w*)\b/g)) {
		if (!components[m[1]]) continue;
		let i = m.index + m[0].length;
		let depth = 0;
		for (; i < s.length; i++) {
			const ch = s[i];
			if (ch === '{') depth++;
			else if (ch === '}') depth--;
			else if (ch === '>' && depth === 0 && s[i - 1] !== '=') break;
		}
		const attrs = s.slice(m.index, i);
		const cm = /\bclassName=(?:"([^"]*)"|\{)/.exec(attrs);
		if (!cm) continue;
		const classes = cm[1] !== undefined
			? cm[1].split(/\s+/).filter(Boolean)
			: literals(attrs.slice(cm.index + cm[0].length, matching(attrs, cm.index + cm[0].length - 1, '{', '}')));
		calls.push({ at: `${rel(file)}:${lineOf(s, m.index)}`, component: m[1], classes });
	}
	for (const m of s.matchAll(/className=\{(clsx\(|`)/g)) {
		const isClsx = m[1] === 'clsx(';
		const start = m.index + m[0].length;
		const expr = s.slice(start, isClsx ? matching(s, start - 1, '(', ')') : s.indexOf('`', start));
		const name = /\b([A-Z][A-Z_]+_CLASS)\b/.exec(expr)?.[1];
		if (!name || !constants[name]) continue;
		const rest = isClsx ? literals(expr.replace(name, '')) : expr.replace('${' + name + '}', '').split(/\s+/).filter(c => c && !c.includes('$'));
		components[name] ??= { file: '(常量)', defaults: constants[name].split(/\s+/) };
		calls.push({ at: `${rel(file)}:${lineOf(s, m.index)}`, component: name, classes: rest });
	}
}

const compiler = await compile(fs.readFileSync(path.join(web, 'src/index.css'), 'utf8'), { base: path.join(web, 'src'), onDependency() {} });
const all = [...new Set([...Object.values(components).flatMap(c => c.defaults), ...calls.flatMap(c => c.classes)].map(c => c.replace(/!$/, '')))];
const css = compiler.build(all);
const from = css.indexOf('@layer utilities');
const componentsAt = css.indexOf('@layer components', from);
const utilities = css.slice(from, componentsAt > from ? componentsAt : undefined);
const info = {};
for (const cls of all) {
	const sel = '.' + cls.replace(/[^a-zA-Z0-9_-]/g, ch => String.fromCharCode(92) + ch);
	const at = [' {', ':', ' '].map(after => utilities.indexOf(sel + after)).find(index => index >= 0);
	if (at === undefined) continue;
	const open = utilities.indexOf('{', at);
	const block = utilities.slice(open, matching(utilities, open, '{', '}'));
	info[cls] = { at, props: [...new Set([...block.matchAll(/([a-z-]+)\s*:[^;{]*;/g)].map(x => x[1]).filter(p => !p.startsWith('--')))] };
}

const variantOf = c => (c.includes(':') ? c.slice(0, c.lastIndexOf(':')) : '');
const report = [];
for (const call of calls) {
	const comp = components[call.component];
	for (const raw of call.classes) {
		if (raw.endsWith('!')) {
			report.push(`${call.at} ${call.component}: ${raw} 用了 !`);
			continue;
		}
		const own = info[raw];
		if (!own) continue;
		for (const def of comp.defaults) {
			if (def === raw) {
				report.push(`${call.at} ${call.component}: ${raw} 和默认的一样，多余`);
				continue;
			}
			const base = info[def];
			if (!base || variantOf(def) !== variantOf(raw)) continue;
			const shared = own.props.filter(p => base.props.includes(p));
			if (shared.length && own.at < base.at) report.push(`${call.at} ${call.component}: ${raw} 被默认的 ${def} 盖掉（${shared.join(',')}）`);
		}
	}
}
const problems = [...new Set(report)];
console.log(`查了 ${Object.keys(components).length} 个组件和类常量、${calls.length} 处传了类的地方。`);
if (problems.length) {
	console.log(problems.join('\n'));
	process.exitCode = 1;
} else {
	console.log('没有发现问题。');
}
