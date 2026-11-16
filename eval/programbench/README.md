# ProgramBench：从零重建程序

只给一个**编译好的二进制和它的文档**（源码已删），让 agent 从零写出一个行为一致的实现。
题目来自 [facebookresearch/ProgramBench](https://github.com/facebookresearch/programbench)（Meta FAIR +
Stanford + Harvard），198 道题，判分用 fuzz 出来的行为测试。

## 和 Terminal-Bench 的区别

| | Terminal-Bench 4.0 | ProgramBench |
|---|---|---|
| 任务形态 | 修 bug、做功能、写脚本，单场 20–60 分钟 | 重建整个程序，榜单里能解出的题也要 110–250 次模型调用 |
| 提交物 | 容器里的最终状态（判分脚本自己去看） | 代码库 `submission.tar.gz`，根目录要有 `compile.sh` |
| 判分 | 题自带的 pytest 套件 → reward 0/1 | `programbench eval` 编译提交物、跑行为测试 → % Resolved / % Tests Passed |
| 运行环境 | 我们自己的 Harbor + 离线包 | 官方 Docker 镜像 `programbench/<owner>_1776_<repo>.<sha>:task_cleanroom_v6` |
| 联网 | 容器走宿主机代理，可连模型和下载 | **agent 期只放行模型 API**；判分期可能要装 pytest，走宿主机代理访问 pypi（`jplot` 的镜像已预装 pytest 9.0.3 与 Go 1.21，那次判分没用到外网） |

**这套口径的另一个用途**：ProgramBench 的任务本身就是长程的（几小时、几百步），把压缩触发点压到 20 万
token 之后，压缩必然触发多次，一次跑同时量「新基准」和「多轮压缩下的长程表现」。
具体设置见 [RESULTS.md](RESULTS.md)。

## 怎么跑

```bash
# 1. 起一道题（本地已有镜像就不联网拉；没有才 pull，首次 1.5–2 GB）
python eval/programbench/run.py --task rs__jplot.2a54bcc --agent reman

# 只看要执行什么，不动容器
python eval/programbench/run.py --task rs__jplot.2a54bcc --agent reman --dry-run

# 2. 判分（要本机有 programbench CLI：pip install programbench）
python eval/programbench/eval.py eval/evidence/programbench/<月日-时分>-<agent>-<题>

# 3. 汇总
python eval/programbench/eval.py --all
```

三家并行就是三条命令各开一个终端（容器名按 agent 区分，互不冲突）。

**跑完了但没收尾**（agent 已收工，包装器半路崩了或终端掉了）：

```bash
python eval/programbench/run.py --finish eval/evidence/programbench/<场次目录>
```

只做 bootstrap 之后那几步——按 `agent.log` 重算用量、抽 `submission.tar.gz`、写 `run.json`（带
`finished_late: true`）、停容器；agent 的过程不动，不是重跑。目前只支持 cc / dsh（reman 的用量在运行时数据库里）。

**单场时长上限 2 小时**（`--timeout` 默认 7200）：cc 与 dsh 在容器里套一层 `timeout -s TERM 7200`，到点发 TERM；
reman 的等待循环到点就 `outcome=timeout` 并停成员，然后照常收尾。早年那批是 3 小时，jplot 之后改成 2 小时
（实测 jplot 最长一家只用了 95 分钟，不影响那批结果）。

`run.py` 干的事：建内网 `pb-net` → 起白名单代理 `pb-proxy` → 镜像在本地就跳过 pull → 起任务容器
（`--cpus 4 --memory 8g`）→ 装 agent → 发题 → 等 agent 收工 → 收 `/workspace` 打成 `submission.tar.gz`。
出网只有一条路，见下面的网络隔离。

**题面规则**：题面逐字节取自 `prompts/<题>.md`（官方 `instruction.md` 原文），`run.py` 只做
`read_bytes()` / `write_bytes()`，不改换行、不加任何中文说明、不加任何额外提示。上一批 PB 就是因为
把题面翻译成中文、还自己压缩了 `<RULES>`，整批结果作废——**基准测试的题面必须原样**。

## 网络隔离

```
docker network create --internal pb-net     # 没有默认网关，容器出不去
pb-proxy：同时接 pb-net 和默认 bridge，跑 proxy.mjs，只放行 api.deepseek.com
任务容器：只接 pb-net，HTTP(S)_PROXY 指向 pb-proxy
```

断网验证过：`curl https://example.com` 连不上，`curl https://api.deepseek.com` 通。

判分是另一套：**要联网**。题目自带的 `eval/run.sh` 第一步就是
`pip install pytest pytest-xdist pytest-timeout`，官方 harness 还会装 `pytest-rerunfailures`，
所以要给评测容器宿主机的代理——`PROGRAMBENCH_CONTAINER_PROXY=http://host.docker.internal:7898`
（先起 `node eval/.cache/tools/proxy-relay.mjs`），而且代理要能到 `pypi.org`、`files.pythonhosted.org`。

## 判分前先打补丁

```bash
python eval/programbench/patch_programbench.py          # 幂等；重装 programbench 后要再跑一次
```

修三处：还开着的临时文件交给 `docker cp`（Windows 上必炸）、`mkstemp` 的 fd 没关
（收 results.xml 时 `WinError 32`）、评测容器没代理。

## 证据与可追溯性

两条硬规矩：**证据目录挂到宿主**（不靠收尾 `docker cp`；`-v <运行目录>/reman-data:/opt/reman/data`，
dsh 是 `dsh-sessions`、cc 是 `cc-projects`）、**跑完只 `docker stop` 不删**（容器本身也是一层现场，
清理要显式 `--prune`，且删除必须经用户同意）。这两条来自 2026-11-12 reman 第一场把容器删早了、
运行时的数据库永久丢失那次。

**这条链现在必须是完整的，缺一环这场就不算数**：

```
prompt.txt（题面）
   → agent.log（cc 的会话记录 / dsh 的 NDJSON 事件流）
   → reman-data/runtime.sqlite（每一步请求与工具调用、压缩记录）
   → submission.tar.gz（agent 交出的代码）
   → <实例 id>.eval.json（判分原始结果，每条用例的状态）
   → run.json（用时、三段用量、窗口、输出上限、汇总）
```

### 每场必须留下什么

一场跑完，运行目录里必须有下面这些，缺一条这条数据就不算数：

| 文件 | 内容 | 谁写的 |
|---|---|---|
| `prompt.txt` | 发给 agent 的完整题面 | `run.py` |
| `agent.log` | agent 的完整过程：cc 是会话记录（每轮思考 + 工具调用 + 结果），dsh 是 NDJSON 事件流 | `run.py` |
| `reman-data/` | reman 运行时的数据库（`runtime.sqlite`：时间线、每次请求的上下文与用量、压缩记录） | 运行时 |
| `dsh-sessions/` | dsh 自己的会话文件（`session.v4.jsonl.zstd`） | dsh |
| `runtime.log` | reman 运行时的日志 | 运行时 |
| `<实例 id>/submission.tar.gz` | agent 交出的代码库，判分用的就是它 | agent |
| `<实例 id>/<实例 id>.eval.json` | 判分的原始结果（每个用例的状态） | `programbench` CLI |
| `run.json` | 用时、用量、窗口、输出上限、判分汇总 | `run.py` + `eval.py` |

数据可信靠三样东西合起来：`agent.log`（过程，可逐步核对）、`submission.tar.gz`（产物，可重新判分）、
`*.eval.json`（判分结果，每条用例都有名字和状态）。

## 记录口径

- 一次运行一个目录：`eval/evidence/programbench/<月日-时分>-<agent>-<题>/`，元数据在 `run.json`。
- 判分：`python eval/programbench/eval.py <目录>`，结果写回 `run.json` 的 `eval` 字段；判分失败的场次注明原因。
- 通过率按 `eval.json` 里**全部**用例算（通过 / 总数）。上游 CLI 打印汇总时会剔掉题目元数据里标了 `ignored` 的分支与用例（`go-critic` 剔 432 条、剩 493 条；`typst` 剔 65 条、剩 1,724 条），所以 CLI 上的分数会高一点（例如 `1115-0230`：全部 902 条 59.65%，过滤后 493 条 61.05%）。文档里一律用「全部用例」这一套，历次数字互相可比；引用 CLI 输出时要注明是哪一套。
- 花费：`eval/pricing.json` 的三段价，按 `run.json` 里的 `usage` 算。
- 压缩次数和最大上下文：`node eval/programbench/usage.mjs`。三家统一口径：**上下文比上一条少 40% 以上、且少 5 万 token**
  算一次压缩（reman 读 `model_requests.input_tokens`，cc 读会话记录，dsh 读事件流的 `step_end`）；reman 的压缩还会伴随
  `kind='optimization'` 的独立模型请求，可用来互证。**不要数时间线里 `kind='summary'` 的条目**——那是运行时把旧内容滚动摘要的记忆条目
  （带 keywords / anchorItemId），跟窗口压缩无关，数它会得出 37 这种虚高值。
- 三家必须用同一档思考强度、同一个输出上限、同一个压缩触发点，缺一项就算不同口径，不进这张表。
- 题面怎么送到 reman 手里：**用户直接发**——`POST /v1/members/<aiId>/timeline`，时间线条目 kind 是
  `user_input`，对成员呈现为「没有来源说明的用户原话」；不用成员私聊（`POST /v1/messages`），也不建真人成员。
  cc 与 dsh 的题面是各自脚手架的一条 user 消息，三者对各自的呈现都是「用户说的」。


### 用时怎么算的

三家同一口径，都是 **agent 自己干活的那一段**，不含装脚手架、建成员、判分准备、等审批的时间。
现在的取数方式统一了：`run.py` 从**题面发出**计到**agent 收工**，把秒数写进 `run.json` 的
`elapsed_seconds`，三家都用这一个值（jplot 那批就是按它报的：reman 2285 秒、cc 5724 秒、dsh 2428 秒）。

早期那批（已归档）的用时是各家自己算的（cc 看会话首末时间戳、reman 看数据库 `runs` 表并扣审批等待、dsh 用跑批全程减装脚手架耗时），
口径与现在不同，所以不跟现在这批比。那时的取数与扣减细节随数据一起留在 `eval/.local/stash/`。

## 本次测试过程中犯过的失误（汇总）

只留现在仍然适用的，按发生顺序；已经写进代码、不会再犯的平台坑在最后一句话里汇总。

1. **删容器删早了**：reman 第一次跑完，`run.py` 直接 `docker rm`，而当时 `collect()` 只拷了 submission、
   没拷数据目录，`runtime.sqlite` 永久丢失。现在：证据目录挂载到宿主，跑完只 `docker stop` 不删。
2. **题面被我自己改写**：早期 PB 的题面是我把官方英文翻成中文、还压掉了 `<RULES>`，整批结果作废。
   现在：题面逐字节复制 `prompts/<题>.md`（官方 `instruction.md`），`run.py` 里不准再出现手写题面。
3. **失败或空跑留下空运行目录**：`run.py` 先建运行目录、写 `prompt.txt`，再去处理镜像；镜像拉不到就抛错，
   留下只有 `prompt.txt` 的空目录（2026-11-14 就留下过 3 个）。现在：镜像在本地就跳过 pull；真失败了要顺手清掉空目录。
4. **判分脚本的路径被切了两遍**：`eval.py` 先 `os.chdir(HERE)` 再 `Path(arg).resolve()`，相对路径被拼成
   `eval/programbench/eval/evidence/programbench/…`，报「没有 submission.tar.gz」。现在：先 resolve 再 chdir。
5. **报数把用例状态搞错**：`eval.json` 里失败的状态值叫 `failure`（不是 `failed`），我没核对就当成跳过，
   把 50 条失败报成「0 失败」。现在：报数一律按 `test_results` 的 `status` 分组，并核对
   `passed + failure + skipped` 等于用例总数。
6. **关终端把正式运行杀了（同一个错误犯了两次）**：两次都是为腾终端名额关掉了承载 `run.py` 的终端，
   监督进程被杀、收尾中断（数据没丢，靠的是挂载）。现在的规则：**跑正式场期间只关已确认空闲的终端**，
   关之前核对终端里跑的是什么。
7. **改代码后没跑一遍就上正式场**：给 `collect()` 加「已挂载的目录不再拷」时用了不存在的变量，
   跑完在收尾时抛 `NameError`：submission 已拷出、`run.json` 没写、判分没跑，只能手工补。
   改动后先跑一次 dry-run 或小样本，把整条收尾路径跑通再上正式数据。
8. **题面当成了成员私聊发**：`probe.mjs` 早期建一个叫「用户」的真人成员、用 `POST /v1/messages`
   以它的身份私聊发题面。成员看到的是「来源说明：来自成员 用户」的私聊，与「用户直接对你说的话」
   在运行时里是两条通路（时间线 kind 分别是 `message` 与 `user_input`），行为不同，还白占了一个成员名。
   现在：只建 AI 成员，题面走 `POST /v1/members/<aiId>/timeline`。
8. **解析 cc 输出时崩在收尾环节**：`typst` 那场 agent 39 分钟正常收工，包装器解析用量时把
   `event["message"]` 当成对象调 `.get()`，而它实际是字符串 → `AttributeError`，结果没写
   `run.json`、没抽 submission、容器也没停（表现为 CPU 0% 但容器还在）。现在：cc/dsh 的解析都
   先判 `isinstance(..., dict)`，并且新增 `run.py --finish <场次>` 用现成证据补收尾。

9. **判分前没确认宿主代理还在**（2026-11-15，`typst` 复测第一回判出 0 分）：判分容器装
   `pytest-rerunfailures` 要走宿主机 7898 的转发（`PROGRAMBENCH_CONTAINER_PROXY=http://host.docker.internal:7898`），
   跑判分时那个进程已经不在了（`netstat` 查不到 7898，转发脚本 `eval/.cache/tools/proxy-relay.mjs` 大概是随运行时重启
   一起退出的）。结果 10 个测试分支全部 `results_read_failed`、总分 0，看上去像模型崩了，实际是装依赖失败。
   现在：**判分前先 `netstat -ano | grep :7898` 确认转发在听，起不来就 `node eval/.cache/tools/proxy-relay.mjs`**；
   判出 0 分时先看 `typst__*.eval.json` 里 `install_rerunfailures` 那一步的 `returncode`，别直接当成模型结果。

10. **排查用的容器起来忘了停**（2026-11-15，`typst` 复测判分失败后排查）：为了确认 submission 能不能编译，
    我对已经停掉的 `pb-reman-typst-typst` 执行了 `docker start` 跑 `compile.sh`，查完只接着判分，忘了停回去，
    它空转了一阵，用户先发现的。现在：为了排查而启动的容器，查完当场 `docker stop`，并在收尾时用
    `docker ps` 核一遍「在跑的应该只有当前那一场和 pb-proxy」。

早期批次另踩过一批平台坑：dsh 的 `--patch` 顶层必须是数组、
把 `--dump-config` 当子命令用、离线包过期与权限、`docker cp` 顺序、reman 不认 `HTTPS_PROXY`、
cc 不能以 root 跑、cc 必须显式 `--model`、白名单代理被客户端 reset 打崩、判分链四处 Windows/网络补丁、
`MSYS_NO_PATHCONV`、`models.json` 多写一份明文 key。这些都已在代码里修好，不再逐条记。

共同根源：先把东西跑起来、再回头补验证；删除、清理这类不可逆动作没有先确认。
现在固定顺序：先验证链路（dry-run + 小样本冒烟）→ 再跑正式场 → 证据先落盘并自检 → 报给用户 → 用户点头才清理。

## 目录

```
eval/programbench/
├── README.md     本文件（怎么跑、证据、记录口径、失误汇总）
├── TASKS.md      选题与依据（榜单分层 + 选中的三道）
├── RESULTS.md    要比什么、统一设置、局限、结果、观察
├── prompts/      官方题面原文（`<题>.md`，逐字节复制，不许手写）
├── run.py        单场编排（起容器、装 agent、发题、收代码库）
├── eval.py       调 programbench CLI 判分、汇总成表
├── patch_programbench.py  给官方 CLI 打四处 Windows/网络补丁（幂等）
├── usage.mjs     每场的用量、最大上下文、压缩次数
├── proxy.mjs     白名单代理（只放行模型 API）
└── results.json  逐场结果与按 agent 汇总（collect-results.mjs 生成）
```

