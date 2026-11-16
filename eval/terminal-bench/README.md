# 基准测试：我们自己的运行时装进 Terminal-Bench 的任务容器里跑

目的：同一个模型（deepseek-flash），换不同的 agent 环境，看差距。第一步是把我们的运行时跑通，
数字对不对先不管。

## 需要的东西

- Harbor（评测框架，管容器、判分）：已经装在 `eval/.cache/tools/bin/harbor.exe`，Python 3.12 在 `eval/.cache/tools/python`。
  只在 Windows 上、**沙箱外**跑（它要调 Docker）。
- 数据集：`eval/.cache/datasets/terminal-bench`（Terminal-Bench 4.0，66 道）。重新拉：
  `eval/.cache/tools/bin/harbor.exe download terminal-bench/terminal-bench@4.0.0 -o eval/.cache/datasets`
- Docker Desktop 要开着。

## 三步

```bash
# 1. 打包运行时（代码改了才需要重打，加 --force）
node eval/terminal-bench/bundle.mjs

# 2. 跑一家、一道题（-a 选 agent，-i 选题，-t 单场超时秒数；要比三家就并行起三个进程）
bash eval/terminal-bench/compare.sh -a reman -i embedding-drift-monitor
bash eval/terminal-bench/compare.sh -a cc    -i risk-scorer-replay -t 10800
bash eval/terminal-bench/compare.sh -a dsh   -i mp-checkpoint-consolidation

# 3. 看结果
ls eval/evidence/terminal-bench/<agent>-<月日-时分>/
```

`compare.sh` 自己从本机运行时的数据目录里解出 DeepSeek 的 key（`node eval/decrypt-key.mjs`），不用手动设。

## 每次试次留下什么

```
eval/evidence/terminal-bench/<时间>/<题>__<试次>/
├── agent/agent.log          适配器记的：装好、成员编号、结束原因、token
├── trial.log                Harbor 记的：容器、判分
├── artifacts/reman-data/    运行时的数据目录（时间线、计划、记忆、用量都在里面）
│   └── outcome.txt          结束原因
└── artifacts/runtime.log    运行时自己的输出
```

看某一场的完整过程：

```bash
# 列表：每场的分数、结束原因、用时、token
node eval/terminal-bench/tools/report.mjs

# 手动开一场（复制一份再开，别直接动原始数据）
node src/main.ts --data-dir eval/evidence/terminal-bench/<时间>/<题>__<试次>/artifacts/reman-data --port 6300
```

**别在那个数据目录里继续对话**：里面的工作目录是容器里的路径，工具会在你本机执行。

## 适配器怎么判断「干完了」

不自己拼状态，只问运行时要一个答案：

```
GET /v1/members/<id>/work/wait?quietMs=2000&timeoutMs=60000
→ { settled, busy, status, run, pendingWake, runningTasks, quietMs }
```

运行时知道成员还有没有活：运行在进行（含请求模型、执行工具、**等待审批**）、有会唤醒它的内容还没处理、
有后台任务在跑——任一成立就是 `busy`。`settled` 还要再加上「静默够 `quietMs`」，
挡住「一轮结束→补一条内容→再起一轮」「后台任务结束→唤醒」这些几百毫秒的空档。

- 定时提醒不算工作（到点才唤醒，等它没意义）；
- 长轮询到 `timeoutMs` 返回 `settled: false`，说明**答上来了但还在忙**，接着等；
- 请求失败/超时是**没答上来**，不算忙也不算闲，重试；连续 6 次探 `/v1/state`，活着就继续等，
  探不通才判运行时出错；
- `status` 是 `failed` / `interrupted` / `paused` 时立即结束，不用等静默。

超时（`REMAN_EVAL_TIMEOUT_SEC`）以任务容器杀掉为准，试次记 `timeout`。

## 成员怎么配的

- 只有一个 AI 成员「试次」，工作目录 `/app`；**没有真人成员**。题面由「用户」直接发：
  `POST /v1/members/<aiId>/timeline`，时间线条目 kind 是 `user_input`，不带来源说明；
  不能用 `POST /v1/messages`——那是成员私聊，成员看到的是一条带来源说明的成员消息，行为不同；
- 工具：`shell files terminal view_image read_pdf search_history manage_reminders run_tool_script`
  （容器里没浏览器、没第二个成员，`browser` 和 `manage_group` 不装）；
- 审批全设 `allow`：无人值守，没人点确认；
- 模型写进数据目录的 `models.json`，key 从环境变量 `DEEPSEEK_API_KEY` 来。

## 三个 agent 对跑（同模型、同窗口、同审批放行，比脚手架）

```bash
node eval/terminal-bench/bundle.mjs          # 我们的运行时（产物 reman-bundle.tar.gz）
node eval/terminal-bench/claude-bundle.mjs   # Claude Code 的离线包（产物 claude-bundle.tar.gz）
node eval/terminal-bench/dsh-bundle.mjs      # DeepSeek Harness 的离线包（产物 dsh-bundle.tar.gz）

bash eval/terminal-bench/compare.sh -a reman -i embedding-drift-monitor   # 一次一个 agent、一道题、一个并发
bash eval/terminal-bench/compare.sh -a cc    -i risk-scorer-replay
bash eval/terminal-bench/compare.sh -a dsh   -i mp-checkpoint-consolidation -t 10800
```

- **并发怎么定**：已经跑过的 9 场**一律 1 并发、串行**——早期试过 2、3 并发，docker 下 `exec` 变慢、容器卡住，
  数字不可比。加测那一批，关闭 docker desktop 的省电模式，改成**同一道题的 3 个 agent 同时跑、两道题串行**，靠「容器时钟漂移」判真挂起，
  规则和阈值见 [EXTRA.md](EXTRA.md)。
- 口径写在 `eval/RESULTS.md`：窗口 512K、思考 `high`、审批都不打断、每题每个 agent 一次。

- `eval/reman_agent.py` 是运行时的适配器；`eval/claude_code_npm.py` 是 Claude Code 的适配器，
  只把官方适配器的「安装方式」换成传离线包（官方走 `downloads.claude.ai` 的 bootstrap 脚本，这台机器连不上），
  其余提示词、工具、完成判定、用量解析全部沿用官方实现；`eval/dsh_agent.py` 是 DeepSeek Harness
  （`@deepseek-ai/dsh`）的适配器，跑它的 headless profile，用量从 `--json` 的 NDJSON 累加。
- 思考强度两边都显式设成同一个值（`REMAN_EVAL_REASONING` / `--effort`，默认 `high`），不依赖默认值。
- 上下文窗口由 `CONTEXT_WINDOW` 一个参数控制：运行时写进 `models.json` 的 `contextWindow`，
  Claude Code 走环境变量 `CLAUDE_CODE_MAX_CONTEXT_TOKENS`（它不认识自定义模型 ID 时默认按 200K 算）。
- 容器里的 DNS 被宿主机的 Clash TUN 劫持成假 IP，装依赖、连模型都要走宿主机代理：`compare.sh` 会起
  `eval/.cache/tools/proxy-relay.mjs`（0.0.0.0:7898 → 127.0.0.1:7897）并通过 `--ae` 给容器注入代理。
- 结果进 `eval/evidence/terminal-bench/<agent>-<月日-时分>/`，`node eval/terminal-bench/tools/report.mjs` 按 agent 分列，同题并排给出
  reward、用时、三段用量、花费和缓存命中率。

## 统计口径（踩过坑，别再改回去）

- **输入(累计)**：一场里所有请求的输入 token 加起来，不等于「上下文有这么大」。单次上下文受窗口限制
  （`shadow-relay` 那场 595 次请求，单次中位 98k、最大 166k，累计 23.73M）。
- **去重**：一次模型回复会拆成多条 `assistant` 事件（thinking / text / tool_use 各一条），每条都带同一份
  `usage`。累加必须按 `message.id` 去重，否则会算成两倍多（595 条事件其实只有 254 条回复）。
- **输出**：流式里 `assistant` 事件的 `output_tokens` 是 0，总数只在最后那条 `result` 事件里；
  `result` 事件同时带整场的输入汇总，**不要**和逐条累加相加。
- **自检**：`report.mjs` 累加完会和 `result` 事件的汇总比对，差超过 1% 会打警告——看到警告就说明口径又错了。
- **缓存命中率** = 缓存读 / 全部输入。它只说明单价，不说明量；成本看累计输入。
- **压缩阈值**：我们的运行时是 `contextWindow × 0.7`（`src/runs/runs.ts` 的 `OPTIMIZE_RATIO`；`optimizer.ts` 里的
  `REQUEST_RATIO = 0.8` 是「压缩请求本身最多带多少」，不是触发点）；Claude Code 在 200K 档实测 169k–172k 触发（约 85%）。
  两边窗口必须显式设成同一个值。
- **基础设施失败不算模型失败**：断网、判分容器没起来（`0xC0000142`）这类场次不进平均，
  用 `python eval/programbench/run.py --finish <运行目录>` 补收尾，或用 `docker cp` 抢救产物。

## 选题

候选池是 25 道（见 `eval/TASKS.md`：90 分钟内能跑完、不需要 GPU、Opus 5 做对过）。
从里面先取 **Opus 5 + Claude Code 5 次全部做对**的。5/5 只能说明**这道题对 Opus 5 来说不难**，
选它们是因为有稳定的上限参照：连强模型都能稳定做对的题，判分链路和镜像环境不会成为变量，
真跑不好就说明模型或 agent 的能力不足。候选池里这样的题一共 **8 道**：

| 题目 | 领域 / 类型 | 考察什么 | 专家 | Opus+CC 用时 | Opus 通过 | 本次 |
|---|---|---|---|---|---|---|
| `embedding-drift-monitor` | ML/Inference（编程：修实现） | 修 embedding 漂移监控（KS/PSI/MMD、去抖） | 5h | 41m | 5/5 | **选** |
| `risk-scorer-replay` | ML/Evaluation（编程：数据对账） | 风控评分离线一致性报告，和线上逐格对齐 | 4h | 36m | 5/5 | **选** |
| `mp-checkpoint-consolidation` | ML/Inference（编程：二进制格式） | 合并 Megatron MoE checkpoint | 6h | 51m | 5/5 | **选** |
| `vpp-loss-divergence` | ML/Training（编程：调训练） | 修分布式训练 loss 轨迹偏离 | 2h | 40m | 5/5 | 加测候选：要起多卡训练环境，环境风险高 |
| `coq-block-bound` | Science/Math（逻辑：形式化证明） | 在 Coq 里证明一个组合数学定理 | 16h | 46m | 5/5 | 加测候选：最考验逻辑，早前因断网失败过，要先确认代理 |
| `layout-config-recreation2` | Media/Design（编程：前端布局） | 从设计稿反推页面布局 | 2h | 68m | 5/5 | 加测候选：单场偏长 |
| `hof-topology-interpenetration` | Science/Chemistry（领域分析） | 晶体 CIF 的拓扑与互穿程度分析 | 8h | 46m | 5/5 | 不选：偏领域科学计算，离「编程/逻辑」远 |
| `sound-change-cascade` | Science/Linguistics（逻辑推理） | 反推语言音变的规则序列 | 4h | 55m | 5/5 | 不选：逻辑强但没有代码产物，判分偏结果 |

另有 4 道 5/5 在候选池之外（`cad-model`、`freecad-platform-drawing`、`freecad-spring-clip`、
`satb-audio-transcription`）：镜像 5 GB 级、要 GUI/CAD/音频工具链，属于「重环境」，
不代表通用 agent 能力，不选。

**本轮选前 3 道**（表里标「选」的）。理由：

- 都是「读代码 → 算数据 → 写产物」的编程题，逻辑链条长，但不需要 GPU、不需要多卡、不依赖 GUI；
- 三道覆盖三种形态：**改算法实现**（embedding）、**做数据对账**（risk）、**处理二进制格式**（mp-checkpoint），
  不会只测到同一类能力；
- 单场 36–51 分钟（Opus+CC 基线），三家各跑一次约 3 小时，串行一天能跑完。

下次扩样本，按加测候选的顺序加：先 `coq-block-bound`（补一个「纯逻辑」维度），再 `layout-config-recreation2`。

## 记录口径

- 补判分脚本是 `eval/terminal-bench/rescore.sh`；分析脚本都在 `eval/terminal-bench/tools/`：`report.mjs`（逐题并排）、`compactions.mjs`（压缩次数）、`agent-totals.mjs`（按 agent 汇总）、`verify-benchmarks.mjs`（核对 BENCHMARKS.md）、`verify-usage.mjs`（从证据重算合计用量，和 BENCHMARKS.md 对）；打证据包用 `eval/pack-evidence.mjs`（见 `eval/EVIDENCE.md`）、`ourtiming.mjs`（运行时内部 span，`report.mjs` 用）。

- 一次试次一个 job 目录，名字带 agent 与时间：`eval/evidence/terminal-bench/<agent>-<月日-时分>`。
- 判分起不来的，用还在跑的 agent 容器手工补判分：`./eval/terminal-bench/rescore.sh <试次目录>`（照 `task.toml` 的 collect 命令生成 patch 再跑题目自带的 tests）；补过的在备注里写明。
- 同一道题三家必须用同一个上下文窗口、同一档思考强度、同样的审批放行方式，缺一项就算不同口径，不进这张表。
- 只用 reward 判断做没做出来。reward 相同不代表过程相同：失败的原因、用了几分力，都记在备注里。
- 命中率最多两位小数（`98.21%`、`100%`），整数不带小数点；`report.mjs` 里就是按这个格式出的。
- **压缩次数**用 `node eval/terminal-bench/tools/compactions.mjs` 数，三家同一口径：上下文长度比上一条少 40% 以上、且少 5 万 token
  算一次（reman 读 `model_requests.input_tokens`，cc / dsh 从会话记录或事件流推断）。**不要数时间线里 `kind='summary'` 的条目**——
  那是运行时把旧内容滚动摘要的记忆条目，跟窗口压缩无关（2026-11-13 踩过：把 0 次和 1 次误算成 37 次、14 次）。
  同时给出**最大上下文**，能看出离压缩点还有多远。
- **dsh 在 20 万 token 就压缩的原因**（2026-11-12 查清，不是窗口没生效）：512K 确实生效了
  （否则阈值会是 727k），但 dsh 的 deepseek 适配器默认每次给输出预留 256k token
  （`DEFAULT_MAX_TOKENS = 256e3`），压缩插件再留 64k 头部空间，两者一减：
  524288 − 256000 − 65536 = **202,752**，这才是它真正的消息预算；实测第一次压缩就发生在 202,869。
  reman 的口径不同：估算超过窗口的 **0.7**（512K 窗口下约 367k）才压缩。两边压缩时机不一样，本轮按「各家压缩时机不同不用管」处理。

## 本次测试过程中犯过的失误（汇总）

按发生顺序，只记事实和后果，现在的做法写在该条后面。

1. **容器权限反复失败**：reman 的 risk-scorer-replay 那场 15 秒就 failed，因为 /app 只有 root 能写、运行时以别的用户跑。
   同类问题此前已出现过几次。现在统一走 access.py 的 relax_command + probe_command：开跑前用**实际跑 agent 的用户**试写探针文件，
   写不进去直接报错，不用等跑到一半才失败。
2. **适配器日志目录写错**：日志写到 agent/agent/，Harbor 取日志报 FileNotFoundError。改为写 agent/ 下。
3. **dsh 用量口径算错**：把缓存命中当成未命中，第一场 embedding 数据作废重跑。现在 n_input_tokens = input + cacheRead + cacheWrite。
4. **早期并发不统一**：试次跑过 2 并发、3 并发（各家 config.json 里 n_concurrent_trials 不一样），docker 下变量不一致、
   结果不可比。跑过的那 9 场一律 1 并发串行；加测那批改成同题 3 家并行，并加时钟漂移判挂起（见 [EXTRA.md](EXTRA.md)）。
5. **后台任务结果裁剪多写了一层**：加了 clipForTask，实际是死代码（工具结果已经裁过一次）。已回滚，只留一条测试和一句说明。
6. **离线包首次缺 yaml**：node_modules 没重装，包里少了 yaml，运行时才报模块找不到。现在按 package-lock.json 的
   sha256 与 node_modules/.lock-hash 比对，依赖变了必须重装。
7. **装 dsh 污染仓库**：在仓库根目录 npm install，把 @deepseek-ai/dsh 写进了 package.json 和 package-lock.json，事后清理。
   改为 npm install --prefix eval/.cache/build/dsh。
8. **文档把 reman 的压缩点写错**：写成窗口的 0.8，实际是 0.7（512K 窗口下是 367k 不是 419k）。已改。
9. **.gitignore 没跟上目录重构**：旧规则只写 eval/jobs 等，移动后匹配不到，几千个数据文件被 git 追踪。已补规则。
10. **题面当成了成员私聊发**：`container/probe.mjs` 早期建一个叫「用户」的真人成员，再用 `POST /v1/messages`
    以它的身份私聊发题面。成员看到的是「来源说明：来自成员 用户」的私聊；「用户直接对你说的话」是另一条通路
    （时间线 kind 是 `user_input`，不带来源说明），两者行为不同，还白占了一个成员名。
    现在：只建 AI 成员，题面走 `POST /v1/members/<aiId>/timeline`。
10. **重构后脚本路径没改全**：一度还在用旧路径，跑批用错目录。现在脚本统一用 eval/terminal-bench/ 前缀，过渡期加了转发脚本。
11. **失败原因分析误判**：先以为失败场次改用了 terminal 工具，扫过 timeline 后确认全部用 shell，真正差异是写法
    （写文件少、shell 调用多）。结论改了。
12. **reman 的 risk 场首次启动就失败**：`/app` 只有 root 可写、运行时以别的用户跑，15 秒就 failed。那一场没跑起来、没有结果，不算一次试次；修好权限后重新跑了一场，RESULTS.md 表里用的是那一场。

加测（shadow-relay + react-lead-form，3 家并行、压缩点统一到 350K）的方案见 [EXTRA.md](EXTRA.md)。

## 现在还不能跑的

- **要 GPU 的题**（3 道：`jax-speedrun-gpu`、`fp8-rmsnorm-gemm`、`math-eval-grader`）：本机没 GPU。

MCP 和多容器都已经跑通（`medical-claims-processing` 是 11 道多容器题里唯一带 MCP 的，
适配器把任务给的 `http://…/sse` 改写成 `/mcp` 写进 `mcp.json`）。哪些题适合跑、为什么剔除，见 [TASKS.md](TASKS.md)。
