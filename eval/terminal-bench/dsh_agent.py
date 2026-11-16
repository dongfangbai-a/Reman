"""把 DeepSeek Harness（官方 `dsh`）装进任务容器里跑。

Harbor 调用的顺序是 setup() 一次（装环境）、run() 一次（给任务、等它干完）。

和别的 agent 对齐的几件事：
  - 上下文窗口、思考强度都显式设，不依赖 dsh 自己的默认值（它默认 1M 窗口、high）；
  - 审批不打断：`--permission-mode danger-full-access`（沙箱全开 + 不再询问），和 reman（工具全 allow）、
    Claude Code（关掉交互确认）是同一个意思；
  - 标准模式：headless profile 默认就是原生执行器（PTC 那个执行器在配置里是 disabled）。
  - 用量从 `--json` 的 NDJSON 里取：每个 `step_end` 事件带一份 usage，累加起来就是这一场。
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import override

from access import probe_command, relax_command
from harbor.agents.base import BaseAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

BUNDLE = Path(__file__).resolve().parent / "build" / "dsh-bundle.tar.gz"
REMOTE_BUNDLE = "/tmp/dsh-bundle.tar.gz"
# 容器里的位置：和运行时一样放 /opt 下，不放 /app —— 那是任务的工作目录。
ROOT = "/opt/dsh"
NODE = f"{ROOT}/node/bin/node"
CLI = f"{ROOT}/app/node_modules/@deepseek-ai/dsh/lib/bin.js"
HOME_DIR = f"{ROOT}/home"
PATCH = f"{ROOT}/patch.yml"
TASK = f"{ROOT}/task.txt"
EVENTS = f"{ROOT}/events.jsonl"
STDERR = f"{ROOT}/stderr.log"
WORKDIR = "/app"


class DshHarnessAgent(BaseAgent):
    """跑 DeepSeek 官方 harness（headless profile）。"""

    @staticmethod
    @override
    def name() -> str:
        return "deepseek-harness"

    @override
    def version(self) -> str:
        return os.environ.get("DSH_VERSION", "0.2.2-rc.1")

    def __init__(
        self,
        logs_dir: Path,
        model_name: str | None = None,
        timeout_sec: float | None = None,
        **kwargs,
    ):
        super().__init__(logs_dir, model_name=model_name, skip_model_parsing=True, **kwargs)
        self._timeout_sec = float(timeout_sec or os.environ.get("DSH_EVAL_TIMEOUT_SEC") or 3600)
        # 和三家的统一口径一致：512K 窗口、high 思考。换档时改环境变量，不改代码。
        self._context_window = int(os.environ.get("DSH_EVAL_CONTEXT_WINDOW") or 524288)
        # 一次回复最多多少 token。dsh 拿它当「给输出预留的窗口」，预留多少直接决定压缩点：
        # 阈值 = min(窗口×0.8, 窗口 − maxTokens − 65536)。
        self._max_tokens = int(os.environ.get("DSH_EVAL_MAX_TOKENS") or 32_768)
        self._reasoning = os.environ.get("DSH_EVAL_REASONING") or "high"
        self._model = (model_name or "deepseek/deepseek-flash").partition("/")[2] or "deepseek-flash"

    # ---------------------------------------------------------------- 环境准备

    def _patch(self) -> str:
        """覆盖 dsh 内置的模型目录：官方写的是 1M，这里按统一口径改小；思考强度也显式写上。"""
        return "\n".join([
            "- id: llm-deepseek",
            "  config:",
            f"    reasoningEffort: {self._reasoning}",
            "    models:",
            f"      - id: {self._model}",
            "        name: DeepSeek-V4.1-Flash",
            f"        contextWindow: {self._context_window}",
            f"        maxTokens: {self._max_tokens}",
            "        inputModalities: [text, image]",
            "        systemPromptUpdate: in-history",
            "        toolUpdate: addition-only",
            "",
        ])

    async def setup(self, environment: BaseEnvironment) -> None:
        if not BUNDLE.is_file():
            raise RuntimeError(f"还没有 dsh 离线包：先跑 node eval/dsh-bundle.mjs（缺 {BUNDLE}）")
        await environment.upload_file(BUNDLE, REMOTE_BUNDLE)
        patch = self._patch()
        await environment.exec(
            command=(
                "set -euo pipefail; "
                f"mkdir -p {ROOT} && tar -xzf {REMOTE_BUNDLE} -C {ROOT} && rm -f {REMOTE_BUNDLE} && "
                f"cat > {PATCH} <<'DSH_PATCH_EOF'\n{patch}DSH_PATCH_EOF\n"
                f"{NODE} --version && {NODE} {CLI} --version"
            ),
            timeout_sec=180,
            user="root",
        )
        self._log(f"dsh 装好：{self._model}，窗口 {self._context_window}，思考 {self._reasoning}")

    # ---------------------------------------------------------------- 跑任务

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        agent_user = environment.default_user
        # 题面、日志、DSH_HOME 都要能被实际跑 dsh 的用户写：有的题镜像不是 root 跑（USER nobody），
        # Harbor 的 default_user 还可能是空的。任务工作目录也可能只有 root 能写（踩过 EACCES）。
        # 统一交给 access.py，并且用实际用户试写一次再开跑。
        written = await environment.exec(
            command=(
                f"mkdir -p {HOME_DIR} && touch {EVENTS} {STDERR} && "
                f"(chown -R {agent_user} {ROOT} 2>/dev/null || true) && "
                + relax_command()
                + probe_command()
            ),
            timeout_sec=60,
            user="root",
        )
        if written.return_code != 0:
            raise RuntimeError(f"任务工作目录写不进去：{(written.stdout or written.stderr or '').strip()}")
        local_task = Path(self.logs_dir) / "task.txt"
        local_task.write_text(instruction, encoding="utf-8")
        await environment.upload_file(local_task, TASK)

        env = {
            "DSH_HOME": HOME_DIR,
            "DEEPSEEK_API_KEY": os.environ.get("DEEPSEEK_API_KEY", ""),
            # 容器的 DNS 被宿主机的 Clash TUN 劫持，走宿主机的转发代理出去。
            "HTTP_PROXY": os.environ.get("DSH_EVAL_PROXY", "http://host.docker.internal:7898"),
            "HTTPS_PROXY": os.environ.get("DSH_EVAL_PROXY", "http://host.docker.internal:7898"),
            "NO_PROXY": "localhost,127.0.0.1,::1",
        }
        command = (
            f"cd {WORKDIR} && timeout {int(self._timeout_sec)} "
            f"{NODE} {CLI} --profile headless --patch {PATCH} "
            f"--permission-mode danger-full-access --json - < {TASK} > {EVENTS} 2> {STDERR}"
        )
        started = time.monotonic()
        result = await environment.exec(
            command=command, env=env, timeout_sec=int(self._timeout_sec) + 120, user=agent_user,
        )
        elapsed = time.monotonic() - started
        exit_code = result.return_code
        self._log(f"dsh 结束：退出码 {exit_code}，{elapsed:.0f} 秒"
                  + ("（到时限被杀）" if exit_code == 124 else ""))

        await self._collect(environment, context, exit_code, elapsed)

    async def _collect(
        self, environment: BaseEnvironment, context: AgentContext, exit_code: int | None, elapsed: float,
    ) -> None:
        target = Path(self.logs_dir)
        for remote, name in ((EVENTS, "events.jsonl"), (STDERR, "stderr.log")):
            try:
                await environment.download_file(remote, target / name)
            except Exception as error:  # noqa: BLE001 - 收不到日志不该让试次失败
                self._log(f"取 {remote} 失败：{error}")

        usage = summarize(target / "events.jsonl")
        (target / "usage.json").write_text(json.dumps(usage, ensure_ascii=False, indent="\t"), encoding="utf-8")
        # n_input_tokens 是「含缓存」的累计输入：未命中的 input + 缓存读 + 缓存写。
        context.n_input_tokens = usage["inputTokens"] + usage["cacheReadTokens"] + usage["cacheWriteTokens"]
        context.n_cache_tokens = usage["cacheReadTokens"]
        context.n_output_tokens = usage["outputTokens"]
        context.metadata = {
            "agent": "deepseek-harness", "exitCode": exit_code, "elapsedSec": round(elapsed),
            "steps": usage["steps"], "toolCalls": usage["toolCalls"],
        }
        total_input = usage["inputTokens"] + usage["cacheReadTokens"] + usage["cacheWriteTokens"]
        self._log(
            f"用量：输入 {total_input}（其中缓存 {usage['cacheReadTokens']}）、"
            f"输出 {usage['outputTokens']}，{usage['steps']} 步、{usage['toolCalls']} 次工具调用"
        )

    def _log(self, message: str) -> None:
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        with (self.logs_dir / "dsh.log").open("a", encoding="utf-8") as handle:
            handle.write(f"{time.strftime('%H:%M:%S')} {message}\n")


def summarize(path: Path) -> dict[str, int]:
    """把 NDJSON 事件累加成用量：`step_end` 带一次模型调用的 usage，工具调用按 `tool_call` 数。"""
    totals = {"inputTokens": 0, "outputTokens": 0, "cacheReadTokens": 0, "cacheWriteTokens": 0,
              "steps": 0, "toolCalls": 0}
    if not path.is_file():
        return totals
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        kind = event.get("type")
        if kind == "status" and event.get("phase") == "step_end":
            totals["steps"] += 1
            usage = event.get("usage") or {}
            for key, field in (("inputTokens", "inputTokens"), ("outputTokens", "outputTokens"),
                               ("cacheReadTokens", "cacheReadTokens"), ("cacheWriteTokens", "cacheWriteTokens")):
                value = usage.get(key)
                if isinstance(value, int):
                    totals[field] += value
        elif kind == "tool_call":
            totals["toolCalls"] += 1
    return totals
