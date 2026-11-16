#!/usr/bin/env python3
"""ProgramBench 单场：起任务容器 → 让 agent 从零重建程序 → 收代码库打成 submission.tar.gz。

    python eval/programbench/run.py --task sitkevij__hex.61ae69b --agent cc
    python eval/programbench/run.py --task sitkevij__hex.61ae69b --agent dsh --timeout 7200
    python eval/programbench/run.py --task sitkevij__hex.61ae69b --agent cc --dry-run   # 只打印 docker 命令

三个 agent 里 cc 和 dsh 都能在容器里直接当命令行工具跑；reman 是 HTTP 服务形态，要走
`eval/terminal-bench/reman_agent.py` 那套「起服务 + 建成员 + 发消息」的流程，这里先留桩。

出网怎么做（见 README 和 proxy.mjs）：
  1. `docker network create --internal pb-net`：这个网络没有默认网关，容器出不去；
  2. `pb-proxy` 容器同时接 pb-net 和默认 bridge，跑白名单代理，只放行 api.deepseek.com；
  3. 任务容器只接 pb-net，`HTTP(S)_PROXY` 指向 pb-proxy，所以除了模型 API 什么都连不上。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
import time
from collections import Counter
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
BUILD = HERE.parents[1] / "eval" / ".cache" / "build"
RUNS = HERE.parent / "evidence" / "programbench"

NET = "pb-net"
PROXY = "pb-proxy"
PROXY_PORT = 3128
NODE_IMAGE = "node:24"
# Claude Code 连的是 DeepSeek 的 Anthropic 兼容端点；这个域名也是白名单里唯一放行的。
ANTHROPIC_BASE_URL = "https://api.deepseek.com/anthropic"

# 统一口径（与 Terminal-Bench 加测那批一致）：压缩触发点都在 35 万 token 附近，输出上限 65,536。
#   reman 在窗口 0.7 处压缩            → 500,000 × 0.7 = 350,000
#   dsh   在「窗口 − maxTokens − 64k」处压缩 → 480,000 − 65,536 − 65,536 = 348,928
#   cc    用 AUTOCOMPACT_PCT_OVERRIDE  → 440,000 × 80% = 352,000
PARAMS = {
	"reman": {"window": 500_000, "output": 65_536},
	"dsh": {"window": 480_000, "output": 65_536},
	"cc": {"window": 440_000, "output": 65_536, "compact_pct": 80},
}

# 选题见 TASKS.md：官方榜单里 100% 解出、调用最少的三道，语言不重样。
TASKS = {
	"rs__jplot.2a54bcc": "programbench/rs_1776_jplot.2a54bcc:task_cleanroom_v6",
	"go-critic__go-critic.9aea378": "programbench/go-critic_1776_go-critic.9aea378:task_cleanroom_v6",
	"typst__typst.88356d0": "programbench/typst_1776_typst.88356d0:task_cleanroom_v6",
}

# 题面取自官方适配器的 programbench.yaml（mini-swe-agent），只保留会影响结果的部分：
# 不许查源码/不许包装原程序、要有 compile.sh、要提交、可以用原程序做实验。

# 日志要能长期留着，回显命令时把密钥换成占位符。
SECRET = re.compile(r"sk-[A-Za-z0-9]{16,}")


def printable(command: list[str]) -> str:
	"""回显用的命令行：密钥、令牌换成占位符。"""
	def mask(part: str) -> str:
		name, sep, _ = part.partition("=")
		if sep and name.endswith(("_API_KEY", "_TOKEN", "_SECRET")):
			return f"{name}=<redacted>"
		return SECRET.sub("sk-<redacted>", part)

	return " ".join(shlex.quote(mask(part)) for part in command)


def sh(command: list[str], *, dry: bool, check: bool = True, capture: bool = True) -> str:
	"""跑一条 docker 命令（dry 时只打印）。"""
	print("$ " + printable(command), flush=True)
	if dry:
		return ""
	done = subprocess.run(command, text=True, capture_output=capture)
	if check and done.returncode != 0:
		raise RuntimeError(f"命令失败（{done.returncode}）：{' '.join(command)}\n{done.stderr[-2000:]}")
	return (done.stdout or "") if capture else ""


def ensure_network(dry: bool) -> None:
	if dry:
		sh(["docker", "network", "create", "--internal", NET], dry=True, check=False)
		return
	listed = subprocess.run(["docker", "network", "ls", "--format", "{{.Name}}"], text=True, capture_output=True)
	if NET not in listed.stdout.split():
		sh(["docker", "network", "create", "--internal", NET], dry=dry)
		print(f"建好内网 {NET}（没有默认网关，容器出不去）", flush=True)


def ensure_proxy(dry: bool) -> None:
	"""白名单代理：接 pb-net（给任务容器用）和默认 bridge（自己出网）。

	已存在就复用，不能重建：三家并行时每个 run.py 都会走这里，
	重建会把别的 agent 正在跑的模型请求掐断（2026-11-14 就是这么让 reman 一场 36 秒就报 terminated 的）。
	"""
	running = ""
	if not dry:
		done = subprocess.run(["docker", "ps", "--filter", f"name=^{PROXY}$", "--format", "{{.Names}}"],
			text=True, capture_output=True)
		running = done.stdout.strip()
	if running != PROXY:
		sh(["docker", "rm", "-f", PROXY], dry=dry, check=False)
		sh([
			"docker", "run", "-d", "--name", PROXY, "--network", "bridge", "--restart", "unless-stopped",
			"-v", f"{HERE / 'proxy.mjs'}:/proxy.mjs:ro",
			"-e", f"PORT={PROXY_PORT}", "-e", "ALLOW=api.deepseek.com",
			NODE_IMAGE, "node", "/proxy.mjs",
		], dry=dry, check=False)
	else:
		print(f"代理已在跑，直接用：{PROXY}", flush=True)
	sh(["docker", "network", "connect", NET, PROXY], dry=dry, check=False)


def agent_env(agent: str, key: str) -> list[str]:
	"""按 agent 给出窗口 / 输出上限 / 压缩百分比，还有连模型要用的地址和 key。"""
	params = PARAMS[agent]
	# 密钥只放进本进程的环境：docker 用 -e NAME（不带值）从环境里取。
	# 写成 -e NAME=值 的话，命令行会连同日志、进程列表一起把明文带出去。
	if agent == "cc":
		# Claude Code 走 DeepSeek 的 Anthropic 兼容端点；容器里只有代理能出网，白名单里就是这家。
		os.environ["ANTHROPIC_API_KEY"] = key
		return [
			"-e", f"CLAUDE_CODE_MAX_CONTEXT_TOKENS={params['window']}",
			"-e", f"CLAUDE_CODE_MAX_OUTPUT_TOKENS={params['output']}",
			"-e", f"CLAUDE_AUTOCOMPACT_PCT_OVERRIDE={params['compact_pct']}",
			"-e", f"ANTHROPIC_BASE_URL={ANTHROPIC_BASE_URL}",
			"-e", "ANTHROPIC_API_KEY",
			"-e", "ANTHROPIC_MODEL=deepseek-flash",
		]
	if agent == "dsh":
		os.environ["DEEPSEEK_API_KEY"] = key
		return [
			"-e", f"DSH_EVAL_CONTEXT_WINDOW={params['window']}",
			"-e", f"DSH_EVAL_MAX_TOKENS={params['output']}",
			"-e", "DEEPSEEK_API_KEY",
		]
	if agent == "reman":
		return [
			"-e", f"REMAN_EVAL_CONTEXT_WINDOW={params['window']}",
			"-e", f"REMAN_EVAL_MAX_OUTPUT_TOKENS={params['output']}",
			# 运行时用的是 Node 的 fetch，它默认不看 HTTP(S)_PROXY；打开这个才会走容器里的白名单代理。
			"-e", "NODE_USE_ENV_PROXY=1",
		]
	return []


# 这些目录挂到宿主的运行目录上：数据直接落持久盘，容器删了也不丢（不靠 docker cp 兜底）。
PERSIST = {
	"reman": ("/opt/reman/data", "reman-data"),
	"dsh": ("/root/.dsh/sessions", "dsh-sessions"),
	"cc": ("/home/agent/.claude/projects", "cc-projects"),
}


def start_container(name: str, image: str, agent: str, key: str, run_dir: Path, dry: bool) -> None:
	sh(["docker", "rm", "-f", name], dry=dry, check=False)
	remote, local = PERSIST[agent]
	mounted = run_dir / local
	mounted.mkdir(parents=True, exist_ok=True)
	if agent != "reman":
		# dsh / cc 的目录归镜像里的用户，宿主目录要放开写权限，否则容器里的进程写不进来。
		os.chmod(mounted, 0o777)
	sh([
		"docker", "run", "-d", "--name", name, "--network", NET,
		"--cpus", "4", "--memory", "8g",
		"--entrypoint", "/bin/sh", "-w", "/workspace",
		"-v", f"{mounted}:{remote}",
		"-e", f"HTTP_PROXY=http://{PROXY}:{PROXY_PORT}",
		"-e", f"HTTPS_PROXY=http://{PROXY}:{PROXY_PORT}",
		"-e", f"http_proxy=http://{PROXY}:{PROXY_PORT}",
		"-e", f"https_proxy=http://{PROXY}:{PROXY_PORT}",
		"-e", "NO_PROXY=localhost,127.0.0.1",
		*agent_env(agent, key),
		image, "-c", "sleep infinity",
	], dry=dry)


def api_key() -> str:
	"""模型的 key：优先用环境变量，没有就从本机运行时的数据目录里解。"""
	key = os.environ.get("DEEPSEEK_API_KEY")
	if key:
		return key
	key_dir = Path(os.environ.get("LOCALAPPDATA", "")) / "Reman"
	done = subprocess.run(["node", "eval/decrypt-key.mjs", str(key_dir), "deepseek"],
		text=True, capture_output=True, cwd=ROOT)
	if done.returncode != 0 or not done.stdout.strip():
		raise SystemExit("要设 DEEPSEEK_API_KEY，或者能跑 node eval/decrypt-key.mjs 取到 key")
	return done.stdout.strip()


def exec_in(name: str, command: str, *, dry: bool, timeout: int | None = None,
		run_as: str | None = None, env: dict[str, str] | None = None) -> subprocess.CompletedProcess | None:
	as_user = ["-u", run_as] if run_as else []
	extra: list[str] = []
	for key, value in (env or {}).items():
		extra += ["-e", f"{key}={value}"]
	print(f"$ docker exec {name} {shlex.quote(command[:120])}", flush=True)
	if dry:
		return None
	return subprocess.run(["docker", "exec", *as_user, *extra, name, "sh", "-lc", command], text=True,
		capture_output=True, timeout=timeout)


def bootstrap_cc(name: str, prompt_file: Path, run_dir: Path, dry: bool, *, timeout: int) -> dict:
	"""Claude Code：传离线包（原生二进制），用 -p 一口气跑到完。"""
	bundle = BUILD / "claude-bundle.tar.gz"
	if not bundle.exists():
		raise RuntimeError(f"缺少 Claude Code 离线包：{bundle}（先跑 node eval/terminal-bench/claude-bundle.mjs）")
	sh(["docker", "cp", str(bundle), f"{name}:/tmp/claude-bundle.tar.gz"], dry=dry)
	sh(["docker", "cp", str(prompt_file), f"{name}:/tmp/prompt.txt"], dry=dry)
	# Claude Code 拒绝在 root 下跑 --dangerously-skip-permissions，所以以镜像里的 agent 用户跑：
	# 解包仍然用 root，然后交给 agent（连同 HOME、git 身份一起准备好）。
	install = (
		"mkdir -p /opt/claude && tar -xzf /tmp/claude-bundle.tar.gz -C /opt/claude && "
		# tar 里的文件权限可能是 644：a+rX 只给已经可执行的文件补 x，所以 bin 下面要显式 a+rx。
		"chmod -R a+rX /opt/claude && chmod -R a+rx /opt/claude/bin && "
		"ln -sf /opt/claude/bin/claude /usr/local/bin/claude && "
		"mkdir -p /home/agent && chown agent /home/agent && "
		"git config --system --add safe.directory /workspace 2>/dev/null || true; "
		"claude --version"
	)
	exec_in(name, install, dry=dry)
	# 任务要求提交改动，先给 agent 用户配好 git 身份。
	exec_in(
		name,
		"git config --global user.name 'Claude Code' && git config --global user.email 'cc@example.invalid'",
		dry=dry, run_as="agent", env={"HOME": "/home/agent"},
	)
	# -p 一次性跑完；权限全放开（容器是一次性的，题目本身要求它自由改文件）。
	# 必须显式给 --model：不给的话 cc 会按自己的默认模型去连 api.anthropic.com（白名单里没有，直接被拦）。
	run = (
		"cd /workspace && claude -p \"$(cat /tmp/prompt.txt)\" --model deepseek-flash "
		"--dangerously-skip-permissions --output-format stream-json --verbose"
	)
	# 限时 2 小时：容器里套一层 timeout，到点发 TERM，agent 退出后照常收尾。
	run = f"timeout -s TERM {timeout} sh -lc {shlex.quote(run)}"
	done = exec_in(name, run, dry=dry, timeout=None, run_as="agent", env={"HOME": "/home/agent"})
	if done is not None and done.returncode == 124:
		print(f"到 {timeout} 秒上限，已停掉 agent（outcome=timeout）", flush=True)
	log = "" if done is None else (done.stdout or "") + (done.stderr or "")
	(run_dir / "agent.log").write_text(log, encoding="utf-8")
	# cc 自己的会话记录：用量和「上下文什么时候断崖」都从这里算，留在运行目录里。
	exec_in(name, "cat /home/agent/.claude/projects/-workspace/*.jsonl > /tmp/cc-transcript.jsonl 2>/dev/null || true",
		dry=dry, run_as="root")
	if not dry:
		subprocess.run(["docker", "cp", f"{name}:/tmp/cc-transcript.jsonl", str(run_dir / "cc-transcript.jsonl")],
			capture_output=True)
	return parse_cc_usage(log)


def parse_cc_usage(log: str) -> dict:
	"""从 cc 的 stream-json 里取用量：最后一条 result / assistant 事件带的是累计值。"""
	usage = {"input": 0, "cacheRead": 0, "output": 0}
	for line in log.splitlines():
		line = line.strip()
		if not line.startswith("{"):
			continue
		try:
			event = json.loads(line)
		except json.JSONDecodeError:
			continue
		if not isinstance(event, dict):  # 有些行解析出来是字符串/数组，不是事件
			continue
		msg = event.get("message")
		found = event.get("usage") or (msg.get("usage") if isinstance(msg, dict) else None)
		if isinstance(found, dict) and event.get("type") in {"result", "assistant"}:
			usage = {
				"input": found.get("input_tokens", usage["input"]),
				"cacheRead": found.get("cache_read_input_tokens", usage["cacheRead"]),
				"output": found.get("output_tokens", usage["output"]),
			}
	return usage


def bootstrap_dsh(name: str, prompt_file: Path, run_dir: Path, *, dry: bool, context: int, max_tokens: int, reasoning: str, timeout: int) -> dict:
	"""DeepSeek Harness：传离线包（node + dsh），headless 模式吃 stdin，NDJSON 里带 usage。"""
	bundle = BUILD / "dsh-bundle.tar.gz"
	if not bundle.exists():
		raise RuntimeError(f"缺少 dsh 离线包：{bundle}（先跑 node eval/terminal-bench/dsh-bundle.mjs）")
	sh(["docker", "cp", str(bundle), f"{name}:/tmp/dsh-bundle.tar.gz"], dry=dry)
	sh(["docker", "cp", str(prompt_file), f"{name}:/tmp/prompt.txt"], dry=dry)
	# 注意：dsh 的 --patch 要求顶层是 YAML 数组（每条是一个 loader 覆盖项），少了 "- " 会直接报错。
	patch = (
		"- id: llm-deepseek\n"
		"  config:\n"
		f"    reasoningEffort: {reasoning}\n"
		"    models:\n"
		"      - id: deepseek-flash\n"
		"        name: DeepSeek-V4.1-Flash\n"
		f"        contextWindow: {context}\n"
		f"        maxTokens: {max_tokens}\n"
		"        inputModalities: [text, image]\n"
		"        systemPromptUpdate: in-history\n"
		"        toolUpdate: addition-only\n"
	)
	# dsh 以 root 跑，而 /workspace 属于镜像里的 agent：不放开 safe.directory 的话 git 会说 dubious ownership。
	install = (
		"set -e && git config --global --add safe.directory '*' && "
		"mkdir -p /opt/dsh && tar -xzf /tmp/dsh-bundle.tar.gz -C /opt/dsh && "
		f"printf '%s' {shlex.quote(patch)} > /opt/dsh/patch.yml && "
		"/opt/dsh/node/bin/node /opt/dsh/app/node_modules/@deepseek-ai/dsh/lib/bin.js --version"
	)
	exec_in(name, install, dry=dry)
	# patch 有没有生效、窗口和输出上限对不对：先 dump 一遍配置，不对就别开跑。
	if not dry:
		check = subprocess.run(
			["docker", "exec", name, "sh", "-lc",
			 "/opt/dsh/node/bin/node /opt/dsh/app/node_modules/@deepseek-ai/dsh/lib/bin.js "
			 "--profile headless --patch /opt/dsh/patch.yml --dump-config 2>&1 | grep -E "
			 f"'contextWindow|maxTokens|reasoningEffort' | head -20"],
			text=True, capture_output=True,
		)
		dumped = check.stdout or ""
		print("dsh 配置检查：\n" + dumped.strip(), flush=True)
		if str(context) not in dumped or str(max_tokens) not in dumped:
			raise RuntimeError(f"dsh 的 patch 没生效（窗口 {context} / 输出 {max_tokens} 没出现在配置里）：{dumped[:500]}")
	run = (
		"cd /workspace && DSH_HOME=/root/.dsh /opt/dsh/node/bin/node "
		"/opt/dsh/app/node_modules/@deepseek-ai/dsh/lib/bin.js "
		"--profile headless --patch /opt/dsh/patch.yml "
		"--permission-mode danger-full-access --json - < /tmp/prompt.txt"
	)
	run = f"timeout -s TERM {timeout} sh -lc {shlex.quote(run)}"
	done = exec_in(name, run, dry=dry, timeout=None)
	if done is not None and done.returncode == 124:
		print(f"到 {timeout} 秒上限，已停掉 agent（outcome=timeout）", flush=True)
	log = "" if done is None else (done.stdout or "") + (done.stderr or "")
	(run_dir / "agent.log").write_text(log, encoding="utf-8")
	return parse_dsh_usage(log)


def parse_dsh_usage(log: str) -> dict:
	"""dsh 的用量在 {"type":"status","phase":"step_end","usage":{...}} 里，按 turn:step 去重累加。"""
	totals: Counter = Counter()
	for line in log.splitlines():
		line = line.strip()
		if not line.startswith("{"):
			continue
		try:
			event = json.loads(line)
		except json.JSONDecodeError:
			continue
		if not isinstance(event, dict):  # 有些行解析出来不是对象，跳过
			continue
		if event.get("phase") == "step_end" and isinstance(event.get("usage"), dict):
			found = event["usage"]
			totals["input"] += found.get("inputTokens", 0)
			totals["cacheRead"] += found.get("cacheReadTokens", 0)
			totals["output"] += found.get("outputTokens", 0)
	return {"input": totals["input"], "cacheRead": totals["cacheRead"], "output": totals["output"]}


REMAN_NODE = "/opt/reman/node/bin/node"
REMAN_APP = "/opt/reman/app"
REMAN_DATA = "/opt/reman/data"
REMAN_PROBE = "/opt/reman/probe.mjs"
REMAN_LOG = "/opt/reman/runtime.log"
REMAN_PORT = "6100"
# 成员能用的工具：容器里没有浏览器、也没有第二个成员，这两样不装（其余一律打开）。
REMAN_TOOLS = [
	"shell", "files", "terminal", "view_image", "read_pdf",
	"search_history", "manage_reminders", "run_tool_script",
]
REMAN_WAIT_QUIET_MS = 2000
REMAN_WAIT_TIMEOUT_MS = 60_000
REMAN_READY_TIMEOUT_SEC = 90.0


def reman_probe(name: str, *args: object, timeout: float = 120) -> dict:
	"""在容器里跑 probe.mjs（和 Harbor 适配器用的是同一份），返回它打印的 JSON。"""
	done = subprocess.run(
		["docker", "exec", name, REMAN_NODE, REMAN_PROBE, *[str(arg) for arg in args]],
		text=True, capture_output=True, timeout=timeout,
	)
	lines = [line for line in (done.stdout or "").strip().splitlines() if line.startswith("{")]
	if not lines:
		raise RuntimeError(f"probe {args[0]} 没输出：{(done.stderr or done.stdout or '').strip()[-400:]}")
	return json.loads(lines[-1])


def bootstrap_reman(name: str, prompt_file: Path, run_dir: Path, *, dry: bool, context: int, max_tokens: int, reasoning: str, timeout: int) -> dict:
	"""reman 是 HTTP 服务：解包 → 起运行时 → 建成员 → 发题面 → 等它停下来 → 收用量。"""
	bundle = BUILD / "reman-bundle.tar.gz"
	if not bundle.exists():
		raise RuntimeError(f"缺少 reman 离线包：{bundle}（先跑 node eval/terminal-bench/bundle.mjs）")
	models = {
		"defaultModel": {"provider": "deepseek", "model": "deepseek-flash"},
		"providers": [{
			"id": "deepseek",
			"name": "DeepSeek",
			"baseUrl": "https://api.deepseek.com",
			"apiKey": api_key(),
			"models": [{
				"model": "deepseek-flash",
				"displayName": "deepseek-flash",
				# 这两个值决定压缩时机：运行时的触发点是窗口的 0.7，输出上限要让一份回复撑不满窗口。
				"contextWindow": context,
				"maxOutputTokens": max_tokens,
				"vision": True,
			}],
		}],
	}
	# models.json 是数据目录里的一个文件，只写进容器的数据目录；运行目录靠拷回来的 reman-data/ 留证，
	# 里面那份的 key 在 collect() 之后抹掉（见 scrub_secrets）。
	local_models = Path(tempfile.mkdtemp(prefix="pb-reman-")) / "models.json"
	local_models.write_text(json.dumps(models, ensure_ascii=False, indent="\t"), encoding="utf-8")

	# 先解包、再往 /opt/reman 下拷东西：目录不存在时 docker cp 会直接失败。
	sh(["docker", "cp", str(bundle), f"{name}:/tmp/reman-bundle.tar.gz"], dry=dry)
	if not dry:
		exec_in(name, (
			"set -e && mkdir -p /opt/reman " + REMAN_DATA + " && "
			"tar -xzf /tmp/reman-bundle.tar.gz -C /opt/reman && chmod +x " + REMAN_NODE + " && "
			"chmod -R a+rwX /opt/reman"
		), dry=False)
	sh(["docker", "cp", str(HERE.parent / "terminal-bench" / "container" / "probe.mjs"), f"{name}:{REMAN_PROBE}"], dry=dry)
	sh(["docker", "cp", str(prompt_file), f"{name}:/opt/reman/instruction.txt"], dry=dry)
	sh(["docker", "cp", str(local_models), f"{name}:{REMAN_DATA}/models.json"], dry=dry)
	if dry:
		print(f"$ docker exec {name} 'cd {REMAN_APP} && nohup {REMAN_NODE} src/main.ts --data-dir {REMAN_DATA} --port {REMAN_PORT} > {REMAN_LOG} 2>&1 &'")
		print("$ # 等 /v1/state → probe init → probe send → probe wait 循环（settled）→ probe usage → stop")
		return {}

	exec_in(name, f"set -e && touch {REMAN_LOG} && chmod a+rw {REMAN_LOG} && ls /opt/reman", dry=False)
	exec_in(name, (
		f"cd {REMAN_APP} && nohup {REMAN_NODE} --disable-warning=ExperimentalWarning "
		f"src/main.ts --data-dir {REMAN_DATA} --port {REMAN_PORT} > {REMAN_LOG} 2>&1 & echo started"
	), dry=False)

	started = time.monotonic()
	while time.monotonic() - started < REMAN_READY_TIMEOUT_SEC:
		try:
			if reman_probe(name, "state", timeout=30).get("ok"):
				print(f"运行时起来了（{time.monotonic() - started:.0f} 秒）", flush=True)
				break
		except (RuntimeError, subprocess.TimeoutExpired):
			pass
		time.sleep(1.0)
	else:
		tail = exec_in(name, f"tail -40 {REMAN_LOG} 2>/dev/null || true", dry=False)
		raise RuntimeError(f"运行时没能起来：{((tail.stdout or '') if tail else '').strip()[-800:]}")

	init = reman_probe(name, "init", "deepseek", "deepseek-flash", json.dumps(REMAN_TOOLS), "/workspace", reasoning)
	if not init.get("ok"):
		raise RuntimeError(f"建成员失败：{init.get('error')}")
	ai_id = init["aiId"]
	print(f"成员 {ai_id}，工作目录 /workspace", flush=True)

	sent = reman_probe(name, "send", ai_id, "/opt/reman/instruction.txt", timeout=60)
	if not sent.get("ok"):
		raise RuntimeError(f"发题面失败：{sent.get('error')}")

	started = time.monotonic()
	outcome = "done"
	while True:
		work = reman_probe(name, "wait", ai_id, REMAN_WAIT_QUIET_MS, REMAN_WAIT_TIMEOUT_MS,
			timeout=REMAN_WAIT_TIMEOUT_MS / 1000 + 30)
		if work.get("settled"):
			outcome = "done"
			break
		if time.monotonic() - started > timeout:
			outcome = "timeout"
			print(f"到 {timeout} 秒上限，停掉成员（outcome=timeout）", flush=True)
			break
		print(f"  {time.monotonic() - started:.0f} 秒：还在跑", flush=True)
	usage = reman_probe(name, "usage", timeout=60).get("usage", {})
	reman_probe(name, "stop", timeout=60)
	elapsed = time.monotonic() - started
	print(f"结束：{outcome}，用时 {elapsed:.0f} 秒", flush=True)
	(run_dir / "agent.log").write_text(
		json.dumps({"outcome": outcome, "seconds": round(elapsed, 1), "usage": usage}, ensure_ascii=False, indent="\t"),
		encoding="utf-8",
	)
	# 运行时的 inputTokens 是**含缓存命中**的整个提示词长度，要减掉 cachedTokens 才是未命中的部分。
	total_input = usage.get("inputTokens", 0)
	cached = usage.get("cachedTokens", 0)
	return {
		"input": max(0, total_input - cached),
		"cacheRead": cached,
		"output": usage.get("outputTokens", 0),
	}


# 每场必须带出来的证据：容器删掉就没有第二次机会。
ARTIFACTS = [
	("/opt/reman/data", "reman-data"),		# 运行时的数据库、时间线、成员定义：压缩次数和每步上下文都从这里数
	("/opt/reman/runtime.log", "runtime.log"),
	("/root/.dsh/sessions", "dsh-sessions"),	# dsh 的会话记录（jsonl.zstd）
	("/home/agent/.claude/projects", "cc-projects"),	# cc 的会话记录
]


def collect(name: str, run_dir: Path, task: str, dry: bool, agent: str = '') -> Path | None:
	"""把 /workspace 打成 submission.tar.gz（不带参考程序和 .git）。

	programbench 的判分要求 <运行目录>/<实例 id>/submission.tar.gz 这种结构，所以按实例 id 放。
	"""
	archive = run_dir / task / "submission.tar.gz"
	archive.parent.mkdir(parents=True, exist_ok=True)
	pack = (
		"cd /workspace && tar -czf /tmp/submission.tar.gz "
		"--exclude=./executable --exclude=./.git --exclude=./submission.tar.gz . && "
		"ls -l /tmp/submission.tar.gz"
	)
	exec_in(name, pack, dry=dry)
	if dry:
		return None
	sh(["docker", "cp", f"{name}:/tmp/submission.tar.gz", str(archive)], dry=dry)
	# 证据要落盘：容器删掉，里面的对话记录就永远没了（踩过一次）。
	# reman 的对话全在运行时的数据库里；cc / dsh 的 stdout 已经由 bootstrap 写进 agent.log。
	if not dry:
		mounted_remote = PERSIST[agent][0] if agent in PERSIST else None
		for remote, local in ARTIFACTS:
			if remote == mounted_remote:
				print(f"{local} 挂在宿主上，不用再拷", flush=True)
				continue
			try:
				sh(["docker", "cp", f"{name}:{remote}", str(run_dir / local)], dry=False)
			except (RuntimeError, subprocess.CalledProcessError):
				print(f"（没拷到 {remote}，跳过）", flush=True)
		scrub_secrets(run_dir)
	return archive


def scrub_secrets(run_dir: Path) -> None:
	"""运行目录里不能留 API key：reman 的数据目录里有一份 models.json（明文的）。"""
	models = run_dir / "reman-data" / "models.json"
	if not models.exists():
		return
	try:
		data = json.loads(models.read_text(encoding="utf-8"))
	except (OSError, json.JSONDecodeError):
		return
	for provider in data.get("providers", []):
		if isinstance(provider, dict) and provider.get("apiKey"):
			provider["apiKey"] = "（已抹掉）"
	models.write_text(json.dumps(data, ensure_ascii=False, indent="\t"), encoding="utf-8")
	print("已抹掉 reman-data/models.json 里的 API key", flush=True)


def finish_run(raw_dir: str) -> int:
	"""补收尾：agent 已经跑完、包装器却半路崩了（或终端掉了）时，用现成的证据补齐收尾。

	只做 bootstrap 之后那几步——按 agent.log 重算用量、抽 submission.tar.gz、写 run.json、停容器。
	agent 的过程不做任何改动，所以这不是重跑，是把已经产生的证据收全。
	"""
	run_dir = Path(raw_dir).resolve()
	if not run_dir.is_dir():
		raise SystemExit(f"没有这个运行目录：{run_dir}")
	name_dir = run_dir.name
	agent = next((a for a in ("reman", "cc", "dsh") if f"-{a}-" in name_dir), None)
	if agent in (None, "reman"):
		raise SystemExit(f"只支持 cc / dsh 的补收尾（reman 的用量在运行时数据库里，要另算）：{name_dir}")
	task = name_dir.split(f"-{agent}-", 1)[1]
	if task not in TASKS:
		raise SystemExit(f"题目不在 TASKS 表里：{task}")
	container = f"pb-{agent}-{task.split('.')[0]}".replace("__", "-")
	log_file = run_dir / "agent.log"
	if not log_file.exists():
		raise SystemExit(f"缺 agent.log，没法补：{log_file}")
	log = log_file.read_text(encoding="utf-8", errors="ignore")
	usage = parse_cc_usage(log) if agent == "cc" else parse_dsh_usage(log)

	prompt_file = run_dir / "prompt.txt"
	started = prompt_file.stat().st_mtime if prompt_file.exists() else log_file.stat().st_mtime
	elapsed = round(log_file.stat().st_mtime - started)
	archive = collect(container, run_dir, task, False, agent)
	meta = {
		"task": task, "agent": agent, "image": TASKS[task], "container": container,
		"started": datetime.fromtimestamp(started).isoformat(timespec="seconds"),
		"elapsed_seconds": elapsed, "timeout": PARAMS.get("_timeout", 7200),
		"context": PARAMS[agent]["window"], "max_output": PARAMS[agent]["output"], "reasoning": "high",
		"usage": usage, "submission": str(archive) if archive else None,
		"dry_run": False, "finished_late": True,
	}
	(run_dir / "run.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
	print(f"补收尾完成：用时 {elapsed} 秒（按 prompt.txt → agent.log 的落盘时间估的），用量 {usage}", flush=True)
	sh(["docker", "stop", container], dry=False, check=False)
	return 0


def main() -> int:
	parser = argparse.ArgumentParser(description="ProgramBench 单场运行")
	parser.add_argument("--task", choices=sorted(TASKS), help="实例名（见 TASKS.md）")
	parser.add_argument("--agent", choices=["cc", "dsh", "reman"])
	parser.add_argument("--timeout", type=int, default=7200, help="agent 最长运行秒数（默认 2 小时）")
	parser.add_argument("--context", type=int, default=None, help="覆盖窗口（默认按 agent 各自的窗口）")
	parser.add_argument("--reasoning", default="high", help="dsh 的思考强度")
	parser.add_argument("--rm-container", action="store_true", help="跑完直接删容器（默认只停不删）")
	parser.add_argument("--prune", action="store_true", help="清理已停止的 pb-* 容器，然后退出")
	parser.add_argument("--dry-run", action="store_true", help="只打印 docker 命令，不动容器")
	parser.add_argument("--finish", help="给一个已跑完但没收尾的运行目录，补写 run.json、抽 submission、停容器")
	args = parser.parse_args()
	if args.finish:
		return finish_run(args.finish)
	if args.prune:
		listed = subprocess.run(["docker", "ps", "-a", "--filter", "name=pb-", "--format", "{{.Names}} {{.Status}}"],
			text=True, capture_output=True).stdout.strip().splitlines()
		stopped = [line.split()[0] for line in listed if "Up " not in line and "pb-proxy" not in line]
		for container in stopped:
			sh(["docker", "rm", "-f", container], dry=False, check=False)
		print(f"清理了 {len(stopped)} 个已停止的容器：{'、'.join(stopped) or '无'}")
		print("（pb-proxy 一直留着，它是白名单代理）")
		return 0
	if not args.task or not args.agent:
		parser.error("要么给 --task 和 --agent，要么用 --prune")

	stamp = datetime.now().strftime("%m%d-%H%M")
	run_dir = RUNS / f"{stamp}-{args.agent}-{args.task}"
	run_dir.mkdir(parents=True, exist_ok=True)
	official = HERE / "prompts" / f"{args.task}.md"
	if not official.exists():
		raise SystemExit(f"缺官方题面：{official}（必须逐字用官方 instruction.md，不许自己写）")
	prompt_file = run_dir / "prompt.txt"
	prompt_file.write_bytes(official.read_bytes())

	image = TASKS[args.task]
	name = f"pb-{args.agent}-{args.task.split('.')[0]}".replace("__", "-")
	dry = args.dry_run
	print(f"题目 {args.task}\n镜像 {image}\nagent {args.agent}\n产物 {run_dir}", flush=True)

	started = time.time()
	ensure_network(dry)
	ensure_proxy(dry)
	key = api_key()
	# 本地已经有这个镜像就不联网拉了：题目镜像一旦拉好就不会变，registry 有时还连不上。
	if subprocess.run(["docker", "image", "inspect", image], capture_output=True).returncode != 0:
		sh(["docker", "pull", image], dry=dry)
	else:
		print(f"镜像已在本地：{image}", flush=True)
	start_container(name, image, args.agent, key, run_dir, dry)
	exec_in(name, "ls -la /workspace | head -30", dry=dry)

	params = PARAMS[args.agent]
	if args.context:
		params = {**params, "window": args.context}
	if args.agent == "cc":
		usage = bootstrap_cc(name, prompt_file, run_dir, dry, timeout=args.timeout)
	elif args.agent == "dsh":
		usage = bootstrap_dsh(name, prompt_file, run_dir, dry=dry,
			context=PARAMS["dsh"]["window"], max_tokens=PARAMS["dsh"]["output"], reasoning=args.reasoning,
			timeout=args.timeout)
	else:
		usage = bootstrap_reman(name, prompt_file, run_dir, dry=dry,
			context=PARAMS["reman"]["window"], max_tokens=PARAMS["reman"]["output"], reasoning=args.reasoning,
			timeout=args.timeout)

	archive = collect(name, run_dir, args.task, dry, args.agent)
	elapsed = round(time.time() - started)
	meta = {
		"task": args.task, "agent": args.agent, "image": image, "container": name,
		"started": datetime.fromtimestamp(started).isoformat(timespec="seconds"),
		"elapsed_seconds": elapsed, "timeout": args.timeout,
		"context": params["window"], "max_output": params["output"], "reasoning": args.reasoning,
		"usage": usage, "submission": str(archive) if archive else None,
		"dry_run": dry,
	}
	(run_dir / "run.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
	# 证据不全就别当成一场有效数据：过程、产物、判分原始结果三样缺一不可。
	if not dry:
		missing = [name for name in ("agent.log", "prompt.txt", "run.json") if not (run_dir / name).exists()]
		if archive is None or not archive.exists():
			missing.append("submission.tar.gz")
		if args.agent == "reman" and not (run_dir / "reman-data").exists():
			missing.append("reman-data/")
		if missing:
			print(f"⚠️ 证据不全，缺 {missing}：这场不能当有效数据", flush=True)
		else:
			print("证据齐：agent.log、prompt.txt、submission.tar.gz、run.json" + ("、reman-data/" if args.agent == "reman" else ""), flush=True)
	print(f"用时 {elapsed} 秒，用量 {usage}", flush=True)
	# 默认只停不删：判分要能重跑、证据要能对账，容器留着（磁盘占用比丢数据便宜）。
	# 确认没问题后用 --prune 或 docker rm -f 清理。
	if not dry:
		if args.rm_container:
			print(f"容器已删除：{name}", flush=True)
			sh(["docker", "rm", "-f", name], dry=dry, check=False)
		else:
			print(f"容器只停止不删除：{name}（清理：python eval/programbench/run.py --prune）", flush=True)
			sh(["docker", "stop", name], dry=dry, check=False)
	return 0


if __name__ == "__main__":
	sys.exit(main())
