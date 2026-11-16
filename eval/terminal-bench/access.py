"""任务容器里的写权限：所有适配器共用，别每换一个 agent 再踩一遍。

踩过的坑（同一个问题反复出现过几次）：
- 任务工作目录 `/app` 只有 root 可写 → 运行时的 `write_file` 报
  `EACCES: permission denied, open '/app/probe.py'`，整场 15 秒 failed（risk-scorer-replay）。
- 有的镜像写 `USER nobody`、Harbor 的 `default_user` 又是空的 → 解包到 `/opt/reman`、`/opt/dsh`
  之后 agent 写不进去。
- 题面、日志、DSH_HOME 写在 root 的目录里，agent 用户同样写不进去。

做法统一成两条：
1. setup 时（root）把要写的地方一律 `chmod -R a+rwX`：任务工作目录、我们自己的安装目录、/tmp；
2. 装完用**实际跑 agent 的那个用户**做一次写测试（touch 一个探针文件），失败就当场报错，
   不要等到 agent 跑起来才在某个工具调用里炸。
"""

# 需要放开的地方：任务工作目录（不同题不一样）、我们自己解包的目录、放临时文件的 /tmp。
WRITABLE_DIRS = ("/app", "/workspace", "/repo", "/opt/reman", "/opt/dsh", "/tmp")

# 探针文件放在工作目录里：写不进去就说明整场跑不起来。
PROBE_NAME = ".write-test"

# 任务工作目录的候选：不同题不一样，取第一个存在的。
DEFAULT_WORKDIRS = ("/app", "/workspace", "/repo")


def relax_command(dirs: tuple[str, ...] = WRITABLE_DIRS) -> str:
	"""root 执行：把列出的目录全部放开写权限（不存在就跳过）。"""
	listed = " ".join('"%s"' % item for item in dirs)
	return (
		'for dir in %s; do [ -d "$dir" ] && chmod -R a+rwX "$dir" 2>/dev/null; done\n' % listed
	)


def probe_command(workdirs="default") -> str:
	"""以 agent 用户执行：在候选工作目录里建一个探针文件再删掉。

	取第一个存在的目录试写；写不进去返回非零，让 setup 当场失败而不是跑到一半才炸。
	"""
	candidates = DEFAULT_WORKDIRS if workdirs == "default" else (
		(workdirs,) if isinstance(workdirs, str) else tuple(workdirs)
	)
	listed = " ".join('"%s"' % item.rstrip("/") for item in candidates)
	probe = PROBE_NAME
	script = 'for dir in %s; do ' % listed
	script += 'if [ -d "$dir" ]; then '
	script += 'if touch "$dir/%s" 2>/dev/null && rm -f "$dir/%s"; then ' % (probe, probe)
	script += 'echo "可写：$dir"; exit 0; '
	script += 'else echo "不可写：$dir"; exit 4; fi; '
	script += 'fi; done; echo "找不到工作目录"; exit 3'
	return script
