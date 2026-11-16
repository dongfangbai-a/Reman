import { commandName, isShellCommandOption, POSIX_SHELLS, type ISimpleCommand, type IWord } from './commandParser.ts';

/**
 * 按清单判断一个简单命令（见设计文档「命令的自动判断」）：
 * - approve：要审批，带一个短原因；
 * - read、write：读、写哪个文件，交给路径检查；copyFrom 是 cp 的来源，要在工作目录里，按读检查。
 * 没有要审批的就是放行。
 */
type Effect =
	| { readonly kind: 'approve'; readonly reason: string }
	| { readonly kind: 'read' | 'write' | 'copyFrom'; readonly word: IWord };

export function commandEffects(command: ISimpleCommand): Effect[] {
	const name = commandName(command.name);
	if (name === undefined) return [approve(command.name.dynamic ? `无法解析的命令：${command.name.text}` : `不在免审批范围内：${command.name.text}`)];
	const rule = RULES.get(name);
	if (rule) return rule(command.args, name);
	if (VERSION_PROGRAMS.has(name) && command.args.length === 1 && VERSION_ARGS.has(command.args[0]!.text) && !command.args[0]!.dynamic) return [];
	return [approve(`不在免审批范围内：${name}`)];
}

type Rule = (args: readonly IWord[], name: string) => Effect[];

function approve(reason: string): Effect {
	return { kind: 'approve', reason };
}

function access(kind: 'read' | 'write' | 'copyFrom', word: IWord): Effect {
	return { kind, word };
}

/** 选项的写法：flags 不带值，values 带一个值（可以紧跟或者是下一个词），optional 的值只能紧跟（-w32、--color=auto）。 */
interface ISpec {
	readonly flags: ReadonlySet<string>;
	readonly values: ReadonlySet<string>;
	readonly optional: ReadonlySet<string>;
	/** 允许 -20 这种数字选项。 */
	readonly numeric: boolean;
}

function spec(flags: string, values = '', optional = '', numeric = false): ISpec {
	const set = (text: string) => new Set(text.split(/\s+/).filter(Boolean));
	return { flags: set(flags), values: set(values), optional: set(optional), numeric };
}

interface IOption {
	readonly name: string;
	readonly value: IWord | undefined;
}

interface IParsedArgs {
	readonly options: readonly IOption[];
	readonly operands: readonly IWord[];
	/** 不认识的选项。 */
	readonly unknown: readonly string[];
	/** 看不清、可能展开成选项的词（也算在操作数里）。 */
	readonly unclear: readonly IWord[];
}

/** 按选项的写法拆参数：-rf 拆开看，--opt=value 拆成名字和值，-- 之后都是操作数。选项可以出现在操作数后面。 */
function parseArgs(args: readonly IWord[], { flags, values, optional, numeric }: ISpec): IParsedArgs {
	const options: IOption[] = [];
	const operands: IWord[] = [];
	const unknown: string[] = [];
	const unclear: IWord[] = [];
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]!;
		const text = arg.text;
		if (text === '--' && !arg.dynamic) {
			operands.push(...args.slice(index + 1));
			break;
		}
		if (arg.dynamic && /^-{0,2}$/.test(arg.prefix)) {
			unclear.push(arg);
			operands.push(arg);
		} else if (text.startsWith('--')) {
			const equals = text.indexOf('=');
			const name = equals < 0 ? text : text.slice(0, equals);
			if (equals >= 0 && (values.has(name) || optional.has(name))) options.push({ name, value: slice(arg, equals + 1) });
			else if (equals < 0 && (flags.has(name) || optional.has(name))) options.push({ name, value: undefined });
			else if (equals < 0 && values.has(name)) options.push({ name, value: args[++index] });
			else unknown.push(name);
		} else if (text.startsWith('-') && text.length > 1) {
			if (numeric && /^-\d+$/.test(text)) {
				options.push({ name: '-#', value: undefined });
				continue;
			}
			for (let position = 1; position < text.length; position++) {
				const name = `-${text[position]}`;
				const rest = text.slice(position + 1);
				if (flags.has(name)) {
					options.push({ name, value: undefined });
					continue;
				}
				if (values.has(name)) options.push({ name, value: rest ? slice(arg, position + 1) : args[++index] });
				else if (optional.has(name)) options.push({ name, value: rest ? slice(arg, position + 1) : undefined });
				else unknown.push(name);
				break;
			}
		} else {
			operands.push(arg);
		}
	}
	return { options, operands, unknown, unclear };
}

/** 词从 start 开始的部分。 */
function slice(word: IWord, start: number): IWord {
	const text = word.text.slice(start);
	return { ...word, text, prefix: word.dynamic ? word.prefix.slice(start) : text };
}

/**
 * 选项的问题：不认识的选项要审批；strict 时看不清、可能展开成选项的词也要审批（这个命令有读写文件、执行程序的选项）。
 * 已经按文件检查的词不再算，检查文件时会说明看不清。
 */
function optionProblems(name: string, parsed: IParsedArgs, strict = true, checked: readonly Effect[] = []): Effect[] {
	const words = new Set(checked.map(effect => effect.kind === 'approve' ? undefined : effect.word));
	return [
		...parsed.unknown.map(option => approve(`不在免审批范围内：${name} ${option}`)),
		...strict ? parsed.unclear.filter(word => !words.has(word)).map(word => approve(`无法解析的参数：${word.text}`)) : [],
	];
}

function has(parsed: IParsedArgs, ...names: string[]): boolean {
	return parsed.options.some(option => names.includes(option.name));
}

/** 值是文件的选项按读检查（grep -f、diff -X 这类）。 */
function optionReads(parsed: IParsedArgs, names: readonly string[]): Effect[] {
	return parsed.options.filter(option => names.includes(option.name) && option.value).map(option => access('read', option.value!));
}

/** 不是标准输入（-）的操作数。 */
function files(operands: readonly IWord[]): IWord[] {
	return operands.filter(word => word.dynamic || word.text !== '-');
}

/** 参数随便写都不会读写文件、执行程序的命令。 */
const anyArgs: Rule = () => [];

/** 只看文件和目录的信息、不读内容的命令：操作数不检查，读文件的选项按读检查。 */
function metadata(options: ISpec, reads: readonly string[] = []): Rule {
	return (args, name) => {
		const parsed = parseArgs(args, options);
		return [...optionProblems(name, parsed, reads.length > 0), ...optionReads(parsed, reads)];
	};
}

/** 读文件内容的命令：操作数都是要读的文件。 */
function reader(options: ISpec, reads: readonly string[] = []): Rule {
	return (args, name) => {
		const parsed = parseArgs(args, options);
		const checked = [...optionReads(parsed, reads), ...files(parsed.operands).map(word => access('read', word))];
		return [...optionProblems(name, parsed, reads.length > 0, checked), ...checked];
	};
}

/** grep、rg：第一个操作数是要找的内容（给了 -e、-f 时没有），其余是要读的文件；没有文件、又是递归找时读当前目录。 */
function searcher(options: ISpec, patternOptions: readonly string[], reads: readonly string[], recursive: (parsed: IParsedArgs) => boolean): Rule {
	return (args, name) => {
		const parsed = parseArgs(args, options);
		const paths = files(parsed.operands.slice(has(parsed, ...patternOptions) ? 0 : 1));
		const current: IWord = { text: '.', dynamic: false, prefix: '.', glob: false };
		const checked = [...optionReads(parsed, reads), ...(paths.length ? paths : recursive(parsed) ? [current] : []).map(word => access('read', word))];
		return [...optionProblems(name, parsed, true, checked), ...checked];
	};
}

/** 写文件的命令：操作数都是要写的文件。 */
function writer(options: ISpec): Rule {
	return (args, name) => {
		const parsed = parseArgs(args, options);
		const checked = parsed.operands.map(word => access('write', word));
		return [...optionProblems(name, parsed, true, checked), ...checked];
	};
}

/** cp、mv：最后一个操作数是目标（给了 -t 时 -t 的值是目标），其余是来源。cp 的来源按读检查，mv 的来源也算写（原来的位置没了）。 */
function transfer(options: ISpec, sourceKind: 'copyFrom' | 'write'): Rule {
	return (args, name) => {
		const parsed = parseArgs(args, options);
		const target = parsed.options.find(option => option.name === '-t' || option.name === '--target-directory')?.value;
		const sources = target ? parsed.operands : parsed.operands.slice(0, -1);
		const destination = target ?? parsed.operands.at(-1);
		const checked = [...sources.map(word => access(sourceKind, word)), ...destination ? [access('write', destination)] : []];
		return [...optionProblems(name, parsed, true, checked), ...checked];
	};
}

const LS = spec(
	'-a -A -b -B -c -C -d -f -F -g -G -h -H -i -k -l -L -m -n -N -o -p -q -Q -r -R -s -S -t -u -U -v -x -X -Z -1 --all --almost-all --author --escape '
	+ '--ignore-backups --directory --dired --classify --file-type --full-time --group-directories-first --no-group --human-readable --si --dereference '
	+ '--dereference-command-line --dereference-command-line-symlink-to-dir --inode --kibibytes --literal --numeric-uid-gid --hide-control-chars '
	+ '--show-control-chars --quote-name --reverse --recursive --size --context --zero --help --version',
	'-I -T -w --block-size --format --hide --ignore --indicator-style --quoting-style --sort --time --time-style --tabsize --width',
	'--color --colour --hyperlink',
);

const GREP = spec(
	'-E -F -G -P -i -y -v -w -x -c -L -l -o -q -s -b -H -h -n -T -u -Z -z -a -I -r -R -U --extended-regexp --fixed-strings --basic-regexp '
	+ '--perl-regexp --ignore-case --no-ignore-case --invert-match --word-regexp --line-regexp --count --files-without-match --files-with-matches '
	+ '--only-matching --quiet --silent --no-messages --byte-offset --with-filename --no-filename --line-number --initial-tab --null --null-data '
	+ '--text --recursive --dereference-recursive --line-buffered --binary',
	'-e -f -m -A -B -C -d -D --regexp --file --max-count --after-context --before-context --context --directories --devices --include --exclude '
	+ '--exclude-dir --exclude-from --label --binary-files --group-separator',
	'--color --colour',
	true,
);

const RG = spec(
	'-a -b -c -F -h -H -i -I -l -L -n -N -o -p -q -s -S -u -U -v -w -x -0 --text --byte-offset --count --count-matches --fixed-strings --no-fixed-strings '
	+ '--with-filename --no-filename --ignore-case --files --files-with-matches --files-without-match --follow --no-follow --line-number --no-line-number '
	+ '--only-matching --pretty --quiet --case-sensitive --smart-case --unrestricted --multiline --no-multiline --multiline-dotall --invert-match '
	+ '--word-regexp --line-regexp --null --null-data --hidden --no-hidden --no-ignore --no-ignore-vcs --no-ignore-dot --no-ignore-global '
	+ '--no-ignore-parent --no-ignore-exclude --no-ignore-files --no-ignore-messages --ignore --no-messages --heading --no-heading --column --no-column '
	+ '--json --no-json --vimgrep --stats --no-stats --trim --no-trim --type-list --sort-files --passthru --include-zero --crlf --no-crlf --no-unicode '
	+ '--one-file-system --no-config --line-buffered --block-buffered --debug --trace --no-require-git --glob-case-insensitive --binary --no-binary '
	+ '--pcre2 --no-pcre2 --auto-hybrid-regex --max-columns-preview --unicode --encoding-auto --help --version',
	'-e -f -g -t -T -m -A -B -C -M -j -E -r -d --regexp --file --glob --iglob --type --type-not --max-count --after-context --before-context --context '
	+ '--max-columns --threads --encoding --replace --max-depth --sort --sortr --max-filesize --type-add --type-clear --colors --color '
	+ '--field-match-separator --field-context-separator --path-separator --context-separator --ignore-file --engine --dfa-size-limit '
	+ '--regex-size-limit --hyperlink-format',
	'',
	true,
);

const SORT = spec(
	'-b -d -f -g -i -M -h -n -R -r -V -c -C -m -s -u -z --ignore-leading-blanks --dictionary-order --ignore-case --general-numeric-sort '
	+ '--ignore-nonprinting --month-sort --human-numeric-sort --numeric-sort --random-sort --reverse --version-sort --merge --stable --unique '
	+ '--zero-terminated --debug',
	'-k -t -S -o -T --key --field-separator --buffer-size --output --temporary-directory --parallel --random-source --files0-from --sort --batch-size',
	'--check',
);

const CP = spec(
	'-a -r -R -f -i -n -p -P -L -H -u -v -x -T -b --archive --recursive --force --interactive --no-clobber --no-dereference --dereference --parents '
	+ '--verbose --one-file-system --no-target-directory --strip-trailing-slashes --remove-destination --attributes-only --debug',
	'-t -S --target-directory --suffix --no-preserve',
	'--preserve --backup --update --reflink --sparse',
);

const MV = spec(
	'-f -i -n -u -v -T -b --force --interactive --no-clobber --verbose --no-target-directory --strip-trailing-slashes --debug --no-copy --exchange',
	'-t -S --target-directory --suffix',
	'--backup --update',
);

const RULES: ReadonlyMap<string, Rule> = new Map<string, Rule>([
	// 只输出文字，或者只看文件信息、不读内容。
	...['echo', 'printf', 'pwd', 'which', 'basename', 'dirname', 'sleep', 'true', 'test', 'ps', 'cd', 'pushd', 'popd'].map(name => [name, anyArgs] as const),
	['ls', metadata(LS)],
	['file', metadata(spec(
		'-b -c -d -E -h -i -k -l -L -N -n -p -r -s -S -z -Z -0 --brief --checking-printout --debug --dereference --no-dereference --mime --mime-type '
		+ '--mime-encoding --keep-going --list --no-buffer --no-pad --preserve-date --raw --special-files --no-sandbox --uncompress --uncompress-noreport '
		+ '--print0 --extension --apple --help --version',
		'-e -f -F -m -P --exclude --files-from --separator --magic-file --parameter',
	), ['-f', '--files-from'])],
	['stat', metadata(spec('-L -f -t --dereference --file-system --terse --cached --help --version', '-c --format --printf'))],
	['du', metadata(spec(
		'-0 -a -b -c -D -h -H -k -l -L -m -P -s -S -x --null --all --apparent-size --bytes --total --dereference-args --human-readable --si --inodes '
		+ '--dereference --count-links --no-dereference --summarize --separate-dirs --one-file-system --help --version',
		'-B -d -t -X --block-size --max-depth --threshold --exclude --exclude-from --time-style --files0-from',
		'--time',
	), ['-X', '--exclude-from', '--files0-from'])],
	['df', metadata(spec(
		'-a -h -H -i -k -l -P -T --all --human-readable --si --inodes --local --portability --print-type --total --no-sync --sync --help --version',
		'-B -t -x --block-size --type --exclude-type',
		'--output',
	))],
	['realpath', metadata(spec(
		'-e -m -L -P -q -s -z --canonicalize-existing --canonicalize-missing --logical --physical --quiet --strip --no-symlinks --zero --help --version',
		'--relative-to --relative-base',
	))],
	['readlink', metadata(spec('-f -e -m -n -q -s -v -z --canonicalize --canonicalize-existing --canonicalize-missing --no-newline --quiet --silent --verbose --zero --help --version'))],
	['tree', (args, name) => {
		const parsed = parseArgs(args, spec(
			'-a -d -l -f -x -q -N -Q -p -u -g -s -h -D -F -v -t -c -U -r -i -A -S -n -C -J -X --noreport --dirsfirst --filesfirst --prune --du --si '
			+ '--inodes --device --matchdirs --ignore-case --gitignore --info --metafirst --help --version',
			'-L -P -I -H -T -o --filelimit --timefmt --sort --charset',
		));
		return [...optionProblems(name, parsed), ...parsed.options.filter(option => option.name === '-o' && option.value).map(option => access('write', option.value!))];
	}],

	// 读文件内容。
	['cat', reader(spec('-A -b -e -E -n -s -t -T -u -v --show-all --number-nonblank --number --squeeze-blank --show-ends --show-tabs --show-nonprinting --help --version'))],
	['head', reader(spec('-q -v -z --quiet --silent --verbose --zero-terminated --help --version', '-c -n --bytes --lines', '', true))],
	['tail', reader(spec(
		'-f -F -q -v -z -r --retry --quiet --silent --verbose --zero-terminated --help --version',
		'-c -n -s --bytes --lines --pid --sleep-interval --max-unchanged-stats', '--follow', true,
	))],
	['wc', reader(spec('-c -m -l -L -w --bytes --chars --lines --max-line-length --words --help --version', '--files0-from --total'), ['--files0-from'])],
	['cut', reader(spec(
		'-n -s -z --complement --only-delimited --zero-terminated --help --version',
		'-b -c -d -f --bytes --characters --delimiter --fields --output-delimiter',
	))],
	['tr', (args, name) => optionProblems(name, parseArgs(args, spec('-c -C -d -s -t --complement --delete --squeeze-repeats --truncate-set1 --help --version')))],
	['nl', reader(spec(
		'-p --no-renumber --help --version',
		'-b -d -f -h -i -l -n -s -v -w --body-numbering --section-delimiter --footer-numbering --header-numbering --line-increment --join-blank-lines '
		+ '--number-format --number-separator --starting-line-number --number-width',
	))],
	['od', reader(spec(
		'-a -b -c -d -f -i -l -o -s -x -v --output-duplicates --traditional --help --version',
		'-A -j -N -S -t --address-radix --skip-bytes --read-bytes --format --endian', '-w --strings --width',
	))],
	['cmp', reader(spec('-b -l -s --print-bytes --verbose --quiet --silent --help --version', '-i -n --ignore-initial --bytes'))],
	['diff', reader(spec(
		'-q -s -c -u -e -n -y -l -t -T -r -N -a -b -B -E -i -w -Z -d -p --brief --report-identical-files --normal --ed --rcs --side-by-side '
		+ '--left-column --suppress-common-lines --show-c-function --expand-tabs --initial-tab --suppress-blank-empty --recursive --new-file '
		+ '--unidirectional-new-file --ignore-case --no-ignore-file-name-case --ignore-file-name-case --ignore-tab-expansion --ignore-trailing-space '
		+ '--ignore-space-change --ignore-all-space --ignore-blank-lines --text --strip-trailing-cr --minimal --speed-large-files --no-dereference '
		+ '--help --version',
		'-C -U -W -F -I -x -X -S -D --width --show-function-line --ignore-matching-lines --exclude --exclude-from --starting-file --label --from-file '
		+ '--to-file --line-format --old-line-format --new-line-format --unchanged-line-format --old-group-format --new-group-format '
		+ '--changed-group-format --unchanged-group-format --tabsize --horizon-lines --ifdef --palette',
		'--color --context --unified',
	), ['-X', '--exclude-from', '--from-file', '--to-file'])],
	['grep', searcher(GREP, ['-e', '-f', '--regexp', '--file'], ['-f', '--file', '--exclude-from'], parsed => has(parsed, '-r', '-R', '--recursive', '--dereference-recursive'))],
	['rg', (args, name) => {
		const parsed = parseArgs(args, RG);
		const listing = has(parsed, '--files', '--type-list');
		return searcher(RG, listing ? ['--files', '--type-list'] : ['-e', '-f', '--regexp', '--file'], ['-f', '--file', '--ignore-file'], () => !has(parsed, '--type-list'))(args, name);
	}],
	['sort', (args, name) => {
		const parsed = parseArgs(args, SORT);
		const writes = parsed.options.filter(option => ['-o', '--output', '-T', '--temporary-directory'].includes(option.name) && option.value);
		const checked = [
			...optionReads(parsed, ['--random-source', '--files0-from']), ...writes.map(option => access('write', option.value!)),
			...files(parsed.operands).map(word => access('read', word)),
		];
		return [...optionProblems(name, parsed, true, checked), ...checked];
	}],
	['uniq', (args, name) => {
		const parsed = parseArgs(args, spec(
			'-c -d -D -i -u -z --count --repeated --ignore-case --unique --zero-terminated --help --version',
			'-f -s -w --skip-fields --skip-chars --check-chars', '--all-repeated --group',
		));
		const [input, output] = parsed.operands;
		const checked = [
			...input && (input.dynamic || input.text !== '-') ? [access('read', input)] : [],
			...output && (output.dynamic || output.text !== '-') ? [access('write', output)] : [],
		];
		return [...optionProblems(name, parsed, true, checked), ...checked];
	}],
	['sed', sed],
	...[...POSIX_SHELLS].map(name => [name, shell] as const),
	['jq', jq],
	['find', find],
	['git', git],
	['npm', npm],

	// 写文件。
	['mkdir', writer(spec('-p -v --parents --verbose --help --version', '-m --mode'))],
	['touch', writer(spec('-a -c -m -h -f --no-create --no-dereference --help --version', '-d -r -t --date --reference --time'))],
	['tee', writer(spec('-a -i -p --append --ignore-interrupts --help --version', '', '--output-error'))],
	['cp', transfer(CP, 'copyFrom')],
	['mv', transfer(MV, 'write')],

	// 套壳没有取出里面的命令时：env 只是列出环境变量，xargs 默认执行 echo，command -v 只是查命令在哪。
	['env', (args, name) => optionProblems(name, parseArgs(args, spec('-i -0 -v --ignore-environment --null --debug --help --version')))],
	['xargs', args => args.length ? [approve('不在免审批范围内：xargs')] : []],
	// 执行的内容看不出来。
	...['eval', 'source', '.', 'alias'].map(name => [name, () => [approve(`无法解析的写法：${name}`)]] as const),
	['command', args => args.some(arg => /^-[pvV]+$/.test(arg.text) && /[vV]/.test(arg.text)) && !args.some(arg => arg.dynamic) ? [] : [approve('不在免审批范围内：command')]],
]);

/** bash -c '...'：里面的命令单独检查，这里不用审批；执行脚本文件的要审批。 */
function shell(args: readonly IWord[], name: string): Effect[] {
	if (args.length === 1 && VERSION_ARGS.has(args[0]!.text) && !args[0]!.dynamic) return [];
	const index = args.findIndex(arg => !arg.dynamic && isShellCommandOption(arg.text));
	const options = args.slice(0, Math.max(index, 0));
	if (index >= 0 && args[index + 1] && options.every(arg => !arg.dynamic && /^[-+]/.test(arg.text))) return [];
	return [approve(`不在免审批范围内：${name}`)];
}

/** 只查版本号时放行的程序。 */
const VERSION_PROGRAMS: ReadonlySet<string> = new Set([
	'node', 'npx', 'python', 'python3', 'py', 'pip', 'pip3', 'java', 'javac', 'go', 'gcc', 'g++', 'clang', 'cmake', 'make', 'docker', 'dotnet', 'ruby',
	'gem', 'perl', 'php', 'deno', 'bun', 'code', 'curl', 'tsc',
]);
const VERSION_ARGS: ReadonlySet<string> = new Set(['--version', '-v', '-V', '-version', 'version']);

/** sed：只放行看得懂的简单脚本；-i 时文件也算写；-f 从文件读脚本，看不清。 */
function sed(args: readonly IWord[], name: string): Effect[] {
	const parsed = parseArgs(args, spec(
		'-n -E -r -s -u -z --quiet --silent --regexp-extended --separate --unbuffered --null-data --posix --debug --sandbox --follow-symlinks --help --version',
		'-e -l --expression --line-length', '-i --in-place',
	));
	const expressions = parsed.options.filter(option => option.name === '-e' || option.name === '--expression').map(option => option.value);
	const scripts = expressions.length ? expressions : parsed.operands.slice(0, 1);
	const paths = files(parsed.operands.slice(expressions.length ? 0 : 1));
	const inPlace = has(parsed, '-i', '--in-place');
	const checked = [...paths.map(word => access('read', word)), ...inPlace ? paths.map(word => access('write', word)) : []];
	const problems = optionProblems(name, parsed, true, [...checked, ...scripts.filter(word => word !== undefined).map(word => access('read', word))]);
	if (!scripts.length) problems.push(approve('不在免审批范围内：sed'));
	for (const script of scripts) {
		if (!script || script.dynamic) problems.push(approve(`无法解析的参数：${script?.text ?? ''}`));
		else if (!isSimpleSedScript(script.text)) problems.push(approve('不在免审批范围内：sed 脚本'));
	}
	return [...problems, ...checked];
}

/**
 * 看得懂的简单 sed 脚本：地址加 p、d、q、=、s///（不带 e、w 标志）、y///、a/i/c 文字、跳转和不碰文件的命令。
 * 有 e、w、r 这类执行程序、读写文件的命令，或者看不懂的写法，都不算。
 */
export function isSimpleSedScript(script: string): boolean {
	let index = 0;
	const at = () => script[index] ?? '';
	const skip = (pattern: RegExp) => {
		while (index < script.length && pattern.test(at())) index++;
	};
	const digits = () => {
		const start = index;
		skip(/\d/);
		return index > start;
	};
	/** 读到没转义的分隔符为止。正则里 [...] 中的分隔符不算结束（GNU sed 就是这样）。 */
	const delimited = (delimiter: string, regex: boolean): boolean => {
		while (index < script.length) {
			const char = at();
			if (char === '\\') {
				index += 2;
			} else if (char === '\n') {
				return false;
			} else if (char === delimiter) {
				index++;
				return true;
			} else if (regex && char === '[') {
				index++;
				if (at() === '^') index++;
				if (at() === ']') index++;
				while (index < script.length && at() !== ']') {
					if (at() === '\n') return false;
					const open = at() === '[' ? script[index + 1] : undefined;
					if (open === ':' || open === '.' || open === '=') {
						const close = script.indexOf(`${open}]`, index + 2);
						if (close < 0) return false;
						index = close + 2;
					} else {
						index++;
					}
				}
				if (at() !== ']') return false;
				index++;
			} else {
				index++;
			}
		}
		return false;
	};
	/** 地址：数字、first~step、$、/正则/。没有地址时什么都不读，返回 true。 */
	const address = (): boolean => {
		if (digits()) return at() !== '~' || (index++, digits());
		if (at() === '$') {
			index++;
			return true;
		}
		if (at() === '/' || at() === '\\') {
			let delimiter = '/';
			if (at() === '\\') {
				index++;
				delimiter = at();
				if (!delimiter || delimiter === '\n' || delimiter === '\\') return false;
			}
			index++;
			if (!delimited(delimiter, true)) return false;
			skip(/[IM]/);
		}
		return true;
	};
	while (index < script.length) {
		skip(/[\s;]/);
		if (index >= script.length) break;
		const start = index;
		if (!address()) return false;
		if (index > start && at() === ',') {
			index++;
			if (at() === '+' || at() === '~') {
				index++;
				if (!digits()) return false;
			} else {
				const second = index;
				if (!address() || index === second) return false;
			}
		}
		skip(/[ \t]/);
		if (at() === '!') {
			index++;
			skip(/[ \t]/);
		}
		const command = at();
		index++;
		if (command === '{') {
			// 块的开头，后面直接跟命令。
			continue;
		} else if ('pPdDnNgGhHx=zF}'.includes(command) && command) {
			// 不带参数。
		} else if (command === 'l' || command === 'q' || command === 'Q') {
			skip(/[ \t]/);
			digits();
		} else if (command === ':' || command === 'b' || command === 't' || command === 'T') {
			skip(/[ \t]/);
			skip(/[^;\n}]/);
		} else if (command === 's' || command === 'y') {
			const delimiter = at();
			if (!delimiter || delimiter === '\n' || delimiter === '\\') return false;
			index++;
			if (!delimited(delimiter, command === 's') || !delimited(delimiter, false)) return false;
			if (command === 's') skip(/[gpiImM0-9]/);
		} else if (command === 'a' || command === 'i' || command === 'c') {
			// 文字一直到行尾，反斜杠加换行接着下一行。
			while (index < script.length && at() !== '\n') index += at() === '\\' ? 2 : 1;
		} else {
			return false;
		}
		skip(/[ \t]/);
		if (index < script.length && !/[;\n}]/.test(at())) return false;
	}
	return true;
}

/** jq：第一个操作数是过滤器（给了 -f 时是文件），其余是要读的文件；--args 之后的是参数，不是文件。 */
function jq(args: readonly IWord[], name: string): Effect[] {
	const flags = new Set('-r -j -a -c -n -e -s -S -C -M -R -h --tab --raw-output --join-output --ascii-output --compact-output --null-input --exit-status --slurp --sort-keys --color-output --monochrome-output --raw-input --stream --stream-errors --seq --raw-output0 --unbuffered --help --version'.split(' '));
	const problems: Effect[] = [];
	const reads: IWord[] = [];
	const operands: IWord[] = [];
	let fromFile = false;
	let argsMode = false;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]!;
		const text = arg.text;
		if (argsMode) continue;
		if (arg.dynamic && /^-{0,2}$/.test(arg.prefix)) {
			problems.push(approve(`无法解析的参数：${text}`));
		} else if (arg.dynamic || !text.startsWith('-') || text === '-') {
			operands.push(arg);
		} else if (text === '--args' || text === '--jsonargs') {
			argsMode = true;
		} else if (text === '--arg' || text === '--argjson') {
			index += 2;
		} else if (text === '--slurpfile' || text === '--rawfile') {
			if (args[index + 2]) reads.push(args[index + 2]!);
			index += 2;
		} else if (text === '-f' || text === '--from-file') {
			fromFile = true;
		} else if (text === '--indent' || text === '-L' || text === '--library-path') {
			index++;
		} else if (/^-L./.test(text)) {
			// -L 目录紧跟着写。
		} else if (!flags.has(text) && !(/^-[a-zA-Z]+$/.test(text) && [...text.slice(1)].every(char => flags.has(`-${char}`)))) {
			problems.push(approve(`不在免审批范围内：${name} ${text}`));
		}
	}
	return [...problems, ...[...reads, ...files(operands.slice(fromFile ? 0 : 1))].map(word => access('read', word))];
}

const FIND_FLAGS: ReadonlySet<string> = new Set([
	'(', ')', '!', ',', '-not', '-a', '-and', '-o', '-or', '-print', '-print0', '-ls', '-prune', '-quit', '-depth', '-d', '-follow', '-xdev', '-mount',
	'-noleaf', '-daystart', '-ignore_readdir_race', '-noignore_readdir_race', '-empty', '-executable', '-readable', '-writable', '-nouser', '-nogroup',
	'-true', '-false', '-warn', '-nowarn',
]);
const FIND_VALUES: ReadonlySet<string> = new Set([
	'-name', '-iname', '-path', '-ipath', '-wholename', '-iwholename', '-regex', '-iregex', '-lname', '-ilname', '-type', '-xtype', '-maxdepth',
	'-mindepth', '-mtime', '-mmin', '-atime', '-amin', '-ctime', '-cmin', '-newer', '-anewer', '-cnewer', '-size', '-perm', '-user', '-group', '-uid',
	'-gid', '-links', '-inum', '-samefile', '-used', '-fstype', '-printf', '-regextype', '-context',
]);

/** find：只列出文件名、不读内容；有执行程序、删除、写文件的写法（-exec、-delete、-fprint 这类）要审批。 */
function find(args: readonly IWord[], name: string): Effect[] {
	let index = 0;
	while (index < args.length && /^-[HLP]$|^-O\d$/.test(args[index]!.text) && !args[index]!.dynamic) index++;
	for (; index < args.length; index++) {
		const arg = args[index]!;
		const text = arg.text;
		if (arg.dynamic) return [approve(`无法解析的参数：${text}`)];
		if (FIND_FLAGS.has(text) || !text.startsWith('-')) continue;
		if (FIND_VALUES.has(text) || /^-newer[aBcmt][aBcmt]$/.test(text)) {
			const value = args[++index];
			if (value?.dynamic) return [approve(`无法解析的参数：${value.text}`)];
			continue;
		}
		return [approve(`不在免审批范围内：${name} ${text}`)];
	}
	return [];
}

/** git：只放行查看类子命令；全局参数只认 -C 和 --no-pager。 */
function git(args: readonly IWord[]): Effect[] {
	let index = 0;
	let directory = false;
	for (; index < args.length; index++) {
		const arg = args[index]!;
		if (arg.dynamic) return [approve(`无法解析的参数：${arg.text}`)];
		if (arg.text === '-C') {
			directory = true;
			if (args[++index]?.dynamic) return [approve(`无法解析的参数：${args[index]!.text}`)];
		} else if (arg.text === '--no-pager' || arg.text === '-P') {
			continue;
		} else if (arg.text.startsWith('-')) {
			if ((arg.text === '--version' || arg.text === '-v') && index === args.length - 1) return [];
			return [approve(`不在免审批范围内：git ${optionName(arg.text)}`)];
		} else {
			break;
		}
	}
	const subcommand = args[index]?.text;
	const rest = args.slice(index + 1);
	const unclear = rest.filter(word => word.dynamic && /^-{0,2}$/.test(word.prefix)).map(word => approve(`无法解析的参数：${word.text}`));
	const denied = (patterns: readonly string[]) => rest.filter(word => !word.dynamic && isOption(word.text, patterns)).map(word => approve(`不在免审批范围内：git ${subcommand} ${optionName(word.text)}`));
	switch (subcommand) {
		case 'status':
		case 'ls-files':
		case 'rev-parse':
		case 'describe':
		case 'version':
			return unclear;
		case 'log':
		case 'show':
		case 'diff': {
			const problems = [...unclear, ...denied(['--output', '--ext-diff'])];
			// --no-index 比较的是任意两个文件。
			if (subcommand !== 'diff' || !rest.some(word => word.text === '--no-index')) return problems;
			if (directory) return [...problems, approve('不在免审批范围内：git -C … diff --no-index')];
			const paths = rest.filter(word => word.dynamic || !word.text.startsWith('-'));
			return [...problems, ...paths.map(word => access('read', word))];
		}
		case 'grep': {
			const pager = rest.filter(word => !word.dynamic && (/^-[^-]*O/.test(word.text) || isOption(word.text, ['--open-files-in-pager'])));
			const patternFiles = rest.flatMap((word, position) => word.text === '-f' && rest[position + 1] ? [access('read', rest[position + 1]!)] : []);
			return [...unclear, ...pager.map(() => approve('不在免审批范围内：git grep -O')), ...patternFiles];
		}
		case 'blame': {
			const reads = rest.flatMap((word, position) => (word.text === '--contents' || word.text === '-S') && rest[position + 1] ? [access('read', rest[position + 1]!)] : []);
			return [...unclear, ...reads];
		}
		case 'branch':
		case 'tag':
			return gitListing(subcommand, rest);
		case 'remote': {
			const parsed = parseArgs(rest, spec('-v --verbose --push --all'));
			const [action] = parsed.operands;
			const listing = !action || (action.text === 'get-url' && !action.dynamic);
			return listing ? optionProblems('git remote', parsed) : [approve(`不在免审批范围内：git remote ${action.text}`)];
		}
		case 'config': {
			const parsed = parseArgs(rest, spec(
				'-l -z --get --get-all --get-regexp --get-urlmatch --list --show-origin --show-scope --global --system --local --worktree --name-only --null '
				+ '--bool --int --bool-or-int --path --expiry-date --includes --no-includes --all',
				'--type --default --regexp',
			));
			const reading = has(parsed, '--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list', '-l')
				|| ['get', 'list'].includes(parsed.operands[0]?.text ?? '') || (parsed.operands.length === 1 && !parsed.operands[0]!.dynamic);
			return reading ? optionProblems('git config', parsed) : [approve('不在免审批范围内：git config')];
		}
		default:
			return [approve(subcommand ? `不在免审批范围内：git ${subcommand}` : '不在免审批范围内：git')];
	}
}

/** git branch、git tag：只列出时放行，带名字（新建、删除、改名）的要审批。 */
function gitListing(subcommand: string, rest: readonly IWord[]): Effect[] {
	const parsed = parseArgs(rest, subcommand === 'branch'
		? spec(
			'-a -r -l -v -i --all --remotes --list --verbose --ignore-case --show-current --column --no-column --color --no-color --omit-empty',
			'--contains --no-contains --merged --no-merged --points-at --sort --format', '--abbrev',
		)
		: spec('-l -i --list --ignore-case --column --no-column --color --omit-empty', '--contains --no-contains --merged --no-merged --points-at --sort --format', '-n'));
	const problems = optionProblems(`git ${subcommand}`, parsed);
	if (problems.length) return problems;
	const listing = !parsed.operands.length || has(parsed, '-l', '--list');
	return listing ? [] : [approve(`不在免审批范围内：git ${subcommand} ${parsed.operands[0]!.text}`)];
}

/** --output=x 的名字部分；git 认缩写，--out 也是 --output。 */
function isOption(text: string, names: readonly string[]): boolean {
	const name = optionName(text);
	return name.startsWith('--') && name.length > 2 && names.some(item => item.startsWith(name));
}

function optionName(text: string): string {
	return text.includes('=') ? text.slice(0, text.indexOf('=')) : text;
}

const NPM_VIEW: ReadonlySet<string> = new Set(['ls', 'list', 'll', 'la', 'outdated', 'view', 'info', 'show', 'v', 'why', 'explain', 'root', 'prefix', 'query']);

/** npm：只放行查看类子命令。会执行代码的（安装、运行脚本）都要审批。 */
function npm(args: readonly IWord[]): Effect[] {
	const [first, second] = args;
	if (!first || first.dynamic) return [approve(first ? `无法解析的参数：${first.text}` : '不在免审批范围内：npm')];
	if (args.length === 1 && (first.text === '--version' || first.text === '-v')) return [];
	const viewing = NPM_VIEW.has(first.text) || first.text === 'audit'
		|| (first.text === 'config' && ['get', 'list', 'ls'].includes(second?.text ?? '')) || (first.text === 'pkg' && second?.text === 'get');
	if (!viewing) return [approve(`不在免审批范围内：npm ${first.text}`)];
	const parsed = parseArgs(args.slice(1), spec(
		'-a -g -l -p --json --long --all --global --parseable --package-lock-only --workspaces --ws --include-workspace-root --link --unicode --no-unicode '
		+ '--production --prod --dev --omit-lockfile-registry-resolved --no-description',
		'-w --depth --workspace --omit --include --audit-level --location',
	));
	if (first.text === 'audit' && parsed.operands.length) return [approve(`不在免审批范围内：npm audit ${parsed.operands[0]!.text}`)];
	return optionProblems(`npm ${first.text}`, parsed);
}
