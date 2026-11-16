# Reman 接口

运行时和前端之间：命令和查询走 HTTP，请求和返回都是 JSON；运行时主动发出的通知走一条 SSE 事件流。

## 约定

- 只监听本机，默认 `http://127.0.0.1:6001`。
- `/v1` 下的请求要带 `Authorization: Bearer <访问令牌>`，或者带网页端用令牌换来的 Cookie。用 Cookie 的非 GET 请求还要检查 `Origin`，不接受来自其他网页的请求。`/v1` 以外的 GET 请求返回网页端的静态文件，不需要认证。
- 成员的浏览器发出的本机请求带 `X-Reman-Member-Browser` 头，带这个头的请求一律拒绝（403），包括经过开发服务器转发的：成员不能用网页端和接口。
- `Host` 的主机名只接受 `127.0.0.1`、`localhost`、`[::1]`，端口不限；其他的拒绝（403）。
- 出错时返回对应的状态码和 `{ "error": { "code": "...", "message": "..." } }`，`message` 是给人看的中文说明。
- 文中的 `:memberId` 是成员 ID（`M_` 开头）。其他 ID 的开头：群聊 `G_`、终端 `T_`、后台任务 `B_`、定时 `R_`、附件 `A_`、分组 `L_`。
- 上传文件的接口，请求体是文件内容本身，不是 JSON。

## 连接

| 接口 | 说明 |
|---|---|
| `GET /v1/state` | `{ epoch, revision, platform }`：事件流现在的纪元和版本号，以及运行时所在的系统（Node 的 `process.platform`，如 `win32`、`linux`、`darwin`；网页端认路径时用） |
| `POST /v1/session` | 网页端拿链接里的令牌换 Cookie（`reman_token`，HttpOnly），之后的请求（包括图片和下载）都靠 Cookie |
| `GET /v1/events` | SSE 事件流，见最后「事件流」 |

## 模型

| 接口 | 说明 |
|---|---|
| `GET /v1/models` | 读 `models.json`，不含 key（只给末四位作为预览，key 太短时为空；`undecryptable` 为 `true` 时加密保存的 key 解不开，要重新填写） |
| `PUT /v1/models` | 整个替换 `models.json`；供应商没给 `apiKey` 时沿用原来的，给了的加密后保存 |
| `GET /v1/providers/:providerId/upstream-models` | 拉取供应商的模型列表，用来挑选要添加的模型 |
| `POST /v1/models/test` | 测试一个已添加的模型能不能用：`{ provider, model }`（模型名可能带 `/`，所以放在请求体里），用已保存的地址和 key 发一次请求，60 秒超时。能用时返回 `{ ok: true, reply, firstOutputMs, totalMs, usage }`，`reply` 是回复的文字（可能为空），`firstOutputMs`、`usage` 服务没报告时为 `null`；不能用时也正常返回 `{ ok: false, error }`，`error` 是给人看的原因，包括供应商或模型不存在、key 解不开。缺 `provider` 或 `model` 时报错（400）。不算运行，不进时间线 |

## 成员

| 接口 | 说明 |
|---|---|
| `GET /v1/members` | 全部成员，包括已删除的（`deletedAt` 不为 `null`）和彻底删除的（`purged` 为 `true`，对话里显示发送者用）。已删除的 AI 成员带 `deletion`：删除时解散的群聊、退出的群聊、暂停的定时数 |
| `GET /v1/members/:memberId` | 一个成员 |
| `POST /v1/members` | 新建成员，见下 |
| `PUT /v1/members/:memberId/files` | 改 AI 成员的文件：`definition` 整个替换 `member.json`，`prompt` 替换 `prompt.md`；没给的不变 |
| `GET /v1/members/:memberId/memory` | AI 成员的记忆：`{ memory, limit }`，`memory` 是 `memory.md` 的内容（没有时是空字符串），`limit` 是上限字数 |
| `PUT /v1/members/:memberId/memory` | `{ "memory": "..." }` 替换记忆，空字符串删掉 `memory.md`；会刷新成员上下文开头的记忆。返回和 GET 一样 |
| `GET /v1/members/:memberId/plan` | AI 成员的计划：`{ items, updatedAt }`，`items` 每项 `{ text, status }`，按成员写的顺序，`status` 是 `pending`、`in_progress` 或 `completed`；`updatedAt` 是最近一次更新的时间。没有更新过时 `items` 是空列表、`updatedAt` 是 `null`；清空过、或全部完成后自动清空了时 `items` 是空列表，所以不会出现全部是 `completed` 的计划。计划只由成员用 `update_plan` 更新，用户只能清空（见下一行） |
| `DELETE /v1/members/:memberId/plan` | 清空 AI 成员的计划，返回清空后的计划（写法同上，`items` 是空列表）。计划不为空时，在成员的时间线末尾追加一条变动说明「用户清空了你的计划。」，不唤醒成员；本来就是空的时不做什么。成员忘了更新计划时用 |
| `PUT /v1/members/:memberId/model` | `{ "model": { "provider": "...", "name": "..." } \| null, "reasoning": "high" \| null }`：只改 `member.json` 里的模型和思考强度，其他字段原样保留；`null` 表示用默认模型、不指定思考强度。从下一次运行开始生效 |
| `PUT /v1/members/:memberId/description` | 真人的备注：`{ "description": "..." }`，空字符串清空。AI 成员的备注在 `member.json` 里 |
| `PUT /v1/members/:memberId/working-directory` | `{ "workingDirectory": "<绝对路径>" \| null }`，`null` 表示用默认工作目录 |
| `PUT /v1/members/:memberId/avatar` | 换头像，请求体是 png、jpg、webp 或 gif 图片 |
| `DELETE /v1/members/:memberId/avatar` | 删除头像 |
| `GET /v1/members/:memberId/avatar` | 取头像：成员文件夹里的头像文件；已删除的成员没有 |
| `DELETE /v1/members/:memberId/browser` | 清除成员的浏览数据，先关掉它的浏览器 |
| `DELETE /v1/members/:memberId` | 删除 AI 成员：删掉它的文件夹，成员被软删除；它建的群聊解散、所在的群聊退出，定时暂停，浏览数据保留，都能恢复 |
| `POST /v1/members/:memberId/restore` | 恢复已删除的 AI 成员：成员文件夹不存在时用运行时存的内容生成，已有同名文件夹时用文件夹里的内容；恢复删除时解散和退出的群聊，定时继续 |
| `POST /v1/members/:memberId/purge` | 彻底删除已删除的 AI 成员：删掉只属于它的数据（存的成员文件、时间线和运行记录、计划、定时、工具审批方式、浏览数据，成员页分组里的它、使用者看到哪一条），对话里的消息保留；名字空出来，不能恢复 |
| `GET /v1/member-folders` | 成员文件夹的读取结果：每个文件夹读出了什么、有什么问题；`workspacesDirectory` 是默认工作目录所在的目录 |
| `GET /v1/directories?path=<绝对路径>` | 列出运行时所在机器上这个目录的子目录（不含隐藏目录），选择工作目录用；不给 `path` 时只返回用户目录和各个盘符 |

新建成员 `POST /v1/members`：

- 真人：`{ "type": "human", "name": "..." }`。
- AI 成员：`{ "type": "ai", "name": "...", "definition": {...}, "prompt": "...", "toolPolicies": { "<工具名>": "<审批方式>" }, "workingDirectory": "..." }`，除了 `type` 和 `name` 都可以不给。运行时建成员文件夹，没给的工具设置和技能按现在的默认设置记下来，以后改默认设置不影响它。审批方式和工作目录先检查，有误时什么都不建。

成员数据里：

- `skills`：AI 成员实际在用的技能；`member.json` 没写 `skills` 时是新成员的默认技能。
- `timeAwareness`：AI 成员的时间感知开没开（收到的内容带不带时间，见运行时设计第 5 部分「时间」）；`member.json` 没写时是 `true`。在 `definition` 里改。
- `defaultWorkingDirectory`：默认工作目录（数据目录的 `workspaces/<成员 ID>`，第一次用到时创建）；真人是 `null`。
- `workingDirectoryProblem`：指定的工作目录不存在、不是文件夹或无法访问时写明原因（每次取成员数据时检查），否则是 `null`。

## 工具和审批方式

| 接口 | 说明 |
|---|---|
| `GET /v1/tools` | 全部工具和新成员的默认设置，见下 |
| `PUT /v1/tool-defaults/:toolName` | 改新成员的默认设置：`{ "enabled": false, "policy": "ask" }`，可以只给一项；自定义工具写 `custom:<文件夹名>`，MCP 服务器不能设；返回新的 `tools` |
| `DELETE /v1/tool-defaults` | 全部恢复内置默认；返回新的 `tools` |
| `GET /v1/members/:memberId/tools` | 这个 AI 成员的工具：是否启用、审批方式 |
| `PUT /v1/members/:memberId/tools/:toolName` | `{ "policy": "..." }` 改这个成员某个工具的审批方式；MCP 服务器写 `mcp:<服务器名>`；返回新的 `tools` |

`GET /v1/tools` 的每一项：

- `enabled`、`policy` 是新成员的默认设置，`builtinEnabled`、`builtinPolicy` 是内置默认。
- `label`：给用户看的短说明，如「执行命令」；MCP 服务器是 `null`。
- `autoPolicy`：能由工具自己判断要不要审批（审批方式 `auto`）的工具，写这种方式的名字和规则说明（`{ "label": "...", "description": "..." }`）；其他工具是 `null`。
- `run_tool_script` 只能开关、不用审批：它的 `policies` 是空的，`policy` 总是 `allow`，不能给它设审批方式。
- 每个 MCP 服务器是一项，`mcpServer` 是服务器名（其他工具是 `null`），单个 MCP 工具不列出。新成员的默认设置不能改 MCP，MCP 的审批方式默认 `ask`。
- 每项自定义工具是一项，名字是 `custom:<文件夹名>`，`customTool` 是 `{ "folder": "...", "origin": "builtin" 或 "own", "disabled": 停用了没有, "problem": 未配置的原因或 null }`（其他工具是 `null`；停用和未配置只影响调用的结果，成员照常有这些工具），`groupTools` 列出它的工具。审批方式只有 `ask`、`allow`，内置默认按 `tool.json` 的 `defaultPolicy`。新成员的默认设置能改自定义工具（`PUT /v1/tool-defaults/custom:<文件夹名>`），内置默认不启用。

## 审批和后台任务

| 接口 | 说明 |
|---|---|
| `GET /v1/approvals?memberId=&pending=0` | 审批请求；默认只列待处理的，`pending=0` 时也列已处理的；`memberId` 只看一个成员 |
| `POST /v1/approvals/:approvalId/approve` | 批准：`{ "scope": "once" }` 只允许这一次（默认）；`"code"` 这段脚本里这个工具都允许，只用于脚本里的调用；`"run"` 这次运行里这个工具都允许（写入文件和修改文件算一起），同一次运行里这个工具其他待处理的审批一起通过；`"terminal"` 这个成员往这个终端里的输入都允许，到终端关闭为止，只用于 `terminal` 有审批原因（`reasons` 不为空）的调用，新建终端的调用管新建的终端。受保护的调用（审批请求的 `protectedReasons` 不为空：改运行时的数据、读令牌和密钥）只能 `once` |
| `POST /v1/approvals/:approvalId/deny` | 拒绝：`{ "reason": "..." }`，原因可以不给，会告诉成员 |
| `GET /v1/members/:memberId/tasks` | 成员的后台任务 |
| `POST /v1/tasks/:taskId/cancel` | 取消后台任务 |
| `GET /v1/runs/:runId/calls/:callId/code-calls` | 一次 `run_tool_script` 的脚本里每次工具调用的记录；没有时是空列表 |
| `GET /v1/runs/:runId/calls/:callId/output` | 执行中的 `shell` 调用到目前为止的输出：`{ output: string }`，和最后的结果一样保留开头和结尾、中间省略。调用已经结束、不是 `shell` 或不存在时 404，结果从时间线或后台任务里取 |

## 运行和时间线

| 接口 | 说明 |
|---|---|
| `GET /v1/member-states` | 全部 AI 成员的状态，见下 |
| `GET /v1/members/:memberId/work?quietMs=` | 这个成员还有没有活没干完：`status`（`idle`/`running`/`paused`/`failed`/`interrupted`）、`busy`、`run`（运行中，含等待审批）、`pendingWake`（有会唤醒它的内容还没处理）、`runningTasks`、`version`（工作状态变一次加一）、`quietMs`（距最后一次变化的毫秒数）、`settled`（没有工作且静默够 `quietMs`，默认 2000，最多 60000） |
| `GET /v1/members/:memberId/work/wait?quietMs=&timeoutMs=` | 同上，但一直等到真的停下来才返回（长轮询）；到 `timeoutMs`（默认 60000，最多 240000 毫秒）返回那一刻的快照，`settled` 是 `false`。等成员停下来（脚本、基准测试）用它，不要自己拼状态和全局 `revision`：那一瞬间成员可能正被后台任务的结果唤醒 |
| `POST /v1/members/:memberId/pause` | 暂停 |
| `POST /v1/members/:memberId/resume` | 恢复 |
| `POST /v1/members/:memberId/retry` | 出错停止、运行中断后接着运行：重新处理没看过的内容，停在工具结果上的接着请求模型 |
| `GET /v1/members/:memberId/runs?limit=` | 最近的运行：状态、原因、开始和结束时间、请求次数和 token 合计（运行中的是到现在为止的合计，网页端时间线最后那行「运行中」用它）；`waitedMs` 是只在等审批的时间（毫秒），用时是结束减开始再减掉它，见运行时设计「运行用时」 |
| `GET /v1/members/:memberId/timeline` | 时间线，按先后排：默认从头取；`after=<条目 ID>` 取这条之后的，`before=<条目 ID>` 取这条之前最近的一页；`limit` 每页条数，默认 100，最多 500。消息条目带上消息内容，模型输出和工具结果带上所属运行。摘要（`summary`）的 `summary.counts` 是它代替了哪些内容，压缩时的删除记录（`kind` 是 `pruning`）的 `pruning.counts` 是这次删掉了哪些内容，都按种类数：`summaries`、`messages`、`thinking`、`outputs`、`calls`、`events`（种类见运行时设计第 5 部分「压缩」）。摘要的 `summary.rangeText`、没放进上下文的内容的说明（`kind` 是 `omission`）的 `omission.rangeText` 是上下文里写的时间范围，如 `2026-11-01 10:02 到 2026-11-01 11:40（America/Chicago，UTC-06:00）`，写下时按当时的时区定下，之后不改；`startTime`、`endTime` 是两端的时刻。压缩后放回的计划说明（`kind` 是 `plan`）的 `plan.items` 是当时的计划，写法和 `GET /v1/members/:memberId/plan` 的 `items` 一样。压缩记录（`kind` 是 `optimization`）见下。每个条目的 `contextState` 是它在不在上下文里：`visible` 在上下文里，`summarized` 被摘要代替，`pruned` 被删掉，`omitted` 没看过的内容太多时拿出了上下文，`unreturned` 是没有实际产出、没带回上下文的一轮（见运行时设计第 5 部分「上下文里的先后」）。收到的内容带着时间时有 `time`：`{ text, at, timeZone, full }`，`text` 是上下文里内容编号后面的那段（如 `时间：2026-11-05 14:23`），`at` 是写下的时刻，`full` 是不是完整的时间（带星期、时区和偏移）；不带时没有这一项，见运行时设计第 5 部分「时间」 |
| `POST /v1/members/:memberId/timeline` | 直接对 AI 成员说话，见下 |
| `GET /v1/members/:memberId/timeline/:itemId/attachments/:index` | 取回直接说话带的附件 |
| `GET /v1/members/:memberId/context` | 上下文用量，见下 |
| `GET /v1/usage?memberId=&since=&until=&groupBy=` | 模型用量：`{ usage }`，顶层是合计（`requests`、`inputTokens`、`cachedTokens`、`outputTokens`）和 `failedRequests`（没成功的请求数，token 不计入合计），`groups` 是拆开的明细。`groupBy` 是 `model`（默认，每项带 `provider`、`model`）或 `member`（每项带 `memberId`），每项都有 `key` 和四项数字。`memberId` 只看一个成员，不传是整个运行时；`since`、`until` 是毫秒时间戳，含头不含尾。上下文占用是估算，这里是模型服务报的真实数字，按它算钱 |
| `POST /v1/members/:memberId/optimize` | 手动压缩一次：运行中、历史不满 48k（上下文长度的 60% 更小时按它算）、或者没有能处理的内容（全是最近的内容）时拒绝 |
| `GET /v1/resources?id=<资源 ID>` | 取资源文件，比如工具结果里的图片 |

`GET /v1/member-states` 返回 `states`，每个 AI 成员一项：

- `status`：`idle` 空闲、`running` 运行中、`waiting_approval` 等待审批、`paused` 已暂停、`failed` 出错停止、`interrupted` 运行中断（停在了工具结果上，如运行时退出时中断）；后两种 `error` 写原因，都可以重试。
- `activity`：正在运行时，这次运行开始的时间、在做哪一步（`model` 请求模型、`tools` 执行工具、`optimizing` 整理上下文）和这一步开始的时间；请求模型时还有模型正在输出的那一项（`output`：`reasoning` 思考、`text` 文字，或者 `call` 工具调用和工具名；还没开始输出、模型服务不说时是 `null`）；执行工具时还有正在执行的调用（工具名和参数，参数里的长文字截短）；整理上下文时还有这是第几次请求（`optimizationRequest`：`1`，第一次的方案不合规、带着不合规的地方重新请求时是 `2`）。不在运行时是 `null`。

时间线里的压缩记录（运行时设计第 5 部分「压缩」里的「压缩记录」）：`kind` 是 `optimization`，后面紧跟着这次压缩生效的对记忆的修改、摘要、删除记录和放回的计划说明（出错、停止时没有）。`optimization` 里：

- `trigger`：什么时候压缩的，`before_request` 运行中请求前、`after_run` 运行结束时、`manual` 手动。
- `status`：`completed` 完成、`failed` 出错、`stopped` 停止；`error` 是出错、停止的原因，完成时是 `null`。
- `startedAt`、`endedAt`：开始和结束的时间。
- `estimate`：整理前后的估算，`before` 和 `after`（token），前后都按全部内容估算；出错、停止时 `after` 是 `null`。
- `requests`：每次请求一项，按先后，最多两项。`requestId`；`reasoning` 思考的文字（摘要，没有摘要时是原文，都没有时是空字符串；请求中途出错、停止的是已经推送出来的部分）；`output` 输出的原文，没收到时是 `null`；`problems` 不合规的地方，有第二次请求时第一次的是整份没执行的原因，第二次的是跳过的操作（`status` 是 `failed` 时是一个都用不上的原因）；`retries` 自动重试过的错误，按先后（服务不支持 `json_schema`、改用 `json_object` 重新请求的也在里面）；`inputTokens`、`cachedTokens`、`outputTokens`，没报告时是 `null`。

直接对成员说话 `POST /v1/members/:memberId/timeline`：

- `{ "text": "...", "attachments": ["<附件 ID>"] }`，文字和附件至少有一样。附件和发消息一样先上传拿到 ID，最多 10 个。
- 这段话不属于任何私聊或群聊，进时间线并唤醒成员；成员正在运行时，下一次请求模型时带上。在上下文里的写法见运行时设计。
- 返回新的时间线条目 `item`；条目的 `input.attachments` 是附件信息。

上下文用量 `GET /v1/members/:memberId/context` 返回 `{ context }`：

- `contextWindow`：上下文长度。
- `usedTokens`：下一次请求的输入。是上次请求模型报告的实际输入加上之后新内容的估算；没请求过或压缩过时全部估算。
- `categories`：各部分的用量，按估算的比例分摊，加起来等于 `usedTokens`。`system` 规则、成员设定、运行环境和通讯录；`tools` 工具定义；`memory` 记忆；`incoming` 收到的内容；`toolCalls` 工具调用和结果；`outputs` 输出的文字和思考；`summaries` 摘要。
- `historyTokens`：后四项的合计，也就是能压缩的部分。
- `optimizeProblem`：现在不能手动压缩的原因，能压缩时是 `null`。

## 对话和消息

| 接口 | 说明 |
|---|---|
| `GET /v1/members/:memberId/conversations` | 这个成员的对话列表 |
| `GET /v1/members/:memberId/conversations/:kind/:targetId/messages` | 对话里的消息：`kind` 是 `direct`（`targetId` 是对方成员 ID）或 `group`（群聊 ID）。默认最新一页；`before=<消息 ID>` 往前翻，`after=<消息 ID>` 往后翻，`around=<消息 ID>` 取这条消息前后各一段；`limit` 每页条数 |
| `POST /v1/members/:memberId/conversations/:kind/:targetId/read` | `{ "throughMessageId": 123 }`：这条及之前的消息标为已读 |
| `GET /v1/members/:memberId/messages/search?q=…` | 在这个成员能看到的消息里搜：空格分开的词都要包含，不分大小写，新的在前；`before` 往前翻页 |
| `GET /v1/messages/:messageId` | 单条消息 |
| `POST /v1/messages` | 发消息，见下 |
| `POST /v1/attachments?name=<文件名>` | 上传附件，请求体是文件内容；返回 `attachment`，它的 ID 用在发消息的 `attachments` 里 |
| `GET /v1/messages/:messageId/attachments/:index` | 取回消息的附件 |

发消息 `POST /v1/messages`：

```json
{
	"senderMemberId": "M_...",
	"target": { "kind": "direct", "memberId": "M_..." },
	"text": "...",
	"mentions": ["M_..."],
	"attachments": ["<附件 ID>"]
}
```

- 群聊的 `target` 是 `{ "kind": "group", "groupId": "G_..." }`。
- `mentions` 只用于群聊，`"all"` 点名所有人。
- 一条消息最多 10 个附件，图片每张不超过 20 MB，其他文件不超过 50 MB。带了附件时 `text` 可以为空。

消息的 `external`：真人成员代发的外部事件是 `{ source, meta }`（来源和事件的 meta），其他消息是 `null`。这种消息只由外部事件的路由发出，接口发的消息没有。

## 群聊

| 接口 | 说明 |
|---|---|
| `GET /v1/groups` | 没解散的群聊 |
| `GET /v1/groups/:groupId` | 一个群聊 |
| `POST /v1/groups` | `{ "ownerMemberId": "...", "name": "...", "memberIds": [] }` 新建。只有创建者能加人、移出别人、解散，其他成员只能把自己移出 |
| `POST /v1/groups/:groupId/members` | `{ "requesterMemberId": "...", "add": [], "remove": [] }` 调整成员 |
| `POST /v1/groups/:groupId/dissolve` | `{ "requesterMemberId": "..." }` 解散 |
| `PUT /v1/groups/:groupId/members/:memberId/watching` | `{ "watching": true }` 设置 AI 成员是否关注这个群。关注只决定它什么时候被唤醒，是成员自己的设置，不需要 `requesterMemberId`；AI 成员自己用 `manage_group` 只能改自己的。状态变了时，在它的时间线里加一条群聊变动（`type` 是 `watched` 或 `unwatched`，`actorMemberId` 是 `null`，表示用户做的），让它知道 |

## 成员页

网页端成员页用的数据。分组是使用者自己整理列表用的，不进任何成员的上下文，见运行时设计第 8 部分「网页端的整理数据」。分组 ID 是 `L_` 开头。

| 接口 | 说明 |
|---|---|
| `GET /v1/member-overview` | 成员页每一行要显示的内容，见下 |
| `PUT /v1/members/:memberId/viewed` | `{ "itemId": 123 }`：使用者看到了这个 AI 成员时间线的哪一条。只往后记，比已记的小时不变。返回 `{ viewedThroughItemId }` |
| `GET /v1/member-sections` | 分组，按先后排：`sections`，每个 `{ sectionId, name, memberIds }` |
| `POST /v1/member-sections` | `{ "name": "..." }` 新建分组，排在最后。名字去掉首尾空白后不能为空、最多 20 个字、不能和已有的重复。返回 `{ section }` |
| `PUT /v1/member-sections/:sectionId` | `{ "name": "...", "memberIds": [] }`，都可以不给：改名，或者整个替换里面的成员。成员要存在、没有彻底删除；重复的只算一次。返回 `{ section }` |
| `DELETE /v1/member-sections/:sectionId` | 删除分组，里面的成员不受影响 |
| `PUT /v1/member-section-order` | `{ "sectionIds": [] }` 调整分组的先后，要正好列出全部分组。返回 `{ sections }` |

`GET /v1/member-overview` 返回 `members`，每个没有彻底删除的成员一项：

- AI 成员：`{ memberId, type: "ai", lastActivityAt, lastResult, hasNewResult }`
  - `lastActivityAt`：时间线最后一条的时间，没有时是 `null`。
  - `lastResult`：最近的结果，没有时是 `null`。发出的消息是 `{ kind: "message", at, target, text }`，`target` 和发消息的一样；直接输出是 `{ kind: "output", at, text }`。`text` 把空白合成一个空格，截到 100 字。
  - `hasNewResult`：使用者看到的那一条（`viewed`）之后，有没有新的结果。没看过时，有结果就算有。
- 真人：`{ memberId, type: "human", unreadCount, mentionCount, lastUnreadAt }`：它所有对话的未读数、其中点名它的数、最近一条未读消息的时间（没有未读时是 `null`）。

`?memberIds=a,b` 只算这几个成员（逗号分开，不认识的、彻底删除的不返回）。概览没有单独的事件：`timeline.appended`、`timeline.viewed` 来了补那个成员，`message.created` 补相关的成员，`conversation.read` 补读的那个真人，`member.changed` 补那个成员（新建的补进来，补取时没返回的是彻底删除了，从概览里去掉），只补变了的，不用重算全部。

## 定时

| 接口 | 说明 |
|---|---|
| `GET /v1/members/:memberId/reminders` | 成员的定时；`timeZone` 是运行时所在机器现在的时区 |
| `DELETE /v1/reminders/:reminderId` | 取消定时，在成员的时间线末尾追加一条变动说明，告诉成员定时已被取消，不唤醒成员 |

## 技能

| 接口 | 说明 |
|---|---|
| `GET /v1/skills` | 技能列表，不含正文，内置技能（包括覆盖内置的）在前，两组各按名字排；技能目录里和内置技能同名的 `overridesBuiltin` 是 `true`，新成员默认启用的 `defaultEnabled` 是 `true`；也列出读不出来的技能文件夹 |
| `GET /v1/skills/:name` | 一个技能：正文 `body`（SKILL.md 开头字段以后的原文）和文件夹里的其他文件 `files`（相对路径，不含隐藏文件） |
| `POST /v1/skills` | `{ "name": "...", "description": "...", "body": "..." }` 在技能目录里新建；和已有技能（包括内置技能）同名时报错 |
| `PUT /v1/skills/:name` | `{ "description": "...", "body": "..." }` 修改，SKILL.md 开头的其他字段原样保留 |
| `DELETE /v1/skills/:name` | 删除整个技能文件夹，也从新成员的默认技能里去掉（覆盖内置的技能删除后内置的还在，不去掉）。在用它的成员配置不变：还在用默认技能的成员先把当前的技能写进自己的 `member.json` |
| `PUT /v1/skill-defaults/:name` | `{ "enabled": true }` 设新成员是否默认启用这个技能；改之前还在用默认技能的成员先把当前的技能写进自己的 `member.json`。返回新的技能列表，和 `GET /v1/skills` 一样 |
| `GET /v1/skill-sources` | 常见的全局 agent 技能目录（`~/.agents/skills`、`~/.claude/skills`、`~/.codex/skills`）里的技能 |
| `GET /v1/skill-sources?path=<绝对路径>` | 这个文件夹里的技能：它本身是一个技能，或者每个子文件夹是一个技能 |
| `POST /v1/skills/import` | `{ "directory": "<技能文件夹>", "overwrite": false }` 把整个文件夹复制到技能目录，跳过隐藏文件和符号链接，最大 50 MB；已有同名技能时要 `overwrite: true` 才覆盖。把内置技能复制为自己的也用它 |

内置技能不能改、不能删。可导入的技能带 `problem`（不能导入的原因，没有时是 `null`）和 `exists`（技能目录里已有同名技能）。

## 自定义工具

| 接口 | 说明 |
|---|---|
| `GET /v1/custom-tools` | 自定义工具目录、`custom-tools.json` 的读取错误（`configError`，没有时是 `null`）、每一项的定义、配置和状态（`tools`），以及读不出来的文件夹（`issues`） |
| `PUT /v1/custom-tools/:name/config` | `{ "values": { ... } }` 整个替换这一项的配置：`text` 给字符串；`secret` 给字符串，`null` 沿用原来的；`service` 给 `{ "provider": "<供应商 ID>" }` 或 `{ "baseUrl": "...", "apiKey": "..." }`，`apiKey` 为 `null` 时沿用原来单独填的 key，`null` 是不配置。不检查必填，不全也能保存 |
| `PUT /v1/custom-tools/:name/disabled` | `{ "disabled": true }` 停用，`false` 启用。停用后调用都返回已停用，配置留着 |
| `DELETE /v1/custom-tools/:name` | 删除自定义工具目录里的文件夹（包括读不出来的）；配置留着 |

都返回新的 `GET /v1/custom-tools` 内容。每一项的 `values` 不给密钥原文：`secret` 和单独填的服务只给 `key: { set, undecryptable }`。`disabled` 为 `true` 的停用了。`problem` 是未配置的原因，没有时是 `null`；`undecryptable` 为 `true` 时有解不开的密钥，要重新填。`origin` 是 `builtin` 或 `own`，`overridesBuiltin` 为 `true` 的覆盖了同名的内置工具。

## MCP 服务器

| 接口 | 说明 |
|---|---|
| `GET /v1/mcp` | 配置文件路径、读取错误（没有时是 `null`），以及每个服务器的配置、状态和工具列表 |
| `PUT /v1/mcp/servers/:name` | 新建或修改：`{ "command": "...", "args": [], "env": {}, "cwd": null }`、`{ "url": "...", "headers": {} }` 或内置事件来源 `{ "builtin": "github", "env": {} }`（`github` 或 `feishu`）；`env`、`headers` 里值为 `null` 的沿用原来的值；不写 `disabled` 时沿用原来的 |
| `PUT /v1/mcp/servers/:name/disabled` | `{ "disabled": true }` 停用，`false` 启用。停用的不启动进程、不连接 |
| `DELETE /v1/mcp/servers/:name` | 删除 |
| `POST /v1/mcp/servers/:name/reconnect` | 重新连接；停用的报错 |

都返回新的 `GET /v1/mcp` 内容。服务器的 `env`、`headers` 只给名字，不给值；`undecryptableNames` 是加密保存、解不开的那些，要重新填写。状态是 `disabled`、`connecting`、`connected` 或 `failed`，失败时 `error` 写明原因。`channel` 为 `true` 的声明了 `claude/channel` 能力，是外部事件的来源（没连上过时是 `false`）。内置事件来源的 `builtin` 是 `github` 或 `feishu`，`transport` 是 `stdio`，`command` 是 `null`；其他服务器的 `builtin` 是 `null`。

## 外部事件

| 接口 | 说明 |
|---|---|
| `GET /v1/external` | 路由目录 `routesDirectory`、来源 `sources`、路由 `routes`，见下 |
| `GET /v1/external/log` | 事件日志，见下 |

`GET /v1/external` 的来源和路由：

- `sources`：是外部事件来源的 MCP 服务器（内置事件来源，和声明了 `claude/channel` 能力的），和路由的 `sources` 里写到的名字，按名字排。每项 `{ name, status, error, warning }`：
  - `status` 是 MCP 服务器的状态（`disabled`、`connecting`、`connected`、`failed`），另外有 `missing`（路由里写了，但没有这个 MCP 服务器）和 `not_channel`（连上了，但没声明 `claude/channel` 能力，不会推事件）。
  - `warning` 是来源最近的警告 `{ time, text }`：只算这次连上以后、24 小时以内的，没有时是 `null`。
- `routes`：每条路由 `{ name, code, sources, problem, lastRun }`，按名字排。
  - `sources` 是路由导出的来源；`problem` 是路由读不出来的原因（语法错误、`sources` 写得不对），这时 `sources` 为空。
  - `lastRun` 是这条路由最近一次处理事件的结果 `{ time, error }`，`error` 为 `null` 是正常；最近没处理过事件时是 `null`（运行时启动以来没处理过、日志里最近 1000 个事件里也没有）。

事件日志 `GET /v1/external/log`：

- 参数：`date` 哪一天（`YYYY-MM-DD`，默认最近有日志的一天）；`source` 只看这个来源的；`before` 只取这一天里这个位置之前的（上一页最后一条的 `offset`，翻页用）；`limit` 条数，默认 100，最多 500。
- 返回 `{ dates, date, entries, more }`：`dates` 是有日志的日期，新的在前；`entries` 是这一天的日志，新的在前，每项是日志的一行加上它在那天文件里的字节位置 `offset`；`more` 表示这一天还有更早的。
- 日志每行的内容见运行时设计第 10 部分「事件日志」：`type` 是 `event`（事件，带 `routes` 和 `deliveries`）、`duplicate`（重复推送）、`invalid`（格式不对）、`connected`、`disconnected`、`failed`、`warning`（来源的警告，`text` 是内容）。

路由不能通过接口修改，改路由文件的是成员（要审批）或用户自己。

## 浏览器

| 接口 | 说明 |
|---|---|
| `GET /v1/browser-blocklist` | 成员的浏览器禁止访问的网址：`{ "runtime": "127.0.0.1:6001", "hosts": ["example.com", "localhost:8888"] }`。`runtime` 是运行时网页端的地址，总是禁止，不在 `hosts` 里 |
| `PUT /v1/browser-blocklist` | `{ "hosts": [...] }` 整个替换。每项是主机名或 IP，可以带端口，也可以是整个网址（只取主机名和端口）；统一成小写，去掉重复。有一项不对时报错，什么都不改。返回和 GET 一样 |

## 本机文件

网页端预览运行时所在机器上的文件用。`path` 都要完整路径，相对路径报错。Windows 的网络路径（`\\server\share`）也报错：一读就连到那台机器、交出当前用户的登录凭据，而链接可能是模型照着网页写的。

| 接口 | 说明 |
|---|---|
| `GET /v1/files?path=<完整路径>` | 文件的信息：`{ "path": "...", "name": "report.md", "kind": "file", "size": 1234, "modifiedAt": 1730000000000, "mime": "text/markdown" }`。`kind` 是 `file` 或 `directory`（文件夹没有 `size`、`mime`）；`mime` 按扩展名定，认不出的看开头：是文字时 `text/plain`，否则 `application/octet-stream`。不存在、没有权限时报错 |
| `GET /v1/files/content?path=<完整路径>` | 文件内容，支持 `Range`（视频、音频拖进度，大文本只取开头）；带 `download=1` 时作为附件下载 |

- 能读运行时这个系统用户能读的文件：令牌等于这个用户的完整权限，单独限制这个接口没有意义。
- 运行时的令牌和密钥、成员浏览器的数据、数据库（运行时设计「保护运行时的数据」里的敏感文件）不返回（403）：不是给人看的，也免得一点开就把令牌显示在屏幕上。
- 内容不能在网页端的源里当网页执行：都带 `X-Content-Type-Options: nosniff`；HTML、XML（里面可以写 XHTML 的脚本）按 `text/plain` 返回（网页端拿文字放进沙箱显示）；SVG 带 `Content-Security-Policy: sandbox`，在 `<img>` 里照常显示，直接打开时脚本拿不到网页端的登录状态。消息和直接说话的附件、资源文件、头像也一样：它们可能是成员写的文件。
- Cookie 是 SameSite=Strict，别的网站引用这个地址时不带 Cookie，读不到；成员的浏览器带标记头，一律拒绝（见「约定」）。

## Git 仓库

网页端工作台的 Git 标签用，只读：看分支、改动、提交历史和 diff，不暂存、不提交、不切分支、不获取远程。要动手时在终端里自己用 git。`path` 的要求和「本机文件」一样：完整路径，不接受网络路径。

| 接口 | 说明 |
|---|---|
| `GET /v1/git/repository?path=<完整路径>` | 这个目录在不在 Git 仓库里：`{ "available": true, "repository": { "root": "E:/work/app", "branch": "main" } }`。不在仓库里时 `repository` 是 `null`；找不到 git 时 `available` 是 `false`。目录卡片用，只跑一条很快的命令 |
| `GET /v1/git/status?path=<仓库根目录>` | 分支和改动，见下 |
| `GET /v1/git/log?path=<仓库根目录>&before=<提交>&limit=50` | 当前分支的提交历史，从新到旧：`{ "commits": [...] }`。只沿第一个父提交走（合并进来的分支上的提交不列，合并提交本身列），是一条线，翻页不漏不重。`before` 是上一页最后一个提交的哈希，取它之前的；`limit` 最多 200。每个提交：`{ "hash", "parents": [], "author", "email", "authoredAt", "subject" }`，`authoredAt` 是毫秒。空仓库时是空列表 |
| `GET /v1/git/commits/:hash?path=<仓库根目录>` | 一个提交：完整的提交说明（`message`）和改了哪些文件（`files`，写法同下面的改动） |
| `GET /v1/git/diff?path=<仓库根目录>&file=<相对路径>&area=<哪里>` | 一个文件的 diff。`area` 是 `staged`（已暂存，和 HEAD 比）、`unstaged`（工作区和暂存区比）、`untracked`（整个文件都是新增，运行时直接读文件）、`commit`（要再带 `commit=<哈希>`，和它的第一个父提交比，第一个提交和空的比）。改名、复制的文件再带 `oldPath=<原来的相对路径>`，两个一起比才看得出是改名。`file`、`oldPath` 不能是完整路径，也不能跑出仓库。返回 `{ "diff": "统一 diff 的文字", "binary": false, "truncated": false }`。运行时的令牌、密钥这些敏感文件和「本机文件」一样不给看（403） |

`status` 返回：

- `branch`：当前分支名；不在任何分支上时是 `null`，`head` 写当前提交（`{ "hash", "subject" }`，空仓库时是 `null`）。
- `upstream`：跟踪的远程分支，`{ "name": "origin/main", "ahead": 2, "behind": 0 }`；没有时是 `null`。领先、落后是和上次获取远程时比的，运行时不获取（获取会改本地记的远程分支，算写操作）。
- `fetchedAt`：上次获取远程的时间（`FETCH_HEAD` 的修改时间，毫秒），没获取过是 `null`。
- `state`：仓库正在 `merging`、`rebasing`、`cherry-picking`、`reverting`、`bisecting`，没有时是 `null`。
- `changes`：`conflicted`（有冲突）、`staged`、`unstaged`、`untracked` 四组，按路径排。每个文件 `{ "path", "oldPath", "status", "added", "removed", "binary" }`：`status` 是 `added`、`modified`、`deleted`、`renamed`、`copied`、`typeChanged`；`oldPath` 只有改名、复制时有；未跟踪的文件没有行数。一个文件可以同时在已暂存和未暂存里。
- 改动太多时每组最多 1000 个，`truncated` 为 true。

怎么跑 git：

- 用命令行的 git（2.31 以上），参数逐个传，不经过 shell。找 git：PATH 里的 `git`；Windows 上还看 Git for Windows 的安装目录和运行时装的 PortableGit（`cmd/git.exe`），和找 Git Bash 的地方一样；其他系统还看 `/usr/bin`、`/usr/local/bin`、`/opt/homebrew/bin`。去掉 `GIT_DIR` 这类环境变量，不然 git 会去看别的仓库。
- 不碰锁：带 `--no-optional-locks`。`git status` 平常会顺手刷新索引、短暂锁住仓库，成员这时在用 git 就会报「另一个 git 进程在运行」。
- 不执行仓库里配置的程序：这些命令在沙箱外、以使用者的身份运行，成员在沙箱里能改仓库的配置，不关掉的话打开面板就会执行它写进去的程序。所以带 `-c core.fsmonitor=false`；diff 带 `--no-ext-diff --no-textconv`；仓库里配的过滤器（`filter.<名字>.clean`、`smudge`、`process`）先读出名字，再用 `GIT_CONFIG_COUNT` 全部换成空的，`required` 也关掉；`-c log.showSignature=false` 不验签名（会执行配置的 gpg 程序）；子模块带 `--ignore-submodules=dirty`，不进子模块看工作区。
- 不连网：`-c protocol.allow=never`，`GIT_NO_LAZY_FETCH=1`（部分克隆的仓库缺对象时不去远程取）。
- 不等输入：`GIT_TERMINAL_PROMPT=0`。路径按原样输出：`-c core.quotepath=false`，列表用 `-z` 分隔；给的路径按字面匹配（`GIT_LITERAL_PATHSPECS=1`），文件名里的 `*` 不当通配符。
- 每条命令最多 15 秒，超时报错，连同它启动的进程一起结束；diff 最多 5000 行或 1 MB，超出的截掉，`truncated` 为 true。同时跑的几条命令都结束了才返回，有一条出错也等其他的结束，不留在后面占着仓库。
- git 自己报的错（如「detected dubious ownership」）原样返回，网页端照着显示，代码是 `git_error`（400）；超时是 `git_timeout`，输出大得异常是 `git_output_too_large`，找不到 git 是 `git_unavailable`。仓库的文件夹不在了时是 404。

## 终端、PortableGit 和沙箱

| 接口 | 说明 |
|---|---|
| `GET /v1/terminals` | 全部终端 |
| `POST /v1/terminals` | `{ "cwd": "...", "createDirectory": true }` 新建，`cwd` 不填时用用户目录。前端建的终端一开始由用户操作。运行中的终端最多 16 个，已退出的不算。`cwd` 不存在、但上级目录存在时：没带 `createDirectory` 报错，代码是 `directory_missing`，网页端据此请用户确认；带了就先建这一级文件夹。只建最后一级，上级目录也不存在时照常报错。AI 建终端不会自动建文件夹 |
| `GET /v1/terminals/:terminalId/screen` | 屏幕快照；之后的输出由事件流的 `terminal.output` 推送。运行时在 Windows 上时带 `windowsPty`（`backend`、`buildNumber`），前端的 xterm.js 照着设置；其他系统是 `null`。终端查询由运行时回复，前端的 xterm.js 不要回复 |
| `POST /v1/terminals/:terminalId/input` | `{ "data": "..." }` 输入 |
| `POST /v1/terminals/:terminalId/resize` | `{ "cols": 100, "rows": 30 }`。只用于前端建的终端；AI 成员建的终端尺寸固定，改大小报错 |
| `POST /v1/terminals/:terminalId/takeover` | 用户接管成员的终端，这时成员只能读不能输入 |
| `POST /v1/terminals/:terminalId/release` | 交给 AI 成员：唤醒在等这个终端的成员；没人在等时给建它的成员记一条不唤醒的，见运行时设计「终端的接管」 |
| `POST /v1/terminals/:terminalId/close` | 关闭。已退出的终端不会自动清除，留到关闭为止 |
| `GET /v1/portable-git` | PortableGit 的安装状态，以及当前用的 shell |
| `POST /v1/portable-git/install` | 开始下载安装，进度由 `portableGit.progress` 推送 |
| `POST /v1/portable-git/cancel` | 取消安装 |
| `GET /v1/remote` | 公网访问：`{ "enabled": false, "hostname": null, "hostnames": [], "tokenTail": null, "cloudflaredPath": null, "cloudflared": { "kind": "missing" }, "process": { "kind": "off", "error": null }, "origin": "http://127.0.0.1:6001", "lastOrigin": null }`。`cloudflared.kind` 是 `missing`、`downloading`（带 `receivedBytes`、`totalBytes`）、`ready`（带 `version`、`path`）、`unsupported`、`failed`（后两个带 `reason`）；`process.kind` 是 `off`、`starting`、`connected`、`error`（带 `error`）；不带 cloudflared 的输出，配的时候有问题去看数据目录的 `cloudflared.log`；`origin` 是在 Cloudflare 后台 Public Hostname 里要填的服务地址；`lastOrigin` 是上次真连上时用的那个，和 `origin` 不同时说明端口或域名改过；`hostnames` 是隧道之外还接受的域名（Tailscale serve 的 ts.net 域名之类），和隧道开关无关。带令牌的链接不在这里，见下面的 `POST /v1/remote/link` |
| `PUT /v1/remote` | `{ "hostname": "reman.example.com" }`、`{ "hostnames": ["reman.tail1234.ts.net"] }`、`{ "token": "..." }`、`{ "cloudflaredPath": "..." }`、`{ "enabled": true }`，只改给出的那几项。`hostname` 只收域名（小写字母、数字、横杠、点，不能是 localhost 或 IP），`null` 清空；`token` 加密保存，不回显；`cloudflaredPath` 是已有的 cloudflared 的绝对路径，`null` 清空。打开开关前主机名和 token 都要有；域名格式不对时报错，什么都不改。`hostnames` 收数组，也收逗号或空格分开的一串，每个都是域名（不收 IP、localhost），去重；空数组清空。网页端只填一个（Tailscale 那个域名），写多个是给接口用的。返回和 GET 一样 |
| `POST /v1/remote/install` | 下载 cloudflared：固定版本，下载后核对大小和 SHA-256；进度看 `remote.changed` 事件后重新 GET |
| `POST /v1/remote/link` | `{ "url": "https://reman.example.com/#token=..." }`：手机上打开一次的带令牌链接。不带令牌的状态里没有它，用户点了「复制链接」或「显示二维码」时才要。带 `{ "host": "reman.tail1234.ts.net" }` 时给 `hostnames` 里那个域名的链接，域名不在名单里时报错 |
| `GET /v1/sandbox` | 沙箱：`{ "enabled": true, "state": { "kind": "ready" }, "installed": true, "problems": [{ "directory": "...", "reason": "..." }] }`。`state.kind` 是 `off`、`checking`、`installing`（`granting` 为 true 时用户已在系统窗口里允许，正在授权读用户目录）、`uninstalling`、`notInstalled`、`ready`、`unsupported`、`failed`（后两个带 `reason`）；`installed` 是 Windows 上装好了；`problems` 是沙箱能用时放不进沙箱的工作目录；`network` 是沙箱里的命令能连哪些地址：`{ "mode": "allow", "hosts": ["github.com"] }`，`mode` 是 `none`、`all`、`allow`、`deny`；`networkProblem` 是 `sandbox.json` 里的网络设置写错的原因，这时照不允许处理，没有错时是 null |
| `PUT /v1/sandbox` | `{ "enabled": true }` 打开或关上。打开时 Windows 上没装过就开始安装；正在安装或卸载时报错。`{ "network": ... }` 整个替换网络设置：`"all"`、`"none"`、`{ "allow": [...] }` 或 `{ "deny": [...] }`，每项是主机名或 IP，可以带端口，也可以是整个网址（只取主机名和端口）；统一成小写，去掉重复；有一项不对或是本机地址时报错，什么都不改。返回和 GET 一样 |
| `POST /v1/sandbox/install` | Windows 上开始安装，会弹系统的确认窗口 |
| `POST /v1/sandbox/uninstall` | Windows 上开始卸载，会弹系统的确认窗口；卸载后开关是关 |

## 事件流

`GET /v1/events` 是 SSE。每条事件的 `event` 是类型，`data` 是 JSON。事件只说明「什么变了」，前端需要细节时再查询。

- 有编号的事件带 `id: <epoch>:<revision>`。断线重连时用 `Last-Event-ID` 或 `?after=<epoch>:<revision>` 说明收到了哪里，运行时补发之后的事件；两个都有时认 `Last-Event-ID`：浏览器自己重连时地址不变，`after` 还是上次打开时的位置。运行时重启过（`epoch` 变了）或者补不回来时，先发一条 `resync`，前端应重新拉取状态。
- 连上就发出响应头；每 15 秒发一次心跳注释。
- 一条连接积压的、还没发出去的数据超过 8 MB 时，运行时断开它；客户端照常重连，按上面补发或收到 `resync`。

有编号的事件：

| 类型 | 说明 |
|---|---|
| `member.changed` | 成员变了，包括它的记忆变了（`memberId`） |
| `memberFolders.changed` | 成员文件夹的读取结果变了 |
| `skills.changed` | 技能目录里的文件变了，或者新成员的默认技能变了 |
| `customTools.changed` | 自定义工具目录里的文件或 `custom-tools.json` 的配置变了 |
| `mcp.changed` | MCP 服务器的状态或工具变了 |
| `external.changed` | 事件日志新写了一行，或者路由目录里的文件变了 |
| `models.changed` | 模型配置变了 |
| `toolDefaults.changed` | 新成员的工具默认设置变了 |
| `browserBlocklist.changed` | 成员浏览器禁止访问的网址变了 |
| `tools.changed` | 成员的工具设置变了（`memberId`） |
| `group.changed` | 群聊变了（`groupId`） |
| `memberSections.changed` | 成员页的分组变了 |
| `timeline.viewed` | 使用者看到的位置变了（`memberId`） |
| `plan.changed` | 成员更新了计划，或者用户清空了计划（`memberId`） |
| `message.created` | 新消息（`messageId`、`conversation`、相关成员 `memberIds`） |
| `conversation.read` | 成员读了对话（`memberId`、`conversation`） |
| `timeline.appended`、`timeline.updated` | 时间线新增或更新了条目（`memberId`、`itemIds`） |
| `run.changed` | 运行开始或结束（`memberId`、`runId`） |
| `approval.changed` | 审批请求新增或处理了（`memberId`、`approvalId`） |
| `task.changed` | 后台任务变了（`memberId`、`taskId`） |
| `codeCall.changed` | `run_tool_script` 的脚本里的一次调用变了（`memberId`、`runId`、`callId`、`callIndex`） |
| `reminder.changed` | 定时新建、修改、取消或触发了（`memberId`） |
| `terminal.changed` | 终端变了（`terminalId`） |
| `portableGit.changed` | PortableGit 的安装状态变了 |
| `sandbox.changed` | 沙箱的开关、状态或放不进沙箱的工作目录变了；`shell` 工具的说明、参数和审批方式的写法跟着变 |

没有编号、只推给当前连着的前端、不补发的增量。其中 `member.activity` 和 `run.delta` 在连上时（包括重连）先补一次现在的样子：每个正在运行的成员一条 `member.activity`，正在流式输出的那次请求每种一条 `run.delta`，`delta` 是这次尝试到目前为止的全部内容。前端重连时先清掉已有的流式内容，再按收到的接上，断线期间的输出就不会缺一截。之后照常推增量。

| 类型 | 说明 |
|---|---|
| `run.delta` | 模型流式输出的增量（`memberId`、`runId`、`requestId`、`attempt`、`kind` 是 `text` 或 `reasoning`、`delta`）。`attempt` 是这次请求的第几次尝试，从 1 开始：自动重试时模型从头输出，`attempt` 变了就从头接。这次请求的输出进入时间线后，时间线条目的 `requestId` 和它相同。压缩请求只推 `reasoning`，压缩结束后它在压缩记录的 `requests` 里，`requestId` 相同 |
| `member.activity` | 正在运行的成员换了一步，或者请求模型时开始输出另一项（`memberId`、`activity`，运行结束时是 `null`） |
| `terminal.output` | 终端的原始输出（`terminalId`、`seq`、`data`）。前端拿屏幕快照后，丢掉序号不大于快照的增量 |
| `call.output` | 执行中的 `shell` 调用有新输出（`memberId`、`runId`、`callId`），每个调用每秒最多一次。只说有新输出，不带内容，要看时用 `GET /v1/runs/:runId/calls/:callId/output` 取。做成增量不占编号：长命令一直在输出，占编号会很快挤掉补发用的缓冲 |
| `portableGit.progress` | PortableGit 的下载进度（`receivedBytes`、`totalBytes`） |
