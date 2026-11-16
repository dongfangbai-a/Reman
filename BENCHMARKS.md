# 全部基准测试汇总

两个基准，同一个模型 `DeepSeek-V4.1-Flash-1017` + `high` 思考，每题每家跑 1 次（复测另有几场，见备注）：

- **Terminal-Bench**：七道题；结果是题目级 0/1（`reward`）。
- **ProgramBench**：三道题；结果是用例通过率（%），“解出”要求全部用例通过，三道题都没解出。

用时都是「agent 自己干活的那一段」，不含装脚手架、建成员、判分准备、等审批。

| 基准 | 题目 | agent | 结果 | 用时 | 命中 / 未命中 / 输出 | 花费 | 缓存命中率 | 备注 |
|---|---|---|---|---|---|---|---|---|
| Terminal-Bench | `embedding-drift-monitor` | reman | **1.00** | 16 分 38 秒 | 4.94M / 40k / 83k | ¥0.47 | 99.20% |  |
| Terminal-Bench | `embedding-drift-monitor` | cc | 0.00 | 12 分 24 秒 | 3.30M / 41k / 73k | ¥0.40 | 98.77% |  |
| Terminal-Bench | `embedding-drift-monitor` | dsh | **1.00** | 7 分 10 秒 | 2.50M / 45k / 56k | ¥0.32 | 98.21% |  |
| Terminal-Bench | `mp-checkpoint-consolidation` | reman | **1.00** | 27 分 51 秒 | 13.87M / 60k / 153k | ¥0.95 | 99.57% |  |
| Terminal-Bench | `mp-checkpoint-consolidation` | cc | **1.00** | 26 分 0 秒 | 15.02M / 74k / 203k | ¥1.18 | 99.51% |  |
| Terminal-Bench | `mp-checkpoint-consolidation` | dsh | **1.00** | 24 分 48 秒 | 6.45M / 86k / 108k | ¥0.65 | 98.69% |  |
| Terminal-Bench | `risk-scorer-replay` | reman | **1.00** | 20 分 20 秒 | 18.17M / 67k / 208k | ¥1.26 | 99.63% |  |
| Terminal-Bench | `risk-scorer-replay` | cc | 0.00 | 23 分 35 秒 | 23.32M / 101k / 238k | ¥1.52 | 99.57% |  |
| Terminal-Bench | `risk-scorer-replay` | dsh | 0.00 | 2 小时 44 分 | 43.41M / 315k / 312k | ¥2.43 | 99.28% |  |
| Terminal-Bench | `shadow-relay` | reman | **1.00** | 17 分 28 秒 | 12.05M / 73k / 168k | ¥0.99 | 99.40% |  |
| Terminal-Bench | `shadow-relay` | cc | **1.00** | 2 小时 9 分 | 99.83M / 308k / 1.10M | ¥6.72 | 99.69% |  |
| Terminal-Bench | `shadow-relay` | dsh | 0.00 | 31 分 46 秒 | 45.16M / 1.56M / 272k | ¥3.55 | 96.67% |  |
| Terminal-Bench | `react-lead-form` | reman | **1.00** | 8 分 43 秒 | 6.06M / 38k / 91k | ¥0.52 | 99.38% |  |
| Terminal-Bench | `react-lead-form` | cc | **1.00** | 8 分 31 秒 | 3.31M / 40k / 90k | ¥0.47 | 98.82% |  |
| Terminal-Bench | `react-lead-form` | dsh | **1.00** | 9 分 1 秒 | 2.37M / 24k / 82k | ¥0.40 | 99.02% |  |
| Terminal-Bench | `mvcc-lsm-compaction` | reman | **1.00** | 5 分 44 秒 | 1.32M / 21k / 38k | ¥0.20 | 98.46% |  |
| Terminal-Bench | `mvcc-lsm-compaction` | cc | **1.00** | 3 分 9 秒 | 381k / 23k / 28k | ¥0.14 | 94.40% |  |
| Terminal-Bench | `mvcc-lsm-compaction` | dsh | 0.00 | 2 分 39 秒 | 364k / 13k / 21k | ¥0.10 | 96.50% |  |
| Terminal-Bench | `wal-recovery-ordering` | reman | **1.00** | 7 分 20 秒 | 4.57M / 36k / 83k | ¥0.46 | 99.23% |  |
| Terminal-Bench | `wal-recovery-ordering` | cc | **1.00** | 5 分 16 秒 | 1.57M / 33k / 58k | ¥0.29 | 97.93% |  |
| Terminal-Bench | `wal-recovery-ordering` | dsh | **1.00** | 5 分 53 秒 | 1.96M / 23k / 67k | ¥0.33 | 98.82% |  |
| ProgramBench | `jplot` | reman | 92.94% | 38 分 5 秒 | 54.28M / 125k / 237k | ¥2.16 | 99.77% |  |
| ProgramBench | `jplot` | cc | 87.26% | 1 小时 35 分 | 122.19M / 591k / 769k | ¥6.11 | 99.52% |  |
| ProgramBench | `jplot` | dsh | 95.01% | 40 分 28 秒 | 68.74M / 165k / 208k | ¥2.37 | 99.76% |  |
| ProgramBench | `go-critic` | reman | 39.36% | 43 分 3 秒 | 42.61M / 112k / 242k | ¥1.93 | 99.74% |  |
| ProgramBench | `go-critic` | cc | 64.41% | 1 小时 56 分 | 123.62M / 421k / 802k | ¥6.10 | 99.66% |  |
| ProgramBench | `go-critic` | dsh | 65.41% | 41 分 32 秒 | 63.08M / 542k / 271k | ¥2.89 | 99.15% |  |
| ProgramBench | `typst` | reman | 50.90% | 25 分 22 秒 | 50.06M / 125k / 245k | ¥2.11 | 99.75% |  |
| ProgramBench | `typst` | cc | 52.97% | 39 分 20 秒 | 75.24M / 305k / 397k | ¥3.40 | 99.60% |  |
| ProgramBench | `typst` | dsh | 60.47% | 1 小时 15 分 | 231.99M / 1.14M / 589k | ¥8.14 | 99.51% |  |
| Terminal-Bench | `embedding-drift-monitor` | cc | **1.00** | 5 分 55 秒 | 1.13M / 35k / 45k | ¥0.24 | 96.98% | 复测 |
| Terminal-Bench | `risk-scorer-replay` | dsh | 0.00 | 15 分 2 秒 | 12.10M / 86k / 135k | ¥0.87 | 99.30% | 复测 |
| ProgramBench | `go-critic` | reman | 22.84% | 1 小时 1 分 | 89.96M / 738k / 490k | ¥4.50 | 99.19% | 复测（私聊题面） |
| ProgramBench | `go-critic` | reman | 59.65% | 47 分 50 秒 | 68.10M / 417k / 400k | ¥3.38 | 99.39% | 复测（直发题面） |
| ProgramBench | `go-critic` | reman | 68.40% | 38 分 33 秒 | 55.53M / 102k / 273k | ¥2.31 | 99.82% | 复测（整理文案 + 直发题面） |
| ProgramBench | `typst` | reman | 53.64% | 46 分 26 秒 | 81.94M / 486k / 362k | ¥3.57 | 99.41% | 复测（整理文案 + 直发题面） |

备注里的「复测」是紧跟其后重跑的场次，明细见各自的结论文档。

## 按 agent 汇总

TB 七道题；PB 三题；复测不进汇总。

| agent | TB 通过 | PB 通过 | TB 用时 | TB 花费 | PB 用时 | PB 花费 | 合计用时 | 合计用量 | 合计花费 |
|---|---|---|---|---|---|---|---|---|---|
| reman | **7/7** | 0/3（56.74%） | 1 小时 44 分 | ¥4.85 | 1 小时 46 分 | ¥6.20 | 3 小时 31 分 | 207.94M / 696k / 1.55M | ¥11.05 |
| cc | **5/7** | 0/3（63.26%） | 3 小时 28 分 | ¥10.73 | 4 小时 11 分 | ¥15.61 | 7 小时 38 分 | 467.78M / 1.94M / 3.76M | ¥26.33 |
| dsh | **4/7** | 0/3（69.09%） | 4 小时 6 分 | ¥7.78 | 2 小时 37 分 | ¥13.39 | 6 小时 43 分 | 466.01M / 3.91M / 1.99M | ¥21.18 |

PB 那一列是「解出的题数（三道题的用例通过率）」：三道题都没解出，只有用例通过率。
合计用量是「命中 / 未命中 / 输出」的 token 数，口径和明细表一致（TB 七题加 PB 三题首跑，不含复测）。

## 初步结论

题目只选了 10 道（Terminal-Bench 7 道、ProgramBench 3 道），每题每家只跑 1 次，测试用的模型本身也不太稳定；
样本这么少，下面只能算模糊判断，不能当结论：

- 三个 agent 的缓存命中率都很高。
- 任务通过率上看不出 reman 有什么优势，但也不比 cc、dsh 差。
- 耗时较久的任务上，reman 似乎在用时和花费两方面有些优势。

这三条的细节见 [Terminal-Bench 结果](eval/terminal-bench/RESULTS.md)、[其余四题结果](eval/terminal-bench/EXTRA-RESULTS.md)、
[PB 结果](eval/programbench/RESULTS.md)。

## 说明

- **模型**：三家都走 DeepSeek 官方 API 接口的 `DeepSeek-V4.1-Flash-1017`，思考强度 `high`。
- **reman 只用一个成员**：每道题都是单个 AI 成员独自做完，没有真人参与，也没有开多成员协作；
  所以表里的成绩是「一个成员 + 运行时」的成绩，不是多成员协作的效果。
- 数据来源：`node eval/collect-results.mjs` 从 `eval/evidence/` 的原始数据算出三份 `results.json`（原始证据不放在仓库里，按批次打包在 Release，见 [eval/EVIDENCE.md](eval/EVIDENCE.md)）
  （根目录一份两家合并、两个基准目录各一份），`node eval/terminal-bench/tools/verify-benchmarks.mjs` 核对这份文档。
- 汇总里的 TB 是七道题，PB 是三题；六场复测只在上表里，不进汇总。
- 选题标准见各目录的 `TASKS.md`。
