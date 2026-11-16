#!/usr/bin/env python3
"""修 programbench 在这台机器上跑判分会踩的几个问题（幂等，重复跑没事）。

1. 把还开着的 `NamedTemporaryFile` 交给 `docker cp` → Windows 上报
   `being used by another process`，整场判 0。
2. `tempfile.mkstemp()` 的 fd 没关 → 收 results.xml 时 `PermissionError: WinError 32`。
3. 评测容器要装 `pytest-timeout` / `pytest-rerunfailures`，但容器出网只放行模型 API
   （pypi 走不出去）→ 装插件这步必失败。这里改成：跑测试前把 `run.sh` 里的
   `--timeout` / `--timeout-method` / `-p pytest_timeout` 去掉，让 pytest 不因未知参数退出。
   **这会让判分少一层超时保护**，结果表里要注明。
4. 评测容器没有代理：`PROGRAMBENCH_CONTAINER_PROXY` 设了就会注入 HTTP(S)_PROXY（有外网时用得上）。

改完是改 site-packages 里的文件，**重新装 programbench 之后要再跑一次**。

    python eval/programbench/patch_programbench.py
    python eval/programbench/patch_programbench.py --check
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

PLUGIN_OLD = "\n".join([
	'                with tempfile.NamedTemporaryFile(mode="w", suffix=".py") as plugin:',
	'                    plugin.write(PYTEST_TIMEOUT_RETRY_PLUGIN_SOURCE)',
	'                    plugin.flush()',
	'                    env.copy_in(Path(plugin.name), PYTEST_TIMEOUT_RETRY_PLUGIN_PATH)',
	'',
])

PLUGIN_NEW = "\n".join([
	'                # Windows 上 docker cp 读不了还开着的临时文件：写完先关掉，复制完再删。',
	'                plugin = tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False)',
	'                try:',
	'                    plugin.write(PYTEST_TIMEOUT_RETRY_PLUGIN_SOURCE)',
	'                    plugin.close()',
	'                    env.copy_in(Path(plugin.name), PYTEST_TIMEOUT_RETRY_PLUGIN_PATH)',
	'                finally:',
	'                    try:',
	'                        Path(plugin.name).unlink()',
	'                    except OSError:',
	'                        pass',
	'',
])

MKSTEMP_OLD = '        host_tmp = Path(tempfile.mkstemp(suffix=Path(container_path).suffix or ".out")[1])'

MKSTEMP_NEW = "\n".join([
	'        # mkstemp 的 fd 不关，Windows 上这个文件一直算「被占用」，最后 unlink 会 WinError 32。',
	'        fd, host_tmp_name = tempfile.mkstemp(suffix=Path(container_path).suffix or ".out")',
	'        import os as _os  # eval.py 顶部没有 import os',
	'        _os.close(fd)',
	'        host_tmp = Path(host_tmp_name)',
])

TIMEOUT_OLD = '            run_cmd = "chmod +x ./eval/run.sh && ./eval/run.sh"'

TIMEOUT_NEW = "\n".join([
	'            run_cmd = "chmod +x ./eval/run.sh && ./eval/run.sh"',
	'            # 容器里装不上 pytest-timeout（出网只放行模型 API）：去掉 run.sh 里的超时参数和插件，',
	'            # 免得 pytest 因为不认识的 --timeout 直接退出、results.xml 生成不出来。',
	'            run_cmd = (',
	'                "sed -i -E \'s/--timeout=[^ ]+//g; s/--timeout-method=[^ ]+//g; s/-p ?pytest_timeout//g\' ./eval/run.sh; "',
	'                + run_cmd',
	'            )',
])

PROXY_OLD = "\n".join([
	'        addopts = "--max-worker-restart=4"',
	'        env = {"PYTEST_ADDOPTS": addopts}',
])

PROXY_NEW = "\n".join([
	'        addopts = "--max-worker-restart=4"',
	'        env = {"PYTEST_ADDOPTS": addopts}',
	'        # 有外网时用它：PROGRAMBENCH_CONTAINER_PROXY=http://host.docker.internal:7898',
	'        _proxy = __import__("os").environ.get("PROGRAMBENCH_CONTAINER_PROXY")',
	'        if _proxy:',
	'            env["HTTP_PROXY"] = env["HTTPS_PROXY"] = env["http_proxy"] = env["https_proxy"] = _proxy',
	'            env["NO_PROXY"] = "localhost,127.0.0.1,::1"',
])

PATCHES: list[tuple[str, str, str]] = [
	("临时文件还开着就 docker cp", PLUGIN_OLD, PLUGIN_NEW),
	("mkstemp 的 fd 没关", MKSTEMP_OLD, MKSTEMP_NEW),
	("装不上 pytest-timeout 时去掉超时参数", TIMEOUT_OLD, TIMEOUT_NEW),
	("评测容器没有代理", PROXY_OLD, PROXY_NEW),
]


def find_eval_module() -> Path:
	try:
		import programbench.eval.eval as module  # noqa: PLC0415 - 要在运行时定位安装位置
	except ImportError:
		raise SystemExit("没装 programbench：先 pip install --user programbench")
	return Path(module.__file__)


def main() -> int:
	parser = argparse.ArgumentParser(description="修 programbench 在这台机器跑判分的问题")
	parser.add_argument("--check", action="store_true", help="只检查，不改文件")
	args = parser.parse_args()

	path = find_eval_module()
	text = path.read_text(encoding="utf-8")
	pending = [(name, old, new) for name, old, new in PATCHES if new not in text]
	if not pending:
		print(f"补丁都在：{path}")
		return 0
	if args.check:
		print(f"还有 {len(pending)} 处没打：" + "、".join(name for name, _, _ in pending))
		return 1

	missing = [name for name, old, _ in pending if old not in text]
	if missing:
		print(f"找不到要改的代码（programbench 可能改版了）：{'、'.join(missing)}", file=sys.stderr)
		return 1

	for _, old, new in pending:
		text = text.replace(old, new, 1)
	path.write_text(text, encoding="utf-8")
	print(f"打好补丁（{len(pending)} 处）：" + "、".join(name for name, _, _ in pending))
	return 0


if __name__ == "__main__":
	sys.exit(main())
