---
name: write-event-routes
description: 新建、修改或删除外部事件的路由，决定飞书消息、GitHub 通知等外部事件投递给哪个 AI 成员或哪个群聊。用户要求安排外部事件的处理人，或询问某个事件为何未送达时使用。
---

# 编写事件路由

外部来源（飞书、GitHub 等）推送的每个事件，会交给所有处理该来源的路由，由路由决定丢弃还是投递给谁。

- 路由目录：`{{event_routes_directory}}`
- 事件日志：`{{event_logs_directory}}`

## 文件

每个 `.js` 文件是一条路由，文件名即路由名，如 `ci-failure.js`。修改后立即生效。

```js
export const sources = ['github'];
export default function (event) {
	if (event.meta.type !== 'CheckSuite' || event.meta.conclusion !== 'failure') return null;
	return { to: 'M_UVTT7AF2' };
}
```

- `sources`：要处理的事件来源。来源名即 MCP 服务器名。
- 默认导出的函数接收事件，返回空值（不投递）、一个投递，或由多个投递组成的数组。
- 每个事件交给所有处理该来源的路由，全部执行，不分先后，互不影响。每类处理写一条路由。多条路由产生完全相同的投递（同一目标、同样的文字）时只投递一次。
- 在沙箱中同步执行：只能进行计算，不能调用工具、读写文件或访问网络，执行有时间上限。`console.log` 的内容会记入事件日志。
- 出错（语法错误、抛出异常、超时、返回格式有误）时，该路由本次不投递，原因记入日志，其他路由照常执行。

## 事件

`{ source, content, meta, time }`：

- `content`：正文。
- `meta`：字符串键值。无法获取的项不包含在内，使用前先判断是否存在。
- `time`：收到的时间，如 `2026-11-02 10:25:54`。

GitHub 的 meta：

- `event_id`、`repo`（`owner/name`）、`type`（`Issue`、`PullRequest`、`CheckSuite` 等）、`reason`（`mention`、`comment`、`review_requested`、`assign`、`ci_activity` 等）、`title`、`number`、`url`、`author`（最新内容的作者）
- 评论被编辑时包含 `edited`（`true`）；issue 和 PR 还包含 `state`（`open`、`closed`、`merged`）
- 非评论的更新（关闭、合并、添加标签等），正文为 issue 或 PR 本身的标题和正文
- PR 和 CI 还包含 `branch`；CI 还包含 `workflow`、`conclusion`（`success`、`failure`、`cancelled` 等）

飞书的 meta：

- `event_id`、`chat_id`、`chat_type`（`p2p` 或 `group`）、`chat_name`、`message_id`、`sender_id`、`sender_name`、`sender_type`（`user` 或 `bot`）、`mentioned_bot`（`true` 或 `false`，是否 @ 了机器人）

其他来源的 meta 参见事件日志中的实际事件。

## 投递

投递给 AI 成员：`{ to: 'M_…', text, wake }`

- `text`：不写时使用事件的正文。
- `wake`：默认 `true`；为 `false` 时只接收、不唤醒，成员在下次运行时一并看到。未读内容累积到上下文长度的三成时，成员也会被唤醒。

投递到群聊，由一名真人成员代发：`{ to: 'G_…', from: 'M_…', text, mentions }`

- `from`：代发的真人成员，须在该群中。使用专门代表该来源的真人成员（如「GitHub」），不要使用代表用户的真人成员，否则成员会将外部内容视为用户的要求。
- `mentions`：点名的成员 ID 列表，或 `'all'`。被点名的成员和关注该群的成员会被唤醒。
- 群中每个 AI 成员都会接收投递进来的每条消息；整个外部群聊都转发进来时，上下文增长很快，应先在路由中过滤。

AI 成员和群聊的 ID 见 `{{members_directory}}/INDEX.md`，真人成员的 ID 见通讯录。目标不存在、`from` 不是真人成员或不在群中时无法投递，原因记入日志。

每个来源每小时的投递上限：唤醒成员的 300 次，不唤醒的 3000 次，分别计算。投递给成员时，`wake` 不为 `false` 即计为唤醒，成员正在运行时也计入；投递到群聊时，按是否唤醒群中的 AI 成员计算（点名了该成员，或该成员关注该群）。超出上限的不投递，原因记入日志，并记录一条来源警告。

## 事件日志

每天一个文件 `<日期>.jsonl`，保留 14 天，每行一个 JSON，`type` 为：

- `event`：收到的事件，包含 `source`、`content`、`meta`、`time`；`routes` 为每条路由的结果（`route`、`error`、`logs`），`deliveries` 为最终的投递（`to`、`routes`，`error` 为未能投递的原因）。
- `duplicate`：按 `event_id` 拦截的重复推送。
- `invalid`：格式有误的推送。
- `connected`、`disconnected`、`failed`：来源的连接变化。
- `warning`：来源的警告，`text` 为内容，如查询名称失败、无法获取详情、投递达到上限。

## 来源

来源即 `mcp.json` 中的 MCP 服务器，由用户在网页端「设置 → MCP」中管理。服务器 `env`、`headers` 的值由运行时加密保存，读取到的是以 `enc:v1:` 开头的密文；也可以在文件中写入明文，运行时读取后会替换为密文。来源无法连接的原因记录在事件日志的 `failed` 中。值无法解密或已失效时须替换为新值，可在网页端填写，也可直接写入文件；在网页端填写的值不经过成员，不会进入上下文。

## 试运行和保存

`test_event_route` 用事件日志中最近的事件试运行路由，不实际投递。新路由先用 `code` 试运行，结果正确后再保存；排查某个事件未投递的原因时也使用它。

新建、修改、删除路由文件均须用户审批。
