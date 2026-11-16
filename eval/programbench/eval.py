#!/usr/bin/env python3
"""判分：对 run.py 产出的目录跑 ProgramBench 官方评测，把结果收成一行表。

    python eval/programbench/eval.py eval/evidence/programbench/1112-1730-cc-sitkevij__hex.61ae69b
    python eval/programbench/eval.py --all          # 把 evidence/programbench 下所有跑过的汇总成表

官方 CLI 是 `programbench eval <目录>`（或 `uvx programbench eval <目录>`）：它会拉题目镜像、
把 submission.tar.gz 解到 /workspace、跑 compile.sh，再跑各测试分支的 pytest 套件。
这里只负责「把命令跑起来 + 把结果读出来」，评测逻辑不重写。
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
RUNS = HERE.parent / "evidence" / "programbench"


def cli_command() -> list[str]:
	"""优先用本机装好的 programbench，其次 uvx，最后报错。"""
	if shutil.which("programbench"):
		return ["programbench"]
	# Git Bash 里 PATH 是 /c/... 形式，Windows 的 python 不认，这里直接找默认安装位置
	for base in (os.environ.get("APPDATA"), str(Path.home() / "AppData/Roaming")):
		if not base:
			continue
		exe = Path(base) / "Python" / "Python311" / "Scripts" / "programbench.exe"
		if exe.exists():
			return [str(exe)]
	if shutil.which("uvx"):
		return ["uvx", "programbench"]
	raise SystemExit("没找到 programbench CLI：先 pip install programbench（或装 uvx）")


def summarize(run_dir: Path) -> dict:
	"""把官方评测写出来的结果文件读成统一结构。文件名的细节可能有变，所以按内容找。"""
	summary = {"resolved": None, "tests_passed": None, "results": {}}
	for path in sorted(run_dir.rglob("*.json")):
		if not path.name.endswith(".eval.json"):
			continue
		try:
			data = json.loads(path.read_text(encoding="utf-8"))
		except (json.JSONDecodeError, OSError):
			continue
		if not isinstance(data, dict):
			continue
		# 官方 eval 的逐条结果：{test_results: [{name, branch, status}, ...]}
		tests = data.get("test_results")
		if isinstance(tests, list) and tests:
			for t in tests:
				name = t.get("name")
				if name:
					summary["results"][name] = t.get("status") or "fail"
			continue
		for branch, value in data.items():
			if not isinstance(value, dict):
				continue
			status = value.get("status") or ("pass" if value.get("passed") else "fail")
			summary["results"][branch] = status
	if summary["results"]:
		total = len(summary["results"])
		passed = sum(1 for status in summary["results"].values() if status in {"pass", "passed", "ok"})
		summary["tests_passed"] = round(passed / total, 4)
		summary["resolved"] = passed == total
	return summary


def eval_one(run_dir: Path, *, timeout: int) -> None:
	submission = run_dir / "submission.tar.gz"
	if not submission.exists():
		cands = sorted(run_dir.glob("*/submission.tar.gz"))
		if len(cands) == 1:
			submission = cands[0]
		else:
			raise SystemExit(f"{run_dir} 里没有 submission.tar.gz（run.py 是不是没跑完？）")
	print(f"判分 {run_dir.name}", flush=True)
	command = cli_command() + ["eval", str(run_dir)]
	print("$ " + " ".join(command), flush=True)
	done = subprocess.run(command, text=True, capture_output=True, timeout=timeout)
	(run_dir / "eval.log").write_text((done.stdout or "") + (done.stderr or ""), encoding="utf-8")
	if done.returncode != 0:
		print(f"评测命令退出码 {done.returncode}，日志见 {run_dir / 'eval.log'}", flush=True)
	summary = summarize(run_dir)
	meta_path = run_dir / "run.json"
	meta = json.loads(meta_path.read_text(encoding="utf-8")) if meta_path.exists() else {}
	meta["eval"] = summary
	meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
	print(f"结果：resolved={summary['resolved']} 测试通过={summary['tests_passed']}", flush=True)


def table() -> None:
	rows = []
	for run_dir in sorted(RUNS.glob("*/")):
		meta_path = run_dir / "run.json"
		if not meta_path.exists():
			continue
		meta = json.loads(meta_path.read_text(encoding="utf-8"))
		usage = meta.get("usage") or {}
		evaluated = meta.get("eval") or {}
		rows.append({
			"run": run_dir.name,
			"agent": meta.get("agent"),
			"task": meta.get("task"),
			"resolved": evaluated.get("resolved"),
			"tests": evaluated.get("tests_passed"),
			"seconds": meta.get("elapsed_seconds"),
			"input": usage.get("input"),
			"cache": usage.get("cacheRead"),
			"output": usage.get("output"),
		})
	if not rows:
		print("evidence/programbench 下还没有跑过的场次。", flush=True)
		return
	head = ["run", "agent", "task", "resolved", "tests", "seconds", "input", "cache", "output"]
	print("\t".join(head))
	for row in rows:
		print("\t".join("—" if row[key] is None else str(row[key]) for key in head))


def main() -> int:
	parser = argparse.ArgumentParser(description="ProgramBench 判分")
	parser.add_argument("run_dir", nargs="?", help="run.py 产出的目录")
	parser.add_argument("--all", action="store_true", help="只打印汇总表")
	parser.add_argument("--timeout", type=int, default=21600, help="单场判分最长秒数（默认 6 小时）")
	args = parser.parse_args()
	if args.all:
		table()
		return 0
	if not args.run_dir:
		parser.error("要么给一个目录，要么 --all")
	# 先按当前目录把路径定下来，再切到脚本所在目录（否则相对路径会被拼成 eval/programbench/… 两份）。
	run_dir = Path(args.run_dir).resolve()
	os.chdir(HERE)
	eval_one(run_dir, timeout=args.timeout)
	table()
	return 0


if __name__ == "__main__":
	sys.exit(main())
