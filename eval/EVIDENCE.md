# 基准测试的原始证据

仓库里不放原始证据：`eval/evidence/` 有一个多 G，还都是日志和产物，放进 git 历史会让仓库永远这么大。
证据按批次打包放在 GitHub Release 里，仓库里只留脚本、`eval/results.json`、结果文档和这份索引。

## 怎么用

```bash
# 1. 从下表对应批次的 Release 下载包，放到仓库根目录
# 2. 解压，会在 eval/evidence/ 下展开成原来的目录结构
tar -xzf 2026-11-artifacts.tar.gz -C .

# 3. 核对：文档里的数字能从这里重算出来
node eval/terminal-bench/tools/verify-benchmarks.mjs
node eval/terminal-bench/tools/verify-usage.mjs
node eval/collect-results.mjs
```

## 批次

| 批次 | 包 | 大小 | sha256 | 文件数 | 覆盖的运行 | 打包时的代码提交 |
|---|---|---|---|---|---|---|
| 2026-11 | `2026-11-artifacts.tar.gz` | 697.2M | `4254f9658f1c90c0787ee2ad41583629595eb4ddd5489019b54e239e4b9f8440` | — | 36 个 | `7215c37` |
| 2026-11 | `2026-11-programbench.tar.gz` | 81.1M | `e45c7c0cb65fca8217f00d6dbc6a82a1ac758617f2dd69edc591c2b39a3b6acd` | — | 36 个 | `7215c37` |
| 2026-11 | `2026-11-terminal-bench.tar.gz` | 46.2M | `e5ab560f65c4af6d1710a4bbc7caa35139ab6b945e0ccb043d181b416d0d4365` | — | 36 个 | `7215c37` |

## 打过的码

打包时把这些内容换成了占位符（原始证据不动）：

- API 密钥：`sk-<redacted>`
- Bearer 令牌：`Bearer <redacted>`
- Windows 用户目录：`<user-dir>`
- Git Bash 路径：`<user-dir>`
- 本机用户名：`<user>`

## 每一行结果属于哪个批次

| 运行目录 | 基准 | 题目 | agent | 结果 | 用时 | 批次 |
|---|---|---|---|---|---|---|
| `1114-2029-reman-go-critic__go-critic.9aea378` | ProgramBench | `go-critic` | reman | 355/902 | 2583 秒 | 2026-11 |
| `1115-0041-reman-go-critic__go-critic.9aea378` | ProgramBench | `go-critic` | reman | 206/902 | 3683 秒 | 2026-11 |
| `1115-0230-reman-go-critic__go-critic.9aea378` | ProgramBench | `go-critic` | reman | 538/902 | 2870 秒 | 2026-11 |
| `1115-0826-reman-go-critic__go-critic.9aea378` | ProgramBench | `go-critic` | reman | 617/902 | 2313 秒 | 2026-11 |
| `1114-2030-cc-go-critic__go-critic.9aea378` | ProgramBench | `go-critic` | cc | 581/902 | 6947 秒 | 2026-11 |
| `1114-2030-dsh-go-critic__go-critic.9aea378` | ProgramBench | `go-critic` | dsh | 590/902 | 2492 秒 | 2026-11 |
| `1114-1810-reman-rs__jplot.2a54bcc` | ProgramBench | `jplot` | reman | 671/722 | 2285 秒 | 2026-11 |
| `1114-1810-cc-rs__jplot.2a54bcc` | ProgramBench | `jplot` | cc | 630/722 | 5724 秒 | 2026-11 |
| `1114-1811-dsh-rs__jplot.2a54bcc` | ProgramBench | `jplot` | dsh | 686/722 | 2428 秒 | 2026-11 |
| `1114-2305-reman-typst__typst.88356d0` | ProgramBench | `typst` | reman | 909/1786 | 1522 秒 | 2026-11 |
| `1115-0721-reman-typst__typst.88356d0` | ProgramBench | `typst` | reman | 958/1786 | 2786 秒 | 2026-11 |
| `1114-2306-cc-typst__typst.88356d0` | ProgramBench | `typst` | cc | 946/1786 | 2360 秒 | 2026-11 |
| `1114-2306-dsh-typst__typst.88356d0` | ProgramBench | `typst` | dsh | 1080/1786 | 4496 秒 | 2026-11 |
| `reman-1112-1808` | Terminal-Bench | `embedding-drift-monitor` | reman | 1.00 | 998 秒 | 2026-11 |
| `cc-1112-1702` | Terminal-Bench | `embedding-drift-monitor` | cc | 0.00 | 744 秒 | 2026-11 |
| `cc-1115-0150` | Terminal-Bench | `embedding-drift-monitor` | cc | 1.00 | 356 秒 | 2026-11 |
| `dsh-1112-1341` | Terminal-Bench | `embedding-drift-monitor` | dsh | 1.00 | 430 秒 | 2026-11 |
| `reman-1112-1827` | Terminal-Bench | `mp-checkpoint-consolidation` | reman | 1.00 | 1671 秒 | 2026-11 |
| `cc-1112-1741` | Terminal-Bench | `mp-checkpoint-consolidation` | cc | 1.00 | 1560 秒 | 2026-11 |
| `dsh-1112-1635` | Terminal-Bench | `mp-checkpoint-consolidation` | dsh | 1.00 | 1488 秒 | 2026-11 |
| `reman-1113-2258` | Terminal-Bench | `mvcc-lsm-compaction` | reman | 1.00 | 344 秒 | 2026-11 |
| `cc-1113-2317` | Terminal-Bench | `mvcc-lsm-compaction` | cc | 1.00 | 189 秒 | 2026-11 |
| `dsh-1113-2258` | Terminal-Bench | `mvcc-lsm-compaction` | dsh | 0.00 | 159 秒 | 2026-11 |
| `reman-1113-2235` | Terminal-Bench | `react-lead-form` | reman | 1.00 | 523 秒 | 2026-11 |
| `cc-1113-2316` | Terminal-Bench | `react-lead-form` | cc | 1.00 | 511 秒 | 2026-11 |
| `dsh-1113-2238` | Terminal-Bench | `react-lead-form` | dsh | 1.00 | 541 秒 | 2026-11 |
| `reman-1112-1856` | Terminal-Bench | `risk-scorer-replay` | reman | 1.00 | 1220 秒 | 2026-11 |
| `cc-1112-1716` | Terminal-Bench | `risk-scorer-replay` | cc | 0.00 | 1415 秒 | 2026-11 |
| `dsh-1112-1349` | Terminal-Bench | `risk-scorer-replay` | dsh | 0.00 | 9863 秒 | 2026-11 |
| `dsh-1115-0157` | Terminal-Bench | `risk-scorer-replay` | dsh | 0.00 | 903 秒 | 2026-11 |
| `reman-1113-2124` | Terminal-Bench | `shadow-relay` | reman | 1.00 | 1048 秒 | 2026-11 |
| `cc-1113-2124` | Terminal-Bench | `shadow-relay` | cc | 1.00 | 7737 秒 | 2026-11 |
| `dsh-1113-2124` | Terminal-Bench | `shadow-relay` | dsh | 0.00 | 1906 秒 | 2026-11 |
| `reman-1114-0015` | Terminal-Bench | `wal-recovery-ordering` | reman | 1.00 | 440 秒 | 2026-11 |
| `cc-1114-1708` | Terminal-Bench | `wal-recovery-ordering` | cc | 1.00 | 316 秒 | 2026-11 |
| `dsh-1114-1717` | Terminal-Bench | `wal-recovery-ordering` | dsh | 1.00 | 353 秒 | 2026-11 |

