# 参与开发

## 环境

- Node.js 24 或更高（`package.json` 的 `engines` 写的）；
- 在 Windows 上开发和实测，macOS、Linux 能跑但没有实测（沙箱那部分只有 Windows 走过）。

## 跑起来

```bash
npm install
npm run web:install    # 网页端自己的依赖
npm run web:build      # 构建网页端，运行时直接提供 web/dist
npm start              # 默认 127.0.0.1:6001，--port 改端口
```

数据目录默认在本机的应用数据目录（Windows 是 `%LOCALAPPDATA%\Reman`，macOS 是 `~/Library/Application Support/Reman`），见 [USAGE.md](USAGE.md)；开发时用 `--data-dir` 指到临时目录，别动自己的数据。

## 检查

改完至少跑这三条：

```bash
npm run typecheck      # 运行时的类型
npx tsc -p web         # 网页端的类型
npm test               # 全部单元测试
```

`npm test` 里有几个用例依赖 Windows 的沙箱账户和进程终止，在受限环境里会失败（路径短名、`taskkill` 被拦），不是改动引起的。

## 改动怎么做

- **先改文档再改代码**：`RUNTIME_DESIGN.md` 开头写着「改设计时先改这里，再改代码」。行为变了就同步改相关文档——接口在 `API.md`，网页端在 `WEB_DESIGN.md`，用法在 `USAGE.md`，测试数据口径在 `BENCHMARKS.md`。
- 不要提交数据目录、运行结果和临时文件：`.gitignore` 已经挡了 `data/`、`.tmp`、`eval/.cache/`、`eval/evidence/`、`eval/.local/`。
- 单元测试和代码放一起（`*.test.ts`），新行为配上能复现它的用例。

## 提交和 PR

- 提交信息：第一行中文写清做了什么，空一行，正文写为什么这么做。
- 分支：从 `main` 拉一个分支做改动，推到远端后开 PR 合回 `main`；`main` 上不放直接推送的改动。
- PR 里写清楚：改了什么、为什么改、跑了哪些检查。

## 许可证

项目用 MIT 许可证，见 [LICENSE](LICENSE)。提交代码即表示同意按这个许可证发布，不需要另外签协议。
