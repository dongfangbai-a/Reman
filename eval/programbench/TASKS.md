# ProgramBench 选题

数据来自官方榜单的逐题结果（[claude-opus-5-xhigh](https://programbench.com/run/claude-opus-5-xhigh/)，198 条实例）：
**9 道完全解出**（% Resolved = 100%）、167 道部分解出、22 道 0 分。
整场总花费 $10,107、51,359 次模型调用。

判断一道题值不值得跑，看三件事：**能不能做出来**（得分）、**要多少步**（调用数 ≈ 单场时长）、**花多少钱**（成本）。
下面三张表分别从这三个角度看（9 / 167 / 22）。100% 解出的 9 道是早期那批的候选池；
**本轮选的是部分解出里的一道**（难度中段），理由见文末「本轮选中的一道」。

题目的中文介绍**不是仓库 tagline 的翻译**：依据是官方包里每题自带的 `tests.json`（测试分组与用例名）
加上实际跑过的观察。早期三道（`hex` / `go-mod-outdated` / `cmatrix`）已归档，现在只看 `rs/jplot`。

## 一、候选池：100% 解出的 9 道（按成本排）

| 题目 | 语言 | 得分 | 调用 | 成本 | 是什么（按题目自带测试与实际运行写的） |
|---|---|---|---|---|---|
| `sitkevij/hex` | Rust | 100% | 119 | $6.02 | 十六进制查看器：列数 / 每行字节数 / 地址前缀 / 颜色都可调，还能按 C、Go、F#、Rust 等数组语法输出，并处理 stdin 与管道输入（测试 877 条、42 组，重头是数组格式与错误处理） |
| `psampaz/go-mod-outdated` | Go | 100% | 110 | $11.96 | 读 `go list -m -u -json all` 的 JSON，把可升级的模块排成表格；还要处理 `replace` 指令、时间戳校验、`-style` / `-direct` / `-update` 等开关（342 条用例） |
| `abishekvashok/cmatrix` | C | 100% | 131 | $15.89 | 终端「数字雨」动画：速度、颜色、字符集、显示模式可调，另有锁屏 / 屏保模式与交互按键；测试很大一块压在帮助文本与参数解析上（769 条、30 组） |
| `simeg/eureka` | Rust | 100% | 171 | $19.05 | 命令行记点子：把想法追加到配置指定的 git 仓库里，带首次配置向导、分页查看、配置读写（400 条用例） |
| `ekzhang/bore` | Rust | 100% | 173 | $19.96 | 内网穿透隧道：`server` / `local` 两个子命令、自有协议与可选认证，测试里有服务端与客户端的联调（452 条用例） |
| `rbakbashev/elfcat` | Rust | 100% | 202 | $25.02 | 把 ELF 可执行文件解析成 HTML 报告：32/64 位、大小端、段与节、地址映射与空洞填充都要对（646 条用例） |
| `clog-tool/clog-cli` | Rust | 100% | 254 | $31.23 | 从 git 提交历史生成 changelog：识别 conventional commits、按模板分组、支持 toml 配置与输入输出文件（778 条用例） |
| `ismaelgv/rnr` | Rust | 100% | 235 | $36.10 | 批量重命名：用正则替换文件名与目录名，支持递归、dry-run、从文件读替换规则、`to ascii` 等子命令（742 条用例） |
| `agourlay/zip-password-finder` | Rust | 100% | 211 | $50.06 | 找回加密 ZIP 的口令：字典与暴力两种模式，可配字符集、口令长度、起始口令、多线程与 AES 加密（792 条用例） |

除了选中的三道，其余六道放备选（理由见文末）。

## 二、部分解出的 167 道（按成本从低到高）

得分不到 100%，说明有测试过不了。成本跨度很大（$8.03 到 $203.20），大部分落在 $10–$40。

| 题目 | 语言 | 得分 | 调用 | 成本 | 是什么（按题目自带测试写的） |
|---|---|---|---|---|---|
| `sheepla/pingu` | Go | 95% | 74 | $8.03 | ping 工具：并发 ping 多个目标，统计与输出格式可调 |
| `gromacs/gromacs` | C++ | 11.3% | 129 | $12.02 | 分子动力学模拟套件（grompp / make_ndx / wham 等子命令） |
| `kisielk/errcheck` | Go | 99.1% | 154 | $13.69 | Go 静态检查：找出没被处理的错误返回值 |
| `OSGeo/PROJ` | C++ | 27.6% | 119 | $13.97 | 地图投影与坐标转换库的命令行工具 |
| `tomnomnom/gron` | Go | 97.3% | 111 | $14.54 | 把 JSON 拍平成可 grep 的逐行赋值，也能 ungron 还原、直接抓 URL |
| `danmar/cppcheck` | C++ | 24.8% | 151 | $14.91 | C/C++ 静态分析器，多种检查器与输出格式 |
| `parcel-bundler/lightningcss` | Rust | 60.3% | 137 | $15.28 | CSS 解析 / 压缩 / 转换器，覆盖大量属性与值类型 |
| `tomarrell/wrapcheck` | Go | 97.5% | 127 | $16.09 | Go linter：检查返回的错误有没有被 wrap |
| `go-critic/go-critic` | Go | 22.3% | 141 | $16.62 | Go 代码检查器集合，多个 checker 与子命令 |
| `nikolassv/bartib` | Rust | 96.9% | 146 | $18.41 | 命令行时间记录：开始 / 停止 / 继续 / 列表 |
| `rs/curlie` | Go | 95.8% | 146 | $18.53 | httpie 风格的 curl 前端，负责 HTTP 请求与结果展示 |
| `chmln/sd` | Rust | 99.4% | 174 | $19.17 | 正则查找替换 CLI，支持 stdin 与文件 |
| `xorg62/tty-clock` | C | 97.9% | 161 | $20.66 | 终端时钟 TUI |
| `noborus/ov` | Go | 94.7% | 174 | $21.33 | 终端分页器，带搜索等 TUI 交互 |
| `eradman/entr` | C | 98.3% | 186 | $22.46 | 文件变化时重新执行命令 |
| `ip7z/7zip` | C++ | 68.8% | 164 | $22.59 | 7-Zip 压缩解压 CLI，覆盖 zip / tar 等格式 |
| `yoav-lavi/melody` | Rust | 93.2% | 175 | $22.60 | 把 Melody 正则 DSL 编译成正则 |
| `arq5x/bedtools2` | C | 60.9% | 176 | $22.67 | 基因组区间运算工具集（intersect / closest / coverage 等） |
| `wfxr/code-minimap` | Rust | 99.7% | 145 | $22.99 | 为源码生成缩略图（minimap） |
| `facebookresearch/fastText` | C++ | 98.1% | 149 | $23.54 | 文本分类与词向量：训练、预测、量化 |
| `typst/typst` | Rust | 52.8% | 190 | $23.63 | 排版系统编译器，覆盖字符串 / 数学 / 日期等运算 |
| `JohannesKaufmann/html-to-markdown` | Go | 97.5% | 175 | $24.08 | HTML 转 Markdown 转换器 |
| `madler/pigz` | C | 98.6% | 181 | $24.31 | 并行 gzip 压缩与解压 |
| `hpjansson/chafa` | C | 55.9% | 132 | $24.34 | 在终端里显示图片（符号 / 颜色模式、动画） |
| `yaa110/nomino` | Rust | 92.3% | 204 | $24.36 | 批量重命名：正则与序号占位符 |
| `zk-org/zk` | Go | 64.1% | 187 | $24.42 | 笔记工具：索引、标签、LSP |
| `wfxr/csview` | Rust | 99.7% | 208 | $25.22 | 终端 CSV 表格查看器 |
| `doxygen/doxygen` | C | 36.7% | 205 | $25.33 | C/C++ 文档生成器 |
| `eliukblau/pixterm` | Go | 98.8% | 147 | $25.36 | 在终端里用 ANSI 颜色渲染图片 |
| `kyoh86/richgo` | Go | 94.7% | 179 | $25.73 | 给 go test 输出上色与美化 |
| `samtools/samtools` | C | 49.8% | 156 | $25.84 | SAM/BAM 比对文件处理（view / sort / stats / coverage） |
| `Miserlou/Loop` | Rust | 99.3% | 195 | $26.22 | bash 循环与重试的 CLI |
| `cheat/cheat` | Go | 86.2% | 243 | $27.42 | 命令行速查表工具 |
| `zevv/duc` | C | 57.8% | 216 | $28.43 | 磁盘用量索引与查询 |
| `konradsz/igrep` | Rust | 87.8% | 204 | $30.15 | 交互式 grep（TUI） |
| `tstack/lnav` | C++ | 19.2% | 264 | $30.56 | 日志查看器：格式识别与 SQL 查询 |
| `lz4/lz4` | C | 92.6% | 198 | $30.91 | LZ4 压缩与解压 |
| `Lymphatus/caesium-clt` | Rust | 96.5% | 212 | $32.05 | 图片压缩 CLI |
| `skeema/skeema` | Go | 88.3% | 249 | $32.25 | MySQL schema 管理与迁移 |
| `guumaster/hostctl` | Go | 96.7% | 259 | $32.35 | 管理 /etc/hosts 的增删改查 |
| `chmln/handlr` | Rust | 99.2% | 213 | $33.71 | 按 MIME 类型打开 / 管理桌面应用 |
| `foriequal0/git-trim` | Rust | 86.8% | 260 | $34.76 | 清理已合并的 git 分支 |
| `ivanceras/svgbob` | Rust | 64.6% | 168 | $35.35 | ASCII 图转 SVG |
| `KSXGitHub/parallel-disk-usage` | Rust | 99.6% | 213 | $35.38 | 并行统计磁盘用量并做可视化 |
| `segmentio/chamber` | Go | 93.1% | 216 | $35.48 | 读写 AWS SSM 参数，供应用注入配置 |
| `hooklift/gowsdl` | Go | 96.2% | 215 | $35.79 | 由 WSDL 生成 Go 的 SOAP 客户端代码 |
| `astaxie/bat` | Go | 89.3% | 209 | $35.99 | 带语法高亮的 cat（bat 的 Go 版） |
| `mfridman/tparse` | Go | 91.8% | 222 | $36.01 | 汇总并美化 go test 输出 |
| `BLAKE3-team/BLAKE3` | Rust | 98.9% | 205 | $36.57 | BLAKE3 哈希命令行（b3sum） |
| `sharkdp/hexyl` | Rust | 99.7% | 242 | $37.26 | 命令行十六进制查看器 |
| `cordx56/rustowl` | Rust | 95.4% | 242 | $38.72 | 可视化 Rust 的所有权与生命周期 |
| `sibprogrammer/xq` | Go | 93.8% | 253 | $38.91 | XML / HTML 格式化与 XPath 查询 |
| `Drew-Alleman/DataSurgeon` | Rust | 86.5% | 300 | $39.23 | 从文本里提取敏感数据（邮箱、IP、密钥等） |
| `altdesktop/i3-style` | Rust | 99.3% | 216 | $39.54 | 为 i3 窗口管理器生成配色 / 样式 |
| `OSGeo/gdal` | C++ | 19.2% | 252 | $39.61 | 地理数据格式转换工具集（gdal_translate 等） |
| `alecthomas/chroma` | Go | 46.5% | 212 | $40.55 | 语法高亮器（库 + 命令行） |
| `mgechev/revive` | Go | 65.3% | 237 | $40.71 | Go linter，规则可配置 |
| `multiprocessio/dsq` | Go | 90.8% | 268 | $41.46 | 用 SQL 查询 CSV / JSON / Parquet |
| `jrnxf/thokr` | Rust | 99.5% | 202 | $41.93 | 打字练习 TUI |
| `ast-grep/ast-grep` | Rust | 57.2% | 228 | $42.34 | 基于语法树的代码搜索与替换 |
| `incu6us/goimports-reviser` | Go | 74.9% | 324 | $42.42 | Go import 分组与重排 |
| `HaliteChallenge/Halite` | C++ | 89.8% | 238 | $42.45 | Halite 对战游戏引擎与回放输出 |
| `sharkdp/hyperfine` | Rust | 96.9% | 261 | $42.53 | 命令基准测试，负责计时与结果比较 |
| `hairyhenderson/gomplate` | Go | 91.2% | 246 | $42.53 | 模板渲染工具，提供大量内置函数 |
| `wintermute-cell/ngrrram` | Rust | 98.7% | 217 | $42.91 | 打字练习 TUI，覆盖多种键盘布局 |
| `direnv/direnv` | Go | 93.1% | 303 | $42.94 | 按目录自动加载 / 卸载环境变量 |
| `dalance/amber` | Rust | 94.9% | 280 | $43.90 | 代码搜索替换工具，支持正则与交互模式 |
| `Canop/broot` | Rust | 74.3% | 191 | $44.01 | 目录浏览与跳转 TUI |
| `duckdb/duckdb` | C++ | 27.1% | 243 | $45.12 | 分析型 SQL 数据库，含 CLI 与 SQL 引擎 |
| `tukaani-project/xz` | C | 46.5% | 235 | $45.32 | xz 压缩与解压 |
| `Esubaalew/run` | Rust | 92.8% | 334 | $45.41 | 多语言脚本运行器（C/C++、Python、bash 等） |
| `ariga/atlas` | Go | 82.5% | 242 | $46.17 | 数据库 schema 迁移工具 |
| `sclevine/yj` | Go | 98.6% | 238 | $46.20 | YAML / JSON / TOML 互转 |
| `FiloSottile/age` | Go | 92% | 218 | $46.45 | 文件加密工具 |
| `codesnap-rs/codesnap` | Rust | 91.9% | 322 | $46.91 | 代码截图渲染 |
| `nachoparker/dutree` | Rust | 98.9% | 234 | $47.52 | 以树状显示目录大小 |
| `jesseduffield/lazygit` | Go | 66.2% | 260 | $47.64 | git 的 TUI 客户端 |
| `mkj/dropbear` | C | 75.3% | 264 | $49.32 | 轻量 SSH 服务端与客户端 |
| `google/brotli` | C | 1.1% | 221 | $49.72 | Brotli 压缩与解压 |
| `robertdavidgraham/masscan` | C | 90.2% | 302 | $50.41 | 大规模端口扫描器 |
| `pier-cli/pier` | Rust | 97.5% | 286 | $50.56 | 管理常用脚本：增删、列表、执行 |
| `noborus/trdsql` | Go | 92.5% | 307 | $50.60 | 用 SQL 查询 CSV / JSON 等文件 |
| `rs/jplot` | Go | 50.8% | 235 | $50.73 | 在终端里画时序图 |
| `lua/lua` | C | 94.7% | 204 | $50.75 | Lua 解释器（标准库行为全覆盖） |
| `tarka/xcp` | Rust | 99.5% | 289 | $50.85 | 并行 cp |
| `Epistates/treemd` | Rust | 85.1% | 294 | $51.59 | 用查询语法筛选 Markdown 树 |
| `TheZoraiz/ascii-image-converter` | Go | 96.1% | 267 | $51.76 | 图片转 ASCII / 盲文 |
| `junegunn/fzf` | Go | 93.7% | 254 | $51.90 | 模糊查找器（交互选择、布局与配色） |
| `hatoo/oha` | Rust | 91.5% | 300 | $52.16 | HTTP 压测工具 |
| `bensadeh/tailspin` | Rust | 95.3% | 298 | $52.38 | 日志高亮显示 |
| `ggreer/the_silver_searcher` | C | 97% | 247 | $52.77 | ag：代码搜索工具 |
| `jonas/tig` | C | 86.8% | 269 | $52.79 | git 的 TUI（日志 / 差异） |
| `lfos/calcurse` | C | 94% | 339 | $53.57 | 日历与待办 TUI |
| `pls-rs/pls` | Rust | 94.9% | 297 | $53.59 | 目录列表美化 |
| `antonmedv/walk` | Go | 96% | 241 | $53.96 | 目录浏览 TUI |
| `peco/peco` | Go | 89.6% | 389 | $54.28 | 交互式过滤 |
| `antonmedv/fx` | Go | 93.8% | 295 | $54.53 | JSON 查看器（交互式） |
| `Nukesor/pueue` | Rust | 93.1% | 334 | $54.76 | 任务队列守护进程与客户端 |
| `gabotechs/dep-tree` | Go | 81.5% | 337 | $56.43 | 依赖关系图 |
| `raviqqe/muffet` | Go | 99.3% | 335 | $56.61 | 死链检查 |
| `riquito/tuc` | Rust | 99.8% | 260 | $56.86 | 按分隔符切字段（cut 的增强版） |
| `tree-sitter/tree-sitter` | Rust | 58.7% | 355 | $57.53 | 语法解析器生成与高亮 |
| `NikolaDucak/caps-log` | C++ | 79.7% | 281 | $58.77 | 加密日志查看器 |
| `orf/gping` | Rust | 97.3% | 294 | $58.88 | 带图表的 ping |
| `cweill/gotests` | Go | 94.7% | 366 | $59.14 | 为 Go 函数生成表驱动测试 |
| `Isona/dirble` | Rust | 94.8% | 338 | $59.78 | 快速浏览目录（只列文件） |
| `chirlu/sox` | C | 49.2% | 253 | $60.63 | 音频处理：格式转换与效果链 |
| `axodotdev/oranda` | Rust | 46.2% | 333 | $60.82 | 为项目生成静态发布页 |
| `eudoxia0/hashcards` | Rust | 99% | 373 | $61.96 | 间隔重复背卡片的 CLI |
| `shashwatah/jot` | Rust | 99.7% | 393 | $62.09 | 快速记笔记与待办的 CLI |
| `sirwart/ripsecrets` | Rust | 79.7% | 234 | $63.35 | 扫描代码里泄露的密钥 |
| `ogham/dog` | Rust | 99.6% | 350 | $63.51 | DNS 查询工具（dig 的替代） |
| `sstadick/hck` | Rust | 99.1% | 332 | $65.89 | 字段切分工具（cut 的替代） |
| `stathissideris/ditaa` | Java | 36.8% | 278 | $66.82 | ASCII 图转图片 |
| `svenstaro/genact` | Rust | 86.6% | 355 | $67.92 | 生成假装在忙的假输出 |
| `brocode/fblog` | Rust | 97.9% | 298 | $70.40 | JSON 日志查看器 |
| `bootandy/dust` | Rust | 91.8% | 297 | $71.18 | du 的可视化替代 |
| `hush-shell/hush` | Rust | 96.6% | 422 | $71.83 | 类 bash 的 shell 解释器 |
| `ArthurSonzogni/json-tui` | C++ | 92.2% | 208 | $74.35 | JSON 的 TUI 查看器 |
| `oppiliappan/eva` | Rust | 99.2% | 306 | $74.48 | 计算器 CLI |
| `rcoh/angle-grinder` | Rust | 94.1% | 385 | $76.50 | 日志查询与聚合 |
| `ecumene/rust-sloth` | Rust | 75.5% | 277 | $77.19 | 图片转 ASCII |
| `unhappychoice/gittype` | Rust | 70.3% | 382 | $78.23 | 统计 git 提交趋势 |
| `sayanarijit/xplr` | Rust | 97.1% | 344 | $78.47 | 文件管理器 TUI |
| `jarun/nnn` | C | 98.5% | 381 | $78.92 | 文件管理器 TUI |
| `blacknon/hwatch` | Rust | 95.9% | 300 | $78.94 | watch 的增强版，带差异高亮 |
| `dundee/gdu` | Go | 89.8% | 383 | $79.04 | 磁盘用量 TUI |
| `mookid/diffr` | Rust | 92.7% | 261 | $80.33 | diff 高亮显示 |
| `alexpovel/srgn` | Rust | 87.8% | 292 | $81.76 | 结构化文本的搜索替换（语法感知） |
| `ajeetdsouza/zoxide` | Rust | 97.9% | 311 | $83.64 | 目录跳转工具 |
| `yassinebridi/serpl` | Rust | 95% | 440 | $84.56 | 交互式搜索替换（TUI） |
| `elkowar/pipr` | Rust | 94.8% | 431 | $84.89 | 交互式构建管道（TUI） |
| `YS-L/flamelens` | Rust | 94.2% | 330 | $84.97 | 火焰图查看器 |
| `kyoheiu/felix` | Rust | 97.4% | 384 | $85.95 | 文件管理器 TUI |
| `sharkdp/pastel` | Rust | 98.7% | 352 | $87.06 | 颜色处理工具（格式转换、色彩空间） |
| `boyter/scc` | Go | 72.8% | 346 | $87.44 | 代码行数统计 |
| `rochacbruno/marmite` | Rust | 76.8% | 423 | $88.96 | 静态博客生成器 |
| `sharkdp/fd` | Rust | 99.4% | 407 | $89.62 | find 的替代品 |
| `sharkdp/bat` | Rust | 86.7% | 356 | $89.82 | cat 的替代品，带语法高亮 |
| `dandavison/delta` | Rust | 66.5% | 371 | $92.02 | git diff 美化 |
| `rust-embedded/svd2rust` | Rust | 93.2% | 429 | $93.27 | 由 SVD 文件生成 Rust 寄存器代码 |
| `svenstaro/miniserve` | Rust | 98% | 426 | $95.37 | 简易静态文件服务器 |
| `o2sh/onefetch` | Rust | 96.7% | 398 | $96.04 | 展示 git 仓库信息 |
| `naggie/dstask` | Go | 96.1% | 455 | $97.14 | 命令行待办管理 |
| `Byron/dua-cli` | Rust | 99% | 391 | $98.08 | 磁盘用量 TUI |
| `jhspetersson/fselect` | Rust | 87% | 469 | $98.31 | 用 SQL 查询文件 |
| `oppiliappan/statix` | Rust | 95.8% | 382 | $98.62 | Nix 代码检查与自动修复 |
| `WGUNDERWOOD/tex-fmt` | Rust | 98.9% | 442 | $100.09 | LaTeX 格式化 |
| `jqlang/jq` | C | 94.7% | 341 | $100.84 | JSON 查询语言解释器 |
| `astro/deadnix` | Rust | 99.5% | 400 | $101.73 | 找出 Nix 代码里的无用绑定 |
| `rhysd/kiro-editor` | Rust | 99.2% | 375 | $101.86 | 终端文本编辑器 |
| `BurntSushi/xsv` | Rust | 98.5% | 334 | $101.89 | CSV 工具集（统计、筛选、切片等） |
| `git-bahn/git-graph` | Rust | 97.9% | 358 | $102.01 | 在终端画 git 提交图 |
| `mikefarah/yq` | Go | 73.7% | 372 | $102.58 | YAML 查询与编辑 |
| `cslarsen/jp2a` | C | 93.2% | 269 | $105.34 | JPEG 转 ASCII |
| `stacked-git/stgit` | Rust | 82.8% | 470 | $108.71 | git 补丁栈管理 |
| `ducaale/xh` | Rust | 84.8% | 482 | $109.61 | 友好的 HTTP 客户端（httpie 风格） |
| `anordal/shellharden` | Rust | 51.3% | 403 | $112.85 | shell 脚本自动修正 |
| `crowdagger/crowbook` | Rust | 85.9% | 503 | $118.23 | Markdown 书转 PDF / EPUB |
| `rust-lang/mdBook` | Rust | 94% | 481 | $119.20 | 用 Markdown 写书并生成网页 |
| `rvben/rumdl` | Rust | 64.7% | 480 | $119.42 | Markdown linter |
| `sigoden/argc` | Rust | 85.4% | 534 | $119.80 | 用注释定义 bash 的 CLI 参数 |
| `BurntSushi/ripgrep` | Rust | 97.7% | 413 | $126.57 | rg：快速递归搜索 |
| `lh3/seqtk` | C | 88.3% | 402 | $141.73 | FASTA/FASTQ 序列处理 |
| `jgm/pandoc` | Haskell | 29.1% | 521 | $143.77 | 文档格式转换器 |
| `kaushiksrini/parqeye` | Rust | 99% | 486 | $155.70 | 查看 Parquet 文件内容 |
| `XAMPPRocky/tokei` | Rust | 95.5% | 617 | $203.20 | 代码行数统计 |

## 三、0 分的 22 道（不展开）

一个测试都没过，跑它们分不出脚手架高低，只列名字备查：

`AmmarAbouZor/tui-journal`、`Canop/rhit`、`FFmpeg/FFmpeg`、`LuaJIT/LuaJIT`、`Stranger6667/jsonschema`、`Y2Z/monolith`、`bellard/quickjs`、`cmatsuoka/figlet`、`facebook/zstd`、`htop-dev/htop`、`johnkerl/miller`、`mgdm/htmlq`、`mibk/dupl`、`ninja-build/ninja`、`nuta/nsh`、`paradigmxyz/solar`、`pemistahl/grex`、`php/php-src`、`rust-ethereum/ethabi`、`sqlite/sqlite`、`trasta298/keifu`、`universal-ctags/ctags`。

## 候选池：Opus 5 用例通过率 10–50% 的 15 道

官方榜单里落在 10–50% 的只有这 15 道（用例数按题目自带 `tests.json` 数出来的）。选它们的理由：
**太简单的题（Opus 5 100% 做出）分不出脚手架高低，太难（10% 以下）三家一起挂**，中段才有区分度。

| 题目 | 语言 | 通过率 | 调用 | 成本 | 用例 | 分支 | 是什么 |
|---|---|---|---|---|---|---|---|
| `OSGeo/PROJ` | C++ | 27.6% | 119 | $13.97 | 7160 | 2 | 地图投影与坐标转换库的命令行工具 |
| `gromacs/gromacs` | C++ | 11.3% | 129 | $12.02 | 1382 | 1 | 分子动力学模拟套件（grompp / make_ndx / wham 等子命令） |
| `go-critic/go-critic` | Go | 22.3% | 141 | $16.62 | 925 | 10 | Go 代码检查器集合，多个 checker 与子命令 |
| `danmar/cppcheck` | C++ | 24.8% | 151 | $14.91 | 2550 | 11 | C/C++ 静态分析器，多种检查器与输出格式 |
| `samtools/samtools` | C | 49.8% | 156 | $25.84 | 1819 | 2 | SAM/BAM 比对文件处理（view / sort / stats / coverage） |
| `doxygen/doxygen` | C | 36.7% | 205 | $25.33 | 252 | 9 | C/C++ 文档生成器 |
| `alecthomas/chroma` | Go | 46.5% | 212 | $40.55 | 531 | 1 | 语法高亮器（库 + 命令行） |
| `tukaani-project/xz` | C | 46.5% | 235 | $45.32 | 2036 | 9 | xz 压缩与解压 |
| `duckdb/duckdb` | C++ | 27.1% | 243 | $45.12 | 8958 | 3 | 分析型 SQL 数据库，含 CLI 与 SQL 引擎 |
| `OSGeo/gdal` | C++ | 19.2% | 252 | $39.61 | 1319 | 2 | 地理数据格式转换工具集（gdal_translate 等） |
| `chirlu/sox` | C | 49.2% | 253 | $60.63 | 1260 | 2 | 音频处理：格式转换与效果链 |
| `tstack/lnav` | C++ | 19.2% | 264 | $30.56 | 1172 | 1 | 日志查看器：格式识别与 SQL 查询 |
| `stathissideris/ditaa` | Java | 36.8% | 278 | $66.82 | 681 | 2 | ASCII 图转图片 |
| `axodotdev/oranda` | Rust | 46.2% | 333 | $60.82 | 978 | 15 | 为项目生成静态发布页 |
| `jgm/pandoc` | Haskell | 29.1% | 521 | $143.77 | 5467 | 2 | 文档格式转换器 |

## 选题记录

三道题都是从 **Opus 5 用例通过率 10–50% 左右**的范围里挑的（题库 198 道，落在这一段的只有上面 15 道）。
选这个区间是因为两端都没区分度：太简单的（Opus 5 全部做出）三家都能做，太难的三家一起挂，只有中段能看出脚手架差别。

三道题选了三个不同方向，各跑一次（三家并行）：

| 题目 | 方向 | 语言 | 用例 / 分支 | 状态 |
|---|---|---|---|---|
| `rs/jplot` @ `2a54bcc` | 终端图表可视化：从 HTTP / stdin 读数据在终端画时序图 | Go | 722 / 8 | 已跑，见 [RESULTS.md](RESULTS.md) |
| `go-critic/go-critic` @ `9aea378` | 代码静态分析器：一批 checker + `check` / `doc` 子命令与各种开关 | Go | 902 / 10 | 已跑，见 [RESULTS.md](RESULTS.md) |
| `typst/typst` @ `88356d0` | 文档排版编译器：把标记语言编译成 PDF，覆盖字符串 / 数学 / 日期运算 | Rust | 1,786 / 10 | 已跑，见 [RESULTS.md](RESULTS.md) |

## 判分方式（确认过）

- 提交物：代码库打包成 `submission.tar.gz`，**根目录要有 `compile.sh`**；
- 评测：`programbench eval <运行目录>` 拉镜像、把包解到 `/workspace`、跑 `compile.sh`，再跑该题各测试分支的 pytest 套件（测试包按题从 HuggingFace `programbench/ProgramBench-Tests` 下载）；
- 指标：**% Resolved**（全部通过）、**% Tests Passed**（部分通过）；
- 过滤规则：`gold_fail`、`gold_flaky`、`dummy_pass` 等有问题的用例已在 `tests.json` 里标注、不计分。
