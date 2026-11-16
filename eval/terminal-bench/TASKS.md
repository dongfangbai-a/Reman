# Terminal-Bench 4.0 的 66 道题

用来挑子集的清单。数据来源：`eval/datasets/terminal-bench` 里每道题的 `task.toml`（分类、专家时间、
GPU、容器数量、MCP）和题面；「CC 用时 / CC 通过」来自 Opus 5 + Claude Code 的公开结果（5 次里通过几次）。

- **专家**：题目给的人类专家完成时间估计，用来判断这题本身多大。
- **CC 用时**：Opus 5 + Claude Code 平均跑多久（不是上限，是平均值）。
- **CC 通过**：5 次里通过几次。`5/5` 说明稳定能做出来，`0/5` 说明没人做出来过。

## 一、全部 66 道

「处理」一列：`留下` 是进入候选池；其余是剔除原因。

| 题目 | 分类 | 考察什么 | 专家 | CC 用时 | CC 通过 | 处理 |
|---|---|---|---|---|---|---|
| `atrx-vep-crispr` | Science/Biology | 用 VEP、InterPro 注释基因组变异并判致病性 | 7h | 24m | 2/5 | 留下 |
| `batched-eval-parity` | ML/Evaluation | 修批量评测代码，让批处理和单条推理语义一致 | 24h | 45m | 1/5 | 留下 |
| `biped-contact-dynamics` | Science/Robotics | 用 PyDrake 生成双足机器人走路/跳/跑的轨迹 | 5h | 158m | 1/5 | 太慢 |
| `bun-sourcemap-leak` | Software/Systems | 修 Bun 发布流水线里泄露源码映射的问题 | 1.5h | 32m | 0/5 | 0/5 |
| `cad-model` | Hardware/CAD | 只看 2D 工程图，输出对应的 STEP 三维模型 | 2h | 34m | 5/5 | 重环境（可选） |
| `cargo-flight-dispatch` | Operations/Logistics | 修航空货运的配载、油量、侧风限制计算 | 2.5h | 27m | 0/5 | 0/5 |
| `coq-block-bound` | Science/Math | 在 Coq 里证明一个组合数学定理 | 16h | 46m | 5/5 | 留下 |
| `ctr-optimization` | Operations/Marketing | 48 小时模拟广告投放优化（多容器） | 4.8h | 292m | 1/5 | 太慢 |
| `cumulative-layout-shift` | Software/Frontend | 消除 Next.js 站点的布局抖动（多容器） | 6h | 162m | 5/5 | 太慢 |
| `data-anonymization` | Software/Data | 按策略文件写 CSV 匿名化 CLI | 24h | 88m | 0/5 | 0/5 |
| `distributed-dedup` | Software/Systems | Spark 上的近重复文档去重（MinHash+LSH） | 10h | 270m | 4/5 | 太慢 |
| `embedding-drift-monitor` | ML/Inference | 修 embedding 漂移监控（KS/PSI/MMD、去抖） | 5h | 41m | 5/5 | 留下（已跑通 1.0） |
| `fin-saccr-rwa` | Operations/Finance | 按 CRR3 重算 SA-CCR 交易对手风险 | 8h | 20m | 3/5 | 留下 |
| `foodstuff-beta-activity` | Science/Chemistry | 从液闪计数数据推算 β 放射性活度 | 1.5h | 17m | 0/5 | 0/5 |
| `formal-crypto` | Security/Cryptography | 写 Sage 脚本重构密文（密码分析） | 3h | 84m | 2/5 | 留下 |
| `fp8-rmsnorm-gemm` | ML/Kernels | 给 H100 写 fused RMSNorm+FP8 GEMM kernel | 12h | 130m | 5/5 | GPU |
| `freecad-impeller` | Hardware/CAD | FreeCAD 脚本参数化建叶轮，出两个 FCStd | 2h | 39m | 0/5 | 0/5 |
| `freecad-platform-drawing` | Hardware/CAD | 从工程图用 FreeCAD 脚本建零件 | 1.5h | 27m | 5/5 | 重环境（可选） |
| `freecad-spring-clip` | Hardware/CAD | FreeCAD 参数化建弹簧卡 | 2h | 44m | 5/5 | 重环境（可选） |
| `freight-dispatch-shift` | Operations/Logistics | 有状态的调度 CLI（司机工时、危险品）（多容器） | 4h | 68m | 0/5 | 0/5 |
| `glycan-ms2-elucidation` | Science/Chemistry | 从 LC-MS/MS 数据推断糖链结构 | 5h | 33m | 0/5 | 0/5 |
| `gsea-proteomics` | Science/Biology | 蛋白组差异表达与 GSEA 分析 | 4h | 21m | 4/5 | 留下 |
| `heat-pump-warranty` | Operations/Claims | 热泵保修理赔判定（多容器） | 4h | 22m | 2/5 | 留下 |
| `hof-topology-interpenetration` | Science/Chemistry | 晶体 CIF 的拓扑与互穿程度分析 | 8h | 46m | 5/5 | 留下 |
| `html-js-filter` | Security/AppSec | 写 XSS 过滤器（净化 HTML） | 0.75h | 72m | 4/5 | 留下 |
| `interleaved-vigenere` | Security/Cryptography | 破解交织维吉尼亚密文 | 2h | 109m | 5/5 | 太慢 |
| `intrastat-meldung` | Operations/Compliance | 走完整 Intrastat 月结申报（多容器） | 3h | 17m | 1/5 | 留下 |
| `jax-speedrun-gpu` | ML/Training | JAX 从零训练 100M–1B 语言模型 | 10h | 322m | 1/5 | GPU |
| `ks-solver-cpp` | Science/Physics | 圆盘上数值解 Kuramoto-Sivashinsky 方程 | 10h | 95m | 3/5 | 太慢 |
| `kv-live-surgery` | Software/Systems | 用 ptrace 热修 KV 服务，提速 5 倍（多容器） | 4h | 72m | 4/5 | 留下 |
| `lake-temp-glm` | Science/Earth | 训练湖泊水温剖面预测模型 | 8h | 231m | 2/5 | 太慢 |
| `layout-config-recreation` | Media/Design | 从海报截图反推可编辑布局 | 2h | 229m | 0/5 | 0/5 且太慢 |
| `layout-config-recreation2` | Media/Design | 反推设计稿布局，写 config.json | 2h | 68m | 5/5 | 留下 |
| `legacy-utility-triage` | Operations/Claims | 用旧版 GUI（VNC）处理电费异常单（多容器） | 3.5h | 48m | 4/5 | 留下 |
| `live-database-cutover` | Software/Databases | MySQL→PostgreSQL 零停机迁移（多容器） | 8h | 98m | 2/5 | 太慢 |
| `math-eval-grader` | ML/Evaluation | 造数学评测的 grader（含 PDF 答案） | 6h | 38m | 3/5 | GPU |
| `medical-claims-processing` | Operations/Claims | GOÄ 医疗账单审核（多容器 + MCP 浏览器） | 2h | 29m | 0/5 | 0/5 |
| `mp-checkpoint-consolidation` | ML/Inference | 合并 Megatron MoE 的分片 checkpoint | 6h | 51m | 5/5 | 留下 |
| `music-harmony` | Media/Music | 巴赫风格四声部和声，标罗马数字 | 1h | 82m | 0/5 | 0/5 |
| `mvcc-lsm-compaction` | Software/Databases | 修 MVCC LSM 引擎的可见性 bug | 4h | 24m | 3/5 | 留下 |
| `nextjs-performance` | Software/Frontend | 优化 Next.js 仓储应用性能（多容器） | 3h | 53m | 0/5 | 0/5 |
| `ontology-kg-querying` | Software/Data | OWL/RDF/SPARQL 知识图谱整合 | 20h | 31m | 0/5 | 0/5 |
| `payments-pipeline-fix` | Software/Systems | Kafka 支付管线的冷启动与状态修复（多容器） | 2h | 188m | 5/5 | 太慢 |
| `photonic-waveguide-routing` | Software/Algorithms | 光子波导布线（几何约束 + 优化） | 0.75h | 56m | 0/5 | 0/5 |
| `pretrain-shard-corruption` | ML/Training | 查训练分片损坏导致 loss 偏高 | 2h | 134m | 4/5 | 太慢 |
| `production-planning` | Operations/Supply chain | 用 ERP/MES/WMS 数据出 5 天生产计划 | 4h | 36m | 3/5 | 留下 |
| `protein-autointerp-disulfide` | Science/Biology | 从序列推断蛋白的二硫键特征 | 2h | 20m | 0/5 | 0/5 |
| `react-lead-form` | Software/Frontend | 修 React 表单、校验、时间戳、CRM 导出 | 5h | 37m | 2/5 | 留下 |
| `retro-console-soc` | Hardware/RTL | 用可综合 Verilog 写 8 位主机 SoC | 10h | 111m | 5/5 | 太慢 |
| `risk-scorer-replay` | ML/Evaluation | 重建风控评分的离线一致性报告 | 4h | 36m | 5/5 | 留下 |
| `roy-polymorph-cn` | Science/Chemistry | ROY 多晶型的光谱-构象建模 | 3h | 13m | 1/5 | 留下（已跑三次 0 分） |
| `rs-archive-clone` | Software/Algorithms | 黑盒复刻 Reed-Solomon 归档工具 | 16h | 137m | 4/5 | 太慢 |
| `satb-audio-transcription` | Media/Music | 音频转 MusicXML 四声部 | 8h | 52m | 5/5 | 重环境（可选） |
| `sglang-qwen-burst` | ML/Inference | 修投机解码造成的流式输出差异 | 2h | 95m | 0/5 | 0/5 |
| `session-window-debug` | Software/Systems | 修会话窗口与水位线处理 | 8h | 22m | 0/5 | 0/5 |
| `shadow-relay` | Security/Forensics | 网络取证 + 逆向自定义协议 | 3h | 12m | 3/5 | 留下 |
| `sound-change-cascade` | Science/Linguistics | 反推语言音变的规则序列 | 4h | 55m | 5/5 | 留下 |
| `takens-embedding-lean` | Science/Math | 在 Lean 4 里证明 Takens 嵌入定理 | 60h | 67m | 0/5 | 0/5 |
| `telecom-entity-resolution` | Software/Data | 四套账单系统的实体对齐 | 16h | 122m | 5/5 | 太慢 |
| `uefi-bootkit` | Security/Forensics | 拆 UEFI bootkit（QEMU 虚拟机） | 2h | 73m | 4/5 | 留下 |
| `vba-userform-port` | Software/Frontend | 把 Excel/VBA 应用迁成 Web 应用 | 4h | 64m | 3/5 | 留下 |
| `vf2-speedup-networkx` | Software/Algorithms | 写 VF2++ 的 faster networkx | 4h | 130m | 4/5 | 太慢 |
| `vllm-deepseek-streaming` | ML/Inference | 修 vLLM 流式输出损坏 | 2h | 96m | 0/5 | 0/5 |
| `vpp-loss-divergence` | ML/Training | 修分布式训练 loss 轨迹偏离 | 2h | 40m | 5/5 | 留下 |
| `wal-recovery-ordering` | Software/Databases | 修 WAL 恢复顺序 | 6h | 20m | 0/5 | 0/5 |
| `wdm-design` | Science/Physics | 硅光 WDM 逆向设计（meep FDTD） | 4h | 261m | 5/5 | 太慢 |

## 二、剔除规则

| 规则 | 数量 | 说明 |
|---|---|---|
| GPU | 3 | `jax-speedrun-gpu`、`fp8-rmsnorm-gemm`、`math-eval-grader`。本机没有 GPU。 |
| CC 平均超过 90 分钟 | 20 | 一轮跑十几道不现实；`ctr-optimization` 4h52m、`distributed-dedup` 4h30m、`wdm-design` 4h21m 都是这一档。 |
| 0/5（谁都没做出来） | 19 | 没有区分度：我们大概率也做不出来，测不出脚手架好坏。另外这类题本身可能有环境或判分问题（`bun-sourcemap-leak`、`ontology-kg-querying`、`wal-recovery-ordering` 都在内）。 |
| 重环境（可选，不建议） | 4 | 3 道 FreeCAD 和 1 道音频题：镜像 5 GB 级、要 GUI/CAD/音频工具链。能力特殊，不能代表通用 agent 能力。 |

19 道 0/5 里有 1 道（`layout-config-recreation`）同时属于「太慢」，所以：66 − 3 − 20 − 19 + 1（重叠）= **25** 道进入候选池。

## 三、候选池（25 道，都能在 90 分钟内跑完、不需要 GPU、至少有人做出来过）

| 题目 | 分类 | 考察什么 | 专家 | CC 用时 | CC 通过 |
|---|---|---|---|---|---|
| `shadow-relay` | Security/Forensics | 网络取证 + 逆向自定义协议 | 3h | 12m | 3/5 |
| `roy-polymorph-cn` | Science/Chemistry | ROY 多晶型光谱建模 | 3h | 13m | 1/5 |
| `intrastat-meldung` | Operations/Compliance | Intrastat 月结申报（多容器） | 3h | 17m | 1/5 |
| `fin-saccr-rwa` | Operations/Finance | CRR3 的 SA-CCR 重算 | 8h | 20m | 3/5 |
| `gsea-proteomics` | Science/Biology | 蛋白组差异表达与 GSEA | 4h | 21m | 4/5 |
| `heat-pump-warranty` | Operations/Claims | 热泵保修理赔判定（多容器） | 4h | 22m | 2/5 |
| `atrx-vep-crispr` | Science/Biology | 基因组变异注释与致病性判断 | 7h | 24m | 2/5 |
| `mvcc-lsm-compaction` | Software/Databases | 修 MVCC LSM 可见性 bug | 4h | 24m | 3/5 |
| `production-planning` | Operations/Supply chain | 用 ERP/MES/WMS 出生产计划 | 4h | 36m | 3/5 |
| `risk-scorer-replay` | ML/Evaluation | 风控评分离线一致性报告 | 4h | 36m | 5/5 |
| `react-lead-form` | Software/Frontend | 修 React 表单与 CRM 导出 | 5h | 37m | 2/5 |
| `vpp-loss-divergence` | ML/Training | 修训练 loss 轨迹偏离 | 2h | 40m | 5/5 |
| `embedding-drift-monitor` | ML/Inference | 修漂移监控（已跑通 1.0） | 5h | 41m | 5/5 |
| `batched-eval-parity` | ML/Evaluation | 批量评测与单条语义对齐 | 24h | 45m | 1/5 |
| `coq-block-bound` | Science/Math | Coq 证明组合定理 | 16h | 46m | 5/5 |
| `hof-topology-interpenetration` | Science/Chemistry | 晶体拓扑与互穿分析 | 8h | 46m | 5/5 |
| `legacy-utility-triage` | Operations/Claims | 旧版 GUI 处理电费异常单（多容器） | 3.5h | 48m | 4/5 |
| `mp-checkpoint-consolidation` | ML/Inference | 合并 Megatron MoE checkpoint | 6h | 51m | 5/5 |
| `sound-change-cascade` | Science/Linguistics | 反推音变规则序列 | 4h | 55m | 5/5 |
| `vba-userform-port` | Software/Frontend | Excel/VBA 迁 Web | 4h | 64m | 3/5 |
| `layout-config-recreation2` | Media/Design | 反推设计稿布局 | 2h | 68m | 5/5 |
| `html-js-filter` | Security/AppSec | 写 XSS 过滤器 | 0.75h | 72m | 4/5 |
| `kv-live-surgery` | Software/Systems | ptrace 热修 KV 服务（多容器） | 4h | 72m | 4/5 |
| `uefi-bootkit` | Security/Forensics | 拆 UEFI bootkit | 2h | 73m | 4/5 |
| `formal-crypto` | Security/Cryptography | Sage 写密文重构 | 3h | 84m | 2/5 |

可选补充（重环境）：`freecad-platform-drawing`（Hardware，27m，5/5）、`cad-model`（Hardware，34m，5/5）、
`freecad-spring-clip`（Hardware，44m，5/5）、`satb-audio-transcription`（Media，52m，5/5）。

## 四、挑子集要考虑的几件事

1. **难度梯度**：全是 `5/5` 的题测不出差别（CC 和我们都过），全是 `1/5` 的题两边都 0 分。理想是
   `5/5`、`3-4/5`、`1-2/5` 各占一部分。
2. **分类覆盖**：25 道里 Operations 6、Science 6、Software 5、ML 5、Security 4、Media 1、Hardware 0。
   Hardware 只能从「重环境」里补。
3. **容器形态**：多容器 5 道（`intrastat-meldung`、`heat-pump-warranty`、`legacy-utility-triage`、
   `kv-live-surgery`、`medical-claims-processing`(已剔)）。
4. **总时长**：按 CC 口径，候选池合计约 17.6 小时；挑 12 道大约 7 小时，`-n 3` 并发约 2.5–3 小时。
5. **成本**：每场 1–3 元（我们的实测：13 分钟约 1 元、27 分钟约 2.5 元），12 道一轮约 25–35 元。
