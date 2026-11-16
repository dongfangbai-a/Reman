"""把运行时装进任务容器里跑：一次试次一个 AI 成员，跑完把数据目录放到 /logs/artifacts。

Harbor 调用的顺序是 setup() 一次（装环境）、run() 一次（给任务说明、等它干完）。
完成判定不能只看「这一次运行结束了」：成员可能把长命令丢到后台，运行结束了任务还在跑。
所以三个条件都满足、并且连续一段时间不变，才算停下：
  1) 成员状态是 idle（不是 running / waiting_approval / paused）；
  2) /v1/members/<id>/tasks 里没有还在跑的后台任务；
  3) /v1/state 的 revision 连续若干秒没变（后台任务结束时会给成员补一条新内容、再起一轮运行，
     这一条同时挡住那段空档）。
"""
from __future__ import annotations

import asyncio
import json
import os
import shlex
import tempfile
import time
from pathlib import Path
from typing import override

from access import probe_command, relax_command
from harbor.agents.base import BaseAgent
from harbor.agents.capabilities import AgentCapabilities
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

# 容器里的位置：都放在 /opt/reman 下，不放 /workspace —— 验证阶段会清空 /workspace。
NODE = "/opt/reman/node/bin/node"
APP_DIR = "/opt/reman/app"
DATA_DIR = "/opt/reman/data"
PROBE = "/opt/reman/probe.mjs"
INSTRUCTION = "/opt/reman/instruction.txt"
LOG = "/opt/reman/runtime.log"
PORT = "6100"

# 成员能用的工具：容器里没有浏览器、也没有第二个成员，这两样不装；其余一律打开（terminal 默认关，要写上）。
TOOLS = [
    "shell", "files", "terminal", "view_image", "read_pdf",
    "search_history", "manage_reminders", "run_tool_script",
]

# 一次长轮询最多等多久：到了还没停下来就再来一次。
WAIT_TIMEOUT_SEC = 60.0
# 连续静默多久才算停下来：要盖住「一轮结束→补内容→再起一轮」「后台任务结束→唤醒」这类空档。
WAIT_QUIET_MS = 2000
# 长轮询答不上来（运行时不回话）连续这么多次，才去探运行时是不是挂了。
MAX_WAIT_FAILURES = 6
WAIT_RETRY_SEC = 5.0
# 容器里的命令根本跑不起来（Docker 卡住、exec 被杀）时，只能等它恢复；超过这么久就当基础设施失败。
# 这台机器上 Docker 抽风十分钟很常见，而成员在容器里照常干活，所以放宽到半小时。
EXEC_BROKEN_LIMIT_SEC = 1800.0
# 起始到能访问 /v1/state 最多等多久。
READY_TIMEOUT_SEC = 90.0


class RemanRuntimeAgent(BaseAgent):
    """跑我们自己的运行时。"""

    # 任务自带的 MCP 服务器（如 playwright）我们会写进运行时的 mcp.json，所以声明支持。
    capabilities = AgentCapabilities(mcp_servers=True)

    @staticmethod
    @override
    def name() -> str:
        return "reman-runtime"

    @override
    def version(self) -> str:
        return "0.1.0"

    def __init__(
        self,
        logs_dir: Path,
        model_name: str | None = None,
        timeout_sec: float | None = None,
        **kwargs,
    ):
        super().__init__(logs_dir, model_name=model_name, skip_model_parsing=True, **kwargs)
        self._timeout_sec = float(
            timeout_sec or os.environ.get("REMAN_EVAL_TIMEOUT_SEC") or 3600
        )
        # 思考强度：显式写在成员定义里，不依赖运行时的新成员默认值（改默认值也不会影响历史比较）。
        self._reasoning = os.environ.get("REMAN_EVAL_REASONING", "high")
        self._provider, _, self._model = (model_name or "deepseek/flash").partition("/")
        if not self._model:
            self._provider, self._model = "deepseek", self._provider

    # ---------------------------------------------------------------- 环境准备

    def _bundle(self) -> Path:
        path = Path(__file__).resolve().parent / "build" / "reman-bundle.tar.gz"
        if not path.is_file():
            raise FileNotFoundError(f"没有打包好的运行时：{path}，先跑 node eval/bundle.mjs")
        return path

    def _models_json(self) -> str:
        api_key = os.environ.get("DEEPSEEK_API_KEY") or os.environ.get("REMAN_EVAL_API_KEY")
        if not api_key:
            raise RuntimeError("要设 DEEPSEEK_API_KEY（运行时请求模型用）")
        return json.dumps(
            {
                "defaultModel": {"provider": self._provider, "model": self._model},
                "providers": [
                    {
                        "id": self._provider,
                        "name": "DeepSeek",
                        "baseUrl": os.environ.get("REMAN_EVAL_BASE_URL", "https://api.deepseek.com"),
                        "apiKey": api_key,
                        "models": [
                            {
                                "model": self._model,
                                "displayName": self._model,
                                # 这个值决定什么时候压缩上下文（运行时的触发点是窗口的 0.7）。
                                "contextWindow": int(
                                    os.environ.get("REMAN_EVAL_CONTEXT_WINDOW") or 1_000_000
                                ),
                                # 一次回复最多多少 token：模型单次能想 384K，不设上限时一份输出就能把窗口撑爆。
                                "maxOutputTokens": int(
                                    os.environ.get("REMAN_EVAL_MAX_OUTPUT_TOKENS") or 32_768
                                ),
                                "vision": True,
                            }
                        ],
                    }
                ],
            },
            ensure_ascii=False,
            indent="\t",
        )

    def _mcp_json(self) -> str | None:
        """把任务给的 MCP 服务器写成运行时认识的 mcp.json（Claude 那种 mcpServers 结构）。"""
        if not self.mcp_servers:
            return None
        servers: dict[str, dict[str, object]] = {}
        for server in self.mcp_servers:
            if server.command:
                servers[server.name] = {
                    "command": server.command,
                    "args": list(server.args),
                }
            elif server.url:
                # 运行时用 Streamable HTTP 连；任务里常给的是 /sse，改成 /mcp。
                url = server.url.replace("/sse", "/mcp")
                servers[server.name] = {"url": url, **({"headers": dict(server.headers)} if server.headers else {})}
        return json.dumps({"mcpServers": servers}, ensure_ascii=False, indent="\t")

    @override
    async def setup(self, environment: BaseEnvironment) -> None:
        agent_user = environment.default_user
        bundle = self._bundle()
        await environment.upload_file(bundle, "/tmp/reman-bundle.tar.gz")

        extract = await environment.exec(
            command=(
                "set -e\n"
                "mkdir -p /opt/reman\n"
                "tar -xzf /tmp/reman-bundle.tar.gz -C /opt/reman\n"
                "rm -f /tmp/reman-bundle.tar.gz\n"
                "mkdir -p " + DATA_DIR + "\n"
                "chmod +x " + NODE + "\n"
                + (f"chown -R {agent_user} /opt/reman\n" if agent_user else "")
                # 权限：镜像可能写 USER nobody、default_user 可能是空的，任务工作目录也可能只有 root 能写。
                # 统一交给 access.py（踩过好几次 EACCES 了），最后必须真的能写。
                + relax_command()
                + "command -v bash >/dev/null\n"
            ),
            timeout_sec=600,
            user="root",
        )
        if extract.return_code != 0:
            raise RuntimeError(f"解包失败：{extract.stderr or extract.stdout}")

        probe_local = Path(__file__).resolve().parent / "container" / "probe.mjs"
        await environment.upload_file(probe_local, PROBE)

        with tempfile.TemporaryDirectory(prefix="reman-eval-") as temp_dir:
            models = Path(temp_dir) / "models.json"
            models.write_text(self._models_json(), encoding="utf-8")
            await environment.upload_file(models, f"{DATA_DIR}/models.json")
            mcp_json = self._mcp_json()
            if mcp_json:
                mcp_file = Path(temp_dir) / "mcp.json"
                mcp_file.write_text(mcp_json, encoding="utf-8")
                await environment.upload_file(mcp_file, f"{DATA_DIR}/mcp.json")
                self._log(f"任务的 MCP 服务器已写入：{[server.name for server in self.mcp_servers]}")

        fix = await environment.exec(
            command=(
                f"chmod 600 {DATA_DIR}/models.json\n"
                + (f"chown {agent_user} {DATA_DIR}/models.json {PROBE}\n" if agent_user else "")
                + f"{NODE} --version\n"
            ),
            timeout_sec=60,
            user="root",
        )
        if fix.return_code != 0:
            raise RuntimeError(f"装完检查失败：{fix.stderr or fix.stdout}")

        # 用实际跑运行时的用户试写一次：写不进去就别开跑，免得整场 15 秒 failed。
        writable = await environment.exec(
            command=probe_command(), timeout_sec=60, user=agent_user or "root",
        )
        if writable.return_code != 0:
            raise RuntimeError(
                "任务工作目录写不进去（agent 用户 "
                f"{agent_user or 'root'}）：{(writable.stdout or writable.stderr or '').strip()}"
            )
        self._log(f"运行时已装好，node {fix.stdout.strip()}；{writable.stdout.strip()}")

    # ------------------------------------------------------------------- 跑起来

    async def _probe(self, environment: BaseEnvironment, *args: str, timeout_sec: int = 60):
        # 参数里可能有 JSON、路径：逐个加引号，别让 shell 把双引号吃掉。
        result = await environment.exec(
            command=" ".join([NODE, PROBE, *(shlex.quote(value) for value in args)]),
            env={"REMAN_PORT": PORT, "REMAN_DATA_DIR": DATA_DIR},
            timeout_sec=timeout_sec,
        )
        text = (result.stdout or "").strip().splitlines()
        if not text:
            return {"ok": False, "error": (result.stderr or "").strip()[:300] or "没有输出"}
        try:
            return json.loads(text[-1])
        except json.JSONDecodeError:
            return {"ok": False, "error": text[-1][:300]}

    async def _wait_ready(self, environment: BaseEnvironment) -> None:
        started = time.monotonic()
        while time.monotonic() - started < READY_TIMEOUT_SEC:
            state = await self._probe(environment, "state", timeout_sec=30)
            if state.get("ok"):
                self._log(f"运行时起来了，revision {state.get('revision')}")
                return
            await asyncio.sleep(1.0)
        log = await environment.exec(command=f"tail -40 {LOG} 2>/dev/null || true", timeout_sec=30)
        raise RuntimeError(f"运行时没能起来：{(log.stdout or '').strip()[-800:]}")

    @override
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        agent_user = environment.default_user
        started = time.monotonic()
        # 日志文件和数据目录要能被实际跑运行时的用户写：有的题镜像不是 root 跑（USER nobody），
        # Harbor 的 default_user 还可能是空的。权限一律放开，免得启动失败还看不到原因。
        await environment.exec(
            command=(
                f"mkdir -p {DATA_DIR} && touch {LOG} && "
                f"(chown -R {agent_user} /opt/reman 2>/dev/null || true) && "
                f"chmod -R a+rwX /opt/reman && chmod a+rw {LOG}"
            ),
            timeout_sec=30,
            user="root",
        )
        await environment.exec(
            command=(
                f"cd {APP_DIR} && nohup {NODE} --disable-warning=ExperimentalWarning "
                f"src/main.ts --data-dir {DATA_DIR} --port {PORT} > {LOG} 2>&1 & echo $!"
            ),
            timeout_sec=60,
            user=agent_user,
        )
        await self._wait_ready(environment)

        tools_json = json.dumps([*TOOLS, *(f"mcp:{server.name}" for server in self.mcp_servers)])
        workdir = self._working_directory(environment)
        init = await self._probe(
            environment, "init", self._provider, self._model, tools_json, workdir, self._reasoning, timeout_sec=120,
        )
        if not init.get("ok"):
            raise RuntimeError(f"建成员失败：{init.get('error')}")
        ai_id = init["aiId"]
        self._log(f"成员 {ai_id}，工作目录 {workdir}，思考强度 {self._reasoning}")

        Path(tempfile.gettempdir(), "instruction.txt")
        with tempfile.TemporaryDirectory(prefix="reman-eval-") as temp_dir:
            local = Path(temp_dir) / "instruction.txt"
            local.write_text(instruction, encoding="utf-8")
            await environment.upload_file(local, INSTRUCTION)
        if agent_user:
            await environment.exec(command=f"chown {agent_user} {INSTRUCTION}", timeout_sec=30, user="root")

        sent = await self._probe(environment, "send", ai_id, INSTRUCTION, timeout_sec=60)
        if not sent.get("ok"):
            raise RuntimeError(f"发任务说明失败：{sent.get('error')}")

        outcome, polls = await self._wait_done(environment, ai_id, started)
        self._log(f"结束：{outcome}，用时 {time.monotonic() - started:.0f} 秒，查了 {polls} 次")

        usage = await self._probe(environment, "usage", timeout_sec=60)
        if usage.get("ok"):
            totals = usage["usage"]
            context.n_input_tokens = totals.get("inputTokens")
            context.n_cache_tokens = totals.get("cachedTokens")
            context.n_output_tokens = totals.get("outputTokens")
            context.metadata = {
                "outcome": outcome,
                "wallSeconds": round(time.monotonic() - started, 1),
                "polls": polls,
                "failedRequests": totals.get("failedRequests"),
            }
            self._log(
                f"token：输入 {totals.get('inputTokens')}（缓存 {totals.get('cachedTokens')}）"
                f"输出 {totals.get('outputTokens')}，失败请求 {totals.get('failedRequests')}"
            )

        if outcome == "runtime-error":
            tail = await environment.exec(command=f"tail -30 {LOG} 2>/dev/null || true", timeout_sec=30)
            self._log(f"运行时最后几行：{(tail.stdout or '').strip()[-600:]}")

        await self._stop(environment, agent_user)
        await self._collect(environment, outcome)
        # 超时不抛异常：让验证照常跑，试次记成没做出来（reward 0），比整场异常更好比较。
        if outcome == "timeout":
            self._log(f"超时：成员 {self._timeout_sec:.0f} 秒内没有停下，按没做出来算")

    def _working_directory(self, environment: BaseEnvironment) -> str:
        # 任务的工作目录一般是 /app；没有就用根目录。
        return "/app" if getattr(environment, "task_env_config", None) is None or True else "/"

    async def _wait_done(self, environment: BaseEnvironment, ai_id: str, started: float) -> tuple[str, int]:
        """等成员真的停下来。

        运行时自己知道成员还有没有活（运行中、等待审批、有消息待处理、有后台任务），
        它给的长轮询接口会等到「没有工作、且静默了 quietMs」才返回，这里只管循环和超时。
        返回结束原因和轮询次数。
        """
        polls = 0
        failures = 0
        exec_failures = 0
        exec_broken_since: float | None = None
        while True:
            remaining = self._timeout_sec - (time.monotonic() - started)
            if remaining <= 0:
                return "timeout", polls
            polls += 1
            # 最后一段别超时：剩下的时间不到一次长轮询就按剩下的等，超时才好按「没做出来」收尾。
            wait_sec = min(WAIT_TIMEOUT_SEC, remaining)
            try:
                work = await self._probe(
                    environment, "wait", ai_id, str(WAIT_QUIET_MS), str(int(wait_sec * 1000)),
                    timeout_sec=int(wait_sec) + 30,
                )
            except Exception as error:  # noqa: BLE001 - 容器里偶尔抓不到输出，按「没答上来」处理
                work = {"ok": False, "error": str(error)[:300]}
                work["exec_failed"] = True
            # 连命令都没跑起来（Docker 卡住、exec 被杀）的时候，连 /v1/state 也问不到，
            # 判断不了运行时是不是真挂了——只能等容器恢复，别把基础设施的毛病记成运行时出错。
            exec_failed = bool(work.get("exec_failed")) or work.get("error") == "没有输出"
            if exec_failed:
                exec_failures += 1
                exec_broken_since = exec_broken_since or time.monotonic()
                if exec_failures == 1:
                    self._log(f"容器里的命令跑不起来（会重试）：{work.get('error')}")
                if time.monotonic() - exec_broken_since > EXEC_BROKEN_LIMIT_SEC:
                    raise RuntimeError(f"容器里的命令连续 {exec_failures} 次跑不起来，等了 "
                                       f"{EXEC_BROKEN_LIMIT_SEC:.0f} 秒还没恢复，按基础设施失败算")
                await asyncio.sleep(WAIT_RETRY_SEC)
                continue
            exec_failures = 0
            exec_broken_since = None
            if not work.get("ok"):
                # 命令跑起来了、运行时不回话：这才是运行时可能挂了。
                failures += 1
                if failures == 1:
                    self._log(f"长轮询没答上来（运行时不回话，会重试）：{work.get('error')}")
                if failures >= MAX_WAIT_FAILURES:
                    try:
                        alive = await self._probe(environment, "state", timeout_sec=60)
                    except Exception:  # noqa: BLE001 - 探不通就是探不通
                        alive = {"ok": False}
                    if alive.get("ok"):
                        self._log(f"连续 {failures} 次没答上来，但运行时还活着，继续等")
                        failures = 0
                        continue
                    self._log(f"连续 {failures} 次没答上来，运行时也探不通，当作出错")
                    return "runtime-error", polls
                await asyncio.sleep(WAIT_RETRY_SEC)
                continue
            failures = 0
            status = work.get("status")
            if status in ("failed", "interrupted", "paused"):
                return status, polls
            if work.get("settled"):
                self._log(f"停下了：静默 {work.get('quietMs')} 毫秒")
                return "idle", polls
            # 返回了但还在忙（长轮询到点）：接着等。

    async def _stop(self, environment: BaseEnvironment, agent_user: str | None) -> None:
        await environment.exec(
            command=(
                "pid=$(pgrep -f 'src/main.ts --data-dir " + DATA_DIR + "' | head -1)\n"
                "if [ -n \"$pid\" ]; then kill -TERM \"$pid\"; for _ in $(seq 1 20); do kill -0 \"$pid\" 2>/dev/null || exit 0; sleep 0.5; done; kill -9 \"$pid\" 2>/dev/null; fi\n"
                "exit 0\n"
            ),
            timeout_sec=60,
            user="root",
        )

    async def _collect(self, environment: BaseEnvironment, outcome: str) -> None:
        """把数据目录和运行时日志放到 /logs/artifacts，跑完在网页端能直接打开看。"""
        await environment.exec(
            command=(
                "mkdir -p /logs/artifacts\n"
                f"cp -a {DATA_DIR} /logs/artifacts/reman-data\n"
                f"cp -a {LOG} /logs/artifacts/runtime.log 2>/dev/null || true\n"
                f"printf '%s\\n' '{outcome}' > /logs/artifacts/outcome.txt\n"
                "chmod -R a+rX /logs/artifacts 2>/dev/null || true\n"
            ),
            timeout_sec=300,
            user="root",
        )

    def _log(self, message: str) -> None:
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        with (self.logs_dir / "agent.log").open("a", encoding="utf-8") as handle:
            handle.write(f"{time.strftime('%H:%M:%S')} {message}\n")
