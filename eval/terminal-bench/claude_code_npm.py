"""Harbor 的 claude-code 适配器，只把「安装方式」换成传离线包。

官方适配器每进一个任务容器都要 `apt-get install nodejs npm` 再 `npm i -g @anthropic-ai/claude-code`，
几百个包走一遍代理要好几分钟，而容器跑完就扔，每道题都要重来一次。

这里改成：本地预先把 Claude Code 的官方 npm 包里的原生可执行文件打成 `eval/build/claude-bundle.tar.gz`，
装的时候上传、解包、链到 PATH。除了安装方式，其余（提示词、工具、完成判定、用量解析）全部沿用官方实现。
"""

from pathlib import Path

from harbor.agents.installed.claude_code import ClaudeCode

BUNDLE = Path(__file__).resolve().parent / "build" / "claude-bundle.tar.gz"
REMOTE_BUNDLE = "/tmp/claude-bundle.tar.gz"


class ClaudeCodeNpm(ClaudeCode):
    """从离线包装 Claude Code 的 claude-code。"""


    async def install(self, environment) -> None:
        if await self._installed_claude_satisfies_version(environment):
            return
        if not BUNDLE.exists():
            raise RuntimeError(
                f"还没有 Claude Code 离线包：先跑 node eval/claude-bundle.mjs（缺 {BUNDLE}）"
            )

        await environment.upload_file(BUNDLE, REMOTE_BUNDLE)
        await self.exec_as_root(
            environment,
            command=(
                "set -euo pipefail; "
                "mkdir -p /opt/claude && "
                f"tar -xzf {REMOTE_BUNDLE} -C /opt/claude && "
                "chmod +x /opt/claude/bin/claude && "
                "ln -sf /opt/claude/bin/claude /usr/local/bin/claude && "
                f"rm -f {REMOTE_BUNDLE} && "
                "claude --version"
            ),
        )
