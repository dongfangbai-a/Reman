# eval：agent 脚手架的基准测试

同一个模型（DeepSeek `deepseek-flash`），换不同的 agent 脚手架，比**用时**和**花费**。
每套基准有自己的目录，共用的东西放在本目录。

| 目录 | 是什么 |
|---|---|
| [terminal-bench/](terminal-bench/) | Terminal-Bench 4.0：修 bug、做功能、写脚本一类的单场任务（66 题里挑）。当前主战场 |
| [programbench/](programbench/) | ProgramBench：只给编译好的二进制和文档，从零重建整个程序（200 题里挑）。链路验证中 |

## 共用

| 东西 | 说明 |
|---|---|
| `pricing.json` / `pricing.mjs` | DeepSeek 的价格（命中 / 未命中 / 输出 三段），两套基准都用它算花费 |
| `decrypt-key.mjs` | 从本机运行时的数据目录里解出 API key |
| `results.json` | 两家合一份的逐场结果（`collect-results.mjs` 生成，可以提交） |
| `collect-results.mjs` | 从 `evidence/` 里的原始数据算出 `results.json`（根目录一份、两个基准目录各一份） |
| `pack-evidence.mjs` | 把 `evidence/` 按批次打包（先打码再扫）、记进 `evidence-batches.json`、生成 `EVIDENCE.md` |
| `evidence-batches.json` | 证据包索引：批次、包名、大小、sha256、覆盖哪些运行 |
| `EVIDENCE.md` | 给人看的证据索引：怎么下载解压、怎么核对、每行结果属于哪个批次 |

## 三类数据

| 目录 | 是什么 | 能不能删 |
|---|---|---|
| `.cache/` | 可重建的东西：`tools/`（Harbor 与它的 Python 环境、`proxy-relay.mjs`）、`datasets/`（题目数据）、`build/`（三家离线包） | 能，重下次重打 |
| `evidence/` | 跑完之后的原始数据：`terminal-bench/<批次>/<单场>/`、`terminal-bench/logs/`、`programbench/<单场>/`、`programbench/logs/` | **不能**（删了不可复现） |
| `.local/` | 只在本机的东西：`stash/`（跑废或可疑的数据，不一定再看但先留着）、`prompts/`（cc 与 dsh 的系统提示词快照） | 随意，只是别当成证据 |

`.cache/`、`evidence/`、`.local/` 都在 `.gitignore` 里，不进仓库。仓库里只有脚本、文档和三份 `results.json`。
想留证据给别人看，按批次打成压缩包。

## 口径

两套基准的「用时」都取 agent 真正干活的那一段（TB 是 Harbor 记的 `agent_execution` 区间，PB 是 `run.json` 的 `elapsed_seconds`），
不含装包、判分准备；花费按 `pricing.json` 的三段价算；上下文窗口、思考强度、审批放行方式三家统一。
具体见各自目录下的 `RESULTS.md`。
