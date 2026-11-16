# 加测：shadow-relay + react-lead-form + mvcc-lsm-compaction

到现在一共跑了 **3 道题、9 场**（每家 3 场），都在 Terminal-Bench 上。这次再加三道题，
理由和当时定下来的一样：想把「多轮压缩下的长程表现」测到，同时补上缺的维度。下面是完整交代。

这批加测的结果单独记在 [EXTRA-RESULTS.md](EXTRA-RESULTS.md)（压缩点、输出上限、并发都和之前九场不同）。

## 一、已经跑了什么

**Terminal-Bench（3 道题 × 3 家 = 9 场，结果见 [RESULTS.md](RESULTS.md)）**

| 题目 | Opus 5 基线 | reman | cc | dsh | 压缩次数（reman / cc / dsh） |
|---|---|---|---|---|---|
| `embedding-drift-monitor` | 5/5 | 1.00 | 0.00 | 1.00 | 0 / 0 / 0 |
| `mp-checkpoint-consolidation` | 5/5 | 1.00 | 1.00 | 1.00 | 0 / 0 / 0 |
| `risk-scorer-replay` | 5/5 | 1.00 | 0.00 | 0.00 | 0 / 0 / **2** |

（`risk-scorer-replay` 还有一次 15 秒失败的作废场——容器里 `/app` 只有 root 可写、
测试根本没开始，不计入这 9 场。）

## 二、为什么还要加三道

1. **「多轮压缩」这个场景几乎没被测到**：3 道题 9 场里只有 `risk-scorer-replay` 那场 dsh 压了 2 次，
   其余 8 场一次都没有。想测长程，现在样本不够。
2. **Terminal-Bench 那三道都是 Opus 5 的 5/5**，难度上限被压得很低：三家在这三道上的差别主要是「用时和花费」，
   不是「能不能做出来」（三道里 cc 只过 1 道，其余两家 2–3 道）。
3. **已跑过的题目类型单一**：三道是「修实现 / 数据对账 / 二进制格式」。
   **没有一道是前端业务，没有一道是逆向取证，也没有一道是系统代码（数据库 / 并发 / 存储语义）的 bug**。

## 三、为什么继续在 Terminal-Bench 上加

- **有难度分层的数据**：66 道题每道都有 Opus 5 + Claude Code 跑 5 次的通过次数
  （见 [TASKS.md](TASKS.md) 的「CC 通过」一列），能按「2/5、3/5」这种可行性信息挑题。
- **题目是「在真实项目里改 bug / 加功能」**，比抽象的小题目更接近日常实际工作。

## 四、选题标准

1. **Opus 5 通过 2/5 或 3/5**（约 50% 能做对）。这次把难度加上去，不再只挑 5/5 的题。
2. **单容器、无 GPU**：多容器题（如 `heat-pump-warranty`）环境风险大，不划算。
3. **断言型判分**：靠明确的输出文件 / 测试断言，不靠主观判断。
4. **维度互补**：补上「逆向取证」「前端业务」「系统代码 bug」这三类，之前一道都没有。
5. **不拿 Opus 用时当筛选条件**：同一道题上，deepseek-flash 的耗时落在 Opus 的 **0.17×–4.6×** 之间
   （`embedding-drift` 0.17–0.41×、`mp-checkpoint` 0.49–0.55×、`risk-scorer` 0.55–**4.56×**），跨度 27 倍，
   几乎没有预测力。只把它当「这题本身多重」的粗略参考。

## 五、三道题

### 1. `shadow-relay`（Security / Forensics）

| 项 | 值 |
|---|---|
| 考查什么 | 网络取证 + 逆向自定义协议：从抓包里找出被入侵主机、还原 DGA 命名序列、解码会话、解密被窃数据 |
| Opus 5 | **3/5**，CC 平均 12 分钟；专家估计 3 小时 |
| 判分 | 输出 `/app/output/flag.txt` 与 `/app/output/analysis.json`，四个字段：`compromised_host`、`dga_seed`（8 位 hex）、`predicted_domains`（后 5 个）、`derived_key`（64 位 hex） |
| 容器 | 单容器，8 CPU / **6 GB** / 10 GB 存储；verifier 单独环境，收集 `/tmp/agent.patch` |
| agent 超时 | 28800 秒（用 `--timeout-multiplier 0.375` 压到 3 小时，和已跑过的场次一致） |

**为什么选它**：四个字段是分步的答案，就算三家都拿 0，也能从判分输出看出各自走到哪一步
（比如 `compromised_host` 对了、`derived_key` 错，说明定性分析行、密码推导不行）。这是二元 reward 里信息量最大的一种题。

### 2. `react-lead-form`（Software / Frontend）

| 项 | 值 |
|---|---|
| 考查什么 | 修 React + TypeScript 的线索录入表单：校验、归一化、确定性时间戳、台账对账、CRM 导出；必须走统一的 `submitLead` 管线 |
| Opus 5 | **2/5**，CC 平均 37 分钟；专家估计 5 小时 |
| 判分 | 输出 `submission.json`、`crm_leads.json`、`lead_sources.json`、`reconciliation.json`、`incomplete_leads.json` 等；规范文件在 `/app/src/spec/` |
| 容器 | 单容器，**6 CPU** / **6 GB**；verifier 超时 900 秒 |
| agent 超时 | 28800 秒，同样压到 3 小时 |

**为什么选它**：前端 + 业务规则是已跑过的六道完全没有的维度；判分围绕多个输出文件和「同一套管线」的约束，
边界条件多（不完整线索、无效线索要安全失败），能看出实现质量差异。

### 3. `mvcc-lsm-compaction`（Software / Databases）

| 项 | 值 |
|---|---|
| 考查什么 | 一个 MVCC LSM 存储引擎的**可见性 bug**：读 `/app/crash_report.txt`，定位根因，改 `/app/src` 与 `/app/include/mvcc_lsm/`，再补一个确定性回归测试 |
| Opus 5 | **3/5**，CC 平均 24 分钟；专家估计 4 小时 |
| 判分 | 编译并跑 C++ 模型 + 隐藏测试（`test_visibility.py`、`reference_oracles.py`）；要求 `make -C /app test` 与崩溃复现 `make -C /app repro` 都过，且**不能靠「永不删旧版本」蒙过去**（要保留压缩行为） |
| 容器 | 单容器，2 CPU / **6 GB**（加测统一提到 6 GB / 6 CPU）；verifier 超时 900 秒 |
| agent 超时 | 28800 秒，同样压到 3 小时 |

**为什么选它**：三道加测里唯一考「读真实系统代码、定位并发 / 存储语义 bug」的题；而且强制写回归测试，
能区分「改到测试变绿」和「真理解了这个失效模式」。

## 六、并行方案

- **原计划**：同一道题的 3 个 agent 同时跑，三道题**完全串行**（一波跑完再跑下一波）。
- **实际做法（测试中调整过）**：`shadow-relay` 的 cc 太耗时——21:24:23 起跑，71 分钟后还没结束，
  而同一题的 reman 只用了 17 分 28 秒、dsh 31 分 46 秒。为了不一直等 cc，在 **22:35:51**（cc 已跑 71 分 28 秒）
  就起了第二题 `react-lead-form` 的 reman 与 dsh。所以这一批实际的并发规则是：
  **容器里始终只有 3 个在跑**（cc 占一个，第二题的两家占两个），而不是「同一道题的三家」。
- **对口径没有影响**：本来就是「同一时间 3 个容器在跑」，调整前后都是 3 个，负载条件一致，
  所以结果照常记，不需要额外注明。
- 资源：每容器内存给到 **6 GB**、CPU 也按题目调大（数据集原本是 `shadow-relay` 8 CPU / 4 GB、
  `react-lead-form` 2 CPU / 4 GB，改的是本地副本的 `task.toml`，镜像不动）。
  `shadow-relay` 一波 3 容器 = 24 vCPU / 18 GB；`react-lead-form` 与 `mvcc-lsm-compaction`
  各一波 3 容器 = **18 vCPU / 18 GB**。
  宿主为docker分配了 16 核 / 30 GB 够用——agent 大部分时间在等 API，CPU 不会真占满；内存用掉 18 GB 还留 12 GB 给 WSL 与判分。
  同时最多 3 个容器：`shadow-relay` 三家一起跑时是 24 vCPU / 18 GB；后来变成「cc 一个 + 第二题两家」时是
  8+6+6=20 vCPU / 18 GB。CPU 略超 16 核，换来的是单家不会被 CPU 饿到。
- **判分容器也一起调**：`verifier` 的内存从 4 GB 提到 6 GB；`react-lead-form` 的 verifier CPU 从 2 提到 4
  （判分要跑 `npm build` + pytest，2 核太紧）。判分只在最后几分钟跑，不和 agent 抢资源。
- 每个 agent 的证据单独落盘：`eval/evidence/terminal-bench/<agent>-<时间>/<题>__<id>/`；reman 的数据目录、
  cc 的 `cc-projects`、dsh 的 `dsh-sessions` 都挂载到宿主（不靠收尾拷贝）。
- 三家用 `compare.sh` 分别起（`-a reman|cc|dsh -i <题>`），三个进程并行，日志各写各的。

### 卡住判定（并行才需要）

docker 里已经关掉了省电模式（Docker Desktop 的 Resource saver，会把整个 WSL 虚拟机挂起、容器时钟跟着停），
之前那种 `exec` 卡住、收不到输出的情况应该不会再出现。但并行跑的时候，万一某个 agent 的容器真的卡住，
我们会把「它没干活」当成「它慢」，数字就错了——所以还是要加这个判定，目的只是确认容器真没卡住。

要区分「容器真的挂起」和「`docker exec` 只是收不到输出」：

- 起跑后按 30 秒一次，采 `docker exec <容器> date +%s` 与宿主时间，算**时钟漂移**；
- **连续 60 秒内漂移超过 15 秒 → 判定真挂起**，记一条 `hang` 事件，该场次的时间口径要扣掉这段；
- `docker exec` 超时或无输出但时钟正常 → 记 `exec-lost`，不算卡住、不影响 agent 干活。

已跑过的 Terminal-Bench 六场核过「场次墙钟 − 容器内跨度」的差值（46–89 秒，都是 setup + 判分准备），没有真挂起。

## 七、压缩时机统一到 350K 左右

**前后两批的口径正好相反**：

- **前三题**：只固定**窗口**（512K，三家同一窗口），压缩阈值交给各家内部决定，我们不管。
  于是同一窗口下，三家的实际阈值差得很远：

| agent | 输出上限（前三题） | 各家的阈值算法 | 实际阈值 | 九场里压到没有 |
|---|---|---|---|---|
| reman | **没有配置**（不向 API 传 `max_output_tokens`，用服务端默认） | 窗口 × 0.7 | 367,002 | 没有 |
| dsh | 它自己默认（给输出预留 256K + 64K 余量） | 窗口 − 256K − 64K | 202,752 | 压了 2 次（202,869、201,340） |
| cc | 32,000（Claude Code 自己的默认） | 窗口 × 80% | 419,430 | 没有 |

- **这次反过来**：不固定窗口，**固定阈值**——三家都在 35 万左右压缩，窗口按各家的公式倒推出来（见下表）。

依据：`jobs/reman-1112-1808/embedding-drift-monitor__vFHMzMH/artifacts/logs/artifacts/reman-data/models.json`
里只有 `contextWindow: 524288`、没有 `maxOutputTokens`（`src/models/client.ts` 里没配就不传这个字段）；
cc 那几场的 `claude-code.txt` 里是 `maxOutputTokens: 32000`。

**为什么改成固定阈值**：前三题的阈值各自决定，结果九场里只有 dsh 一家真的压过（它的阈值刚好落在 20 万），
reman 和 cc 的阈值在 36.7 万和 41.9 万，压根没跑到——「谁被压缩得更早、谁丢了上下文」这个干扰项没有被控制住。
这次把三家对齐到同一点（350K 左右）；这个点也更接近 1M 上下文模型的惯用区间：它们一般七到八成（≈700K）
才压缩，**前一半左右才是上下文注意力最好的段**。

**三家都设在 350K 左右，窗口一律用整数**：

| agent | 触发公式 | 要设的窗口 | 输出上限 | 触发点 |
|---|---|---|---|---|
| reman | 窗口 × `OPTIMIZE_RATIO`(0.7) | `REMAN_WINDOW=500000` | 64K | 350,000 |
| dsh | min(窗口 × 0.8, 窗口 − 输出 − 64K 余量) | `DSH_WINDOW=480000` | 64K | 348,928 |
| cc | 窗口 × `AUTOCOMPACT_PCT_OVERRIDE`(80%) | `CC_WINDOW=440000` | 64K | 352,000 |

三家触发点相差不到 3.1K（约 0.9%），可以认为一致。

**输出上限统一到 64K**（65,536）：前三题三家各自不同（reman 根本没配、cc 32,000、dsh 按自己默认），
「一次能写多长的文件」本来就不公平，这次一起定成 65,536。输出预留变大后，dsh 的压缩点跟着变小——
它的公式里要留两块（64K 输出 + 64K 余量 = 131,072），所以窗口 480,000 对应的触发点是 348,928。
`min()` 里窗口 × 0.8 = 384,000，比 348,928 大，不起作用，生效的是减出来的那一项——
这也解释了 dsh 当初 `524288 − 256000 − 65536 ≈ 202,752` 为什么正好是那场的实测触发点（202,869）：
那是 **dsh 一家**的点，不是三家的点。

**验证**：这些是推算，真实触发点必须从跑出来的 `input_tokens` 序列里读（`tools/compactions.mjs`）。
第一场跑完先核对，偏差超过 30K 就按实测值再校准，并把实际值写回本文档。

## 八、口径与预算

- 与已跑过的 9 场同口径：用时取 agent 干活那一段（Harbor 的 `agent_execution`）、花费按 `eval/pricing.json` 三段价、
  压缩次数按 `input_tokens` 断崖（比上一条少 40% 且少 5 万 token）、每题每家跑 **1 次**、单场上限 3 小时。
- **新增记录两件事**：① 判分的逐字段 / 逐用例结果（三家都 0 时这是唯一的区分依据）；② 实际的压缩触发点。
- 预算：每题每家 3 小时上限，估计三道题合计 ¥15–30。
- 风险：这两道 Opus 也才 2/5–3/5，deepseek-flash **可能三家都是 0**。这次的目标是「看走到哪一步」，
  不是「必须解出来」。

## 九、补充加测：`wal-recovery-ordering`（只跑 reman）

前六题跑完（都是在 Terminal-Bench 上），reman 是三家成绩最好的（6/6）。再往上压一档难度：
只测 reman 一家，挑一道 **Opus 5 + Claude Code 五次全没做出来（0/5）** 的题。

**题目**：`wal-recovery-ordering`，Software / Databases，专家估计 6 小时，CC 平均 20 分钟、**0/5**。
单容器，2 CPU / 4 GB，无 GPU、无 MCP，agent 上限 28800 秒、verifier 上限 1800 秒，产物是 `/app/`。

**考察什么**：按写死的规则精确实现 WAL 崩溃恢复。从快照（若干 segment，各带 `durable_count`）恢复状态，
规则全是细节：只重放每个 segment 的 durable prefix（缺省为 0）；从 `lsn = 1` 起的**连续前缀**重放、
遇第一个缺口即停；重复 LSN 取**最小 `segment_id`** 的那条，且所在 segment 的 id 优先于条目自带 id；
segment 与条目顺序都不得影响结果；不得修改输入，返回对象彼此独立。另有 `make_engine` 要能产生快照
（`commit_update` / `crash_snapshot`）。判分除了 25 条明面用例、72 个隐藏场景，还有两道闸：
`structural_gate.py`（不许 import `subprocess`/`socket`/`asyncio`/`multiprocessing`/`shutil`/`ctypes`、
不许 `eval`/`exec`/`compile`、不许 `except: pass`、不许写盘、不许引入 `typing.Any`/`typing.cast` 或新依赖）
与 `performance_gate.py`（防「每次全量重放」这类糊弄写法）。

**为什么选它**：规则写死、可逐条判，跑得快（CC 20 分钟，deepseek-flash 慢几倍也不会撞 3 小时上限），
不依赖外部工具链，结果可复现；而且和已跑的 `mvcc-lsm-compaction` 同属数据库但考的不是同一件事
（那题考可见性与压缩行为，这题考崩溃恢复的顺序与快照语义）。
备选两题：`session-window-debug`（0/5、22 分钟，但只有 7 条用例、信号粗）、
`batched-eval-parity`（1/5、45 分钟，专家 24 小时，题大可能撞上限）。

**设置**：只跑 reman 一场，其余沿用这一批——窗口 500,000（触发点 350,000 左右）、输出上限 65,536、
思考强度 `high`、工具全 `allow`、单场上限 3 小时。没有并行的必要，跑一场即可。

**补记（2026-11-14）：把 cc 和 dsh 也各补一场**。reman 这一场只用 **7 分 20 秒**就做完了，
而且 **97 条用例全过**（含两道闸）——一道对 Opus 5 是 0/5 的题，对 deepseek-flash 反而**不难**。
「0/5」只说明它对 Opus 5 难，不能推出对别的模型也难；只测一家也看不出这是「这个模型行」还是「所有 agent 都行」。
所以补上 cc、dsh 各一场，设置与上面一致。两家也能做对 → 说明这题对 deepseek-flash 这一档模型本来就容易，
当初拿它「压难度」的判断是错的；只有 reman 做对 → 那才是脚手架/工作方式上的差别。

**要看什么**：
1. 奖励（解出与否）——按 0/5 的难度，大概率解不出，这本身不意外；
2. 解不出时落到哪一步：25 条明面用例过了多少、72 个隐藏场景错在哪类规则
   （durable prefix？缺口停止？重复 LSN 取最小 segment？顺序无关？输入不可变？）；
3. 两道闸有没有被触发——被结构闸拦下说明它想走捷径（写盘、`except: pass`、加依赖），
   被性能闸拦下说明它用了全量重放，这两者都是行为信号，比分数有用。

**预算**：一场 3 小时上限，估计 ¥1–5。
