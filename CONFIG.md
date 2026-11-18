# 配置参考

运行时的数据目录、模型、成员、工具和外部事件的配置项与格式。怎么启动见 [README.md](README.md)，接口见 [API.md](API.md)，使用上的机制和建议见 [NOTES.md](NOTES.md)。

## 数据目录在哪

数据目录默认是 Windows 的 `%LOCALAPPDATA%\Reman`、macOS 的 `~/Library/Application Support/Reman`、
Linux 的 `~/.local/share/reman`（设了 `XDG_DATA_HOME` 时在它下面），`--data-dir` 可改
（`npm start -- --data-dir <数据目录>`）。一个数据目录同一时间只能有一个运行时在用。

## 数据目录里有什么

| 位置 | 内容 |
|---|---|
| `models.json` | 模型配置，见下文；没有这个文件时没有供应商 |
| `members/<成员名>/` | AI 成员的定义，见下文；`members/INDEX.md` 是读取结果 |
| `skills/<技能名>/` | 技能，见下文 |
| `custom-tools/<文件夹名>/` | 自定义工具，见下文 |
| `custom-tools.json` | 自定义工具的配置（key、地址、模型名），在网页端的设置里填 |
| `mcp.json` | MCP 服务器，见下文 |
| `event-routes/<路由名>.js` | 外部事件的路由，见下文 |
| `event-logs/<日期>.jsonl` | 外部事件的日志，保留 14 天 |
| `sources/<来源名>/` | 内置事件来源的状态（处理到哪了） |
| `tool-defaults.json` | 新成员的工具默认设置，只记和内置默认不同的 |
| `skill-defaults.json` | 新成员默认启用的技能名列表；没有这个文件时一个都不启用 |
| `browser-blocklist.json` | 成员的浏览器禁止访问的网址（主机名，可以带端口），在网页端的设置里改；运行时的网页端总是禁止，不写在这里 |
| `remote.json` | 公网访问的设置：Cloudflare 隧道的开关、域名、cloudflared 路径，以及另外放行的域名（Tailscale 之类），在网页端的设置里改；隧道 token 加密保存 |
| `cloudflared/` | 下载的 cloudflared 和它的进程 pid；下载时核对过大小和 SHA-256 |
| `cloudflared.log` | cloudflared 自己的输出，隧道连不上时看这里；超过 5 MB 时下次启动清掉 |
| `terminals.json` | 终端数量的全局上限：AI 成员合计能创建几个（只算 shell 还在跑的），1 到 32，没有这个文件时是 16；在网页端的「shell 环境」里改。用户自己建的另有 20 个上限，不能配 |
| `sandbox.json` | 沙箱开关和沙箱里的网络设置，在网页端的设置里改。`network`：`"all"`（默认）、`"none"`、`{ "allow": [主机名] }` 或 `{ "deny": [主机名] }`，主机名可以带端口；本机地址总是能连 |
| `workspaces/<成员 ID>/` | AI 成员的默认工作目录，第一次用到时创建 |
| `resources/` | 工具结果里的图片；`resources/attachments/` 是消息和直接对成员说话带的附件 |
| `tool-outputs/` | 过长的工具结果，完整内容存成文件，结果里写明路径；`builtin/<工具名>/`、`custom/<文件夹名>/`、`mcp/<服务器名>/` 分开放，不清理 |
| `browsers/<成员 ID>/` | 成员浏览器的浏览数据（登录状态、Cookie）；`browsers/<成员 ID>.json` 记着上次开着的标签页 |
| `runtime.sqlite` | 数据库：成员、群聊、消息、时间线、运行、审批、后台任务、定时 |
| `access-token`、`runtime.json` | 访问令牌；`runtime.json` 记录当前运行时的端口、令牌和进程 |
| `secret-key` | 加密配置里密钥的钥匙，第一次启动时生成；丢了或换了，配置里的密钥要重新填 |
| `runtime.lock` | 数据目录的锁，保证同一时间只有一个运行时 |

成员改数据目录里 `workspaces/` 以外的文件总要用户审批，读 `access-token`、`runtime.json`、`secret-key` 也要；成员的浏览器打不开网页端，用户还可以在设置里加禁止访问的网址。

`models.json` 的 `apiKey`、`mcp.json` 里 `env` 和 `headers` 的值、`custom-tools.json` 里的密钥，运行时读到明文时加密写回原处，成为 `enc:v1:...`；手动编辑时照常写明文。这些文件被读到、拷走或提交到 git 都只露出密文，但挡不住同一个系统用户刻意去拿。令牌最好在网页端填，不经过成员。

Windows 上没有 Git Bash 时，可以从网页端设置的「shell 环境」里安装 PortableGit（约 60 MB），装在 `%LOCALAPPDATA%\reman-runtime\PortableGit`。

## 模型

`models.json` 可以有多个供应商，每个供应商有自己的地址、key 和已添加的模型：

```json
{
	"defaultModel": { "provider": "zhipu", "model": "glm-5.3" },
	"providers": [
		{
			"id": "zhipu",
			"name": "智谱",
			"baseUrl": "https://example.com",
			"apiKey": "<key>",
			"models": [{ "model": "glm-5.3", "displayName": "GLM-5.3", "contextWindow": 200000, "vision": false }]
		}
	]
}
```

- 只支持 OpenAI 的 **Responses** 接口（SDK 里的 `responses.create`）；Chat Completions 那套不支持，供应商要兼容
  Responses 接口。
- 请求发到哪个地址：只填域名时补 `/v1/responses`，填到版本段（`/v1`、`/v2`、`/v1beta`）时补 `/responses`，已经以
  `/responses` 结尾或路径更长时原样使用。网页端填地址时，输入框下面会显示最终请求的地址。
- 路径不一样、又不能按上面的约定补的服务：在网页端打开供应商的「完整地址」开关，地址完全按填的发，不追加
  任何路径。配置文件里对应 `endpointMode: "exact"`，不写等于 `"auto"`。模型列表（`GET …/models`）用同一个前缀。
- 供应商 `id` 只能用小写字母、数字和横杠，成员的 `member.json` 用它引用模型。
- 每次请求模型时重新读取 `models.json`，改了不用重启。
- 字段很严格：不认识的字段直接报错；`defaultModel` 必须指向已添加的模型。
- `contextWindow` 是供应商标的上下文长度，没写时按 128k 算；快满时自动压缩，剩下的留给输出。
- `vision: true` 时，图片（工具结果里的、消息附件里的）才会发给模型；没加时只告诉它有图片看不到。

## AI 成员

AI 成员由 `members/<成员名>/` 文件夹定义：

- `member.json`：配置，最简单是 `{}`；
- `prompt.md`：成员设定（提示词），可选，最多 5000 字；
- `memory.md`：成员自己记下的长期记忆，成员用工具维护，用户也可以改；
- `avatar.png` 等：头像，可选。

改了文件自动生效。删掉文件夹，成员被软删除，可以在网页端成员页的「已删除」里恢复。已删除的成员仍占着名字，同名文件夹不会被读取。读取结果、写错的地方和已删除成员占着的名字都写在 `members/INDEX.md` 里。真人不在文件里，在网页端创建。

`member.json` 的字段都可以省略，不认识的字段算写错：

| 字段 | 说明 |
|---|---|
| `description` | 备注：一句话，记这个成员负责什么。真人的备注在网页端设置 |
| `model` | `{ "provider": "zhipu", "name": "glm-5.3" }`；不写时用默认模型 |
| `reasoning` | 思考强度：low、medium、high、xhigh、max；不写时不发这个参数 |
| `directMessage` | 能和哪些 AI 成员私聊：`"none"`（默认）、`"all"`、`{ "allow": [成员名] }` 或 `{ "deny": [成员名] }`；双方都允许才能私聊。和真人总能私聊 |
| `groupInvite` | 哪些 AI 成员能把它拉进群聊：`"all"`（默认）、`"none"`、`{ "allow": [成员名] }` 或 `{ "deny": [成员名] }`。用户在网页端拉它进群不受影响，已经在的群不受影响 |
| `skills` | 能读的技能名。不写时用新成员的默认技能，内置默认一个都不启用；写了（包括 `[]`）就只有列出的 |
| `tools` | 启用的工具；MCP 服务器写成 `mcp:<服务器名>`。不写时启用默认启用的那些工具：内置默认除了 `terminal`、`manage_group`、`test_event_route` 都启用，MCP 都不启用 |
| `timeAwareness` | 时间感知：收到的内容带不带收到时的时间。不写时是 `true`；改了只影响之后收到的 |
| `maxTerminals` | 最多同时开几个自己的终端，1 到 16 的整数，不写时是 3。只算这个成员建的、shell 还在跑的终端；退出了就不占名额，接过去操作也不改变归属。已有的超出上限不强制关闭，只是不能再新建 |

审批方式和工作目录不在文件里，在网页端的成员设置里改：

- 工作目录不指定时用 `workspaces/<成员 ID>`。指定的目录不存在、不是文件夹或无法访问时，成员设置里写明原因。
- 新成员的工具默认设置（启用哪些、审批方式）可以在网页端的设置里改，只决定以后新建的成员。改之前，还在用默认值的成员（`member.json` 没写 `tools`、审批方式没单独设置过）先把当前设置写成自己的，所以已有成员不跟着变。

## 技能

技能放在 `skills/<技能名>/SKILL.md`，和仓库里 `skills/` 下的内置技能同名时用数据目录里的。SKILL.md 里的 `{{members_directory}}`、`{{skills_directory}}` 读取时换成实际路径。成员能读哪些技能写在 `member.json` 的 `skills` 里。新成员默认启用哪些技能在网页端的设置里选，存在 `skill-defaults.json`；和工具一样只决定以后新建的成员，改之前还在用默认的成员先把当前的技能写成自己的。

内置技能不能改、不能删，可以在网页端复制为自己的再改。内置技能 `write-skill` 写明了技能的格式和放在哪，配给成员后它就能自己写技能。网页端还可以从常见的全局 agent 技能目录（`~/.agents/skills`、`~/.claude/skills`、`~/.codex/skills`）或任意文件夹导入技能。

## 自定义工具

一个文件夹是一项工具：`custom-tools/<文件夹名>/` 里放 `tool.json`（工具的说明、参数、要用户填的配置）和脚本。每次调用起一个进程，标准输入给参数和配置，脚本把结果写到标准输出。格式见内置技能 `create-custom-tool`，配给成员后它就能自己写；仓库里 `custom-tools/` 下是内置的网络搜索（`web`，DeepSeek 的搜索接口）和生图（`generate_image`，OpenAI 的生图接口），数据目录里同名的覆盖它们。

- 配置在网页端「设置 → 自定义工具」里填，存在 `custom-tools.json`。供应商类的配置可以选模型设置里的供应商，不用再填一遍 key。必填的没填时这项工具不能用；设置里也可以停用一项。不能用、停用时成员照常有这些工具，调用时返回原因，就像上游服务出了问题。
- 一个文件夹里的工具作为一项管理：一起启用和停用，审批方式相同，共用一份配置。只有需要这样统一管理的工具才放进同一个文件夹（如 `web`），仅是经常配合使用的各建一个。只有一个工具的，文件夹名就用工具名（如 `generate_image`），网页端和模型看到的是同一个名字。
- 成员按项启用：`member.json` 的 `tools` 里写 `custom:<文件夹名>`，新成员默认不启用；写了没有的只给警告。
- `tool.json` 里写了 `"progressive": true` 的工具是渐进式工具，不直接给模型，用 `more_tools` 查看和调用。
- 在沙箱外运行，改文件马上生效。

## MCP 服务器

MCP 服务器提供更多工具，配置在 `mcp.json`，格式和常见客户端一样：

```json
{
	"mcpServers": {
		"local": { "command": "...", "args": [], "env": {}, "cwd": "..." },
		"remote": { "url": "https://...", "headers": {} }
	}
}
```

- 有 `command` 的是本地命令，用 stdio 连接；有 `url` 的是远程地址，用 Streamable HTTP 连接。
- 名字只能用英文字母、数字、横杠和下划线，最多 32 个字符。
- 改了文件自动重新读取，只重连改过的服务器。
- 需要 OAuth 登录的服务器暂不支持，令牌可以写在 `headers` 里。
- 成员按服务器启用：`member.json` 的 `tools` 里写 `mcp:<服务器名>`，新成员默认不启用；写了没配置的服务器只给警告。
- 写 `"disabled": true` 停用，不启动、不连接。

## 外部事件

飞书消息、GitHub 通知等外部事件经过路由交给 AI 成员，或者由真人成员发到群聊。来源是声明了 `claude/channel` 能力的 MCP 服务器；运行时内置 GitHub 和飞书两个事件来源，在 `mcp.json` 里这样写：

```json
{
	"mcpServers": {
		"github": { "builtin": "github", "env": { "GITHUB_TOKEN": "..." } },
		"feishu": { "builtin": "feishu", "env": { "FEISHU_APP_ID": "...", "FEISHU_APP_SECRET": "..." } }
	}
}
```

- GitHub：经典令牌，要 `notifications` 权限；私有仓库要取评论的正文和作者、CI 运行的链接时再加 `repo`。GitHub 企业版加 `GITHUB_API_URL`。轮询通知，第一次启动只从启动时算起。
- 飞书：企业自建应用，开启机器人能力，事件订阅选长连接，订阅「接收消息」；机器人要先拉进群。一个应用只给一个运行时用。工具 `reply` 发消息。要开的权限，改了要发布版本才生效：
  - 收消息：`im:message.p2p_msg:readonly`（单聊）、`im:message.group_at_msg:readonly`（群里 @ 机器人的）；收群里所有消息再加 `im:message.group_msg`（敏感权限）。
  - 发消息：`im:message:send_as_bot`。
  - 群名：`im:chat:readonly`。发送人名字：`contact:contact.base:readonly` 和 `contact:user.base:readonly`，通讯录权限范围要包含发消息的人。
- 来源连上以后写到 stderr 的内容记成警告，显示在网页端的来源列表和事件日志里；投递满了上限（每个来源每小时要唤醒成员的 300 次、不唤醒的 3000 次）也记一条。
- 路由是 `event-routes/` 里的 `.js` 文件，格式见内置技能 `write-event-routes`，配给成员后它就能写路由。

## 安全

运行时只监听本机。一旦要从别处访问——局域网、Tailscale、Cloudflare 隧道这些——访问令牌就等于
运行运行时的那个系统用户的完整权限（能开终端、执行命令、改文件、浏览目录），谁拿到令牌谁就有这份权限。

令牌存在数据目录的 `access-token` 里，重启后沿用。要在服务器上跑，用 SSH 隧道访问
（`ssh -L 6001:127.0.0.1:6001 <服务器>`），并用专门的低权限系统用户运行。
