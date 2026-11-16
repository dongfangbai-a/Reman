---
name: create-custom-tool
description: 新建、修改或删除自定义工具。
---

# 创建自定义工具

自定义工具是一个文件夹，包含 `tool.json` 和脚本。`tool.json` 声明工具的名称、说明、参数和需要用户填写的配置；工具被调用时，运行时启动一个进程执行脚本，通过标准输入传入参数和配置，脚本把结果写到标准输出。

- 自定义工具目录：`{{custom_tools_directory}}`。在其中新建、修改、删除文件均须用户批准。
- 内置自定义工具目录：`{{builtin_custom_tools_directory}}`。其中的网络搜索 `web` 和图片生成 `generate_image` 可作参考，不要修改。

## 文件夹

一个文件夹是一项自定义工具，作为一个整体管理：

- 启用：成员文件 `member.json` 的 `tools` 中写 `custom:<文件夹名>`，文件夹里的工具同时启用或停用。
- 审批方式：按文件夹设置，文件夹里的工具相同。
- 配置：按文件夹填写，文件夹里的工具共用。

因此，只有需要统一启用、统一审批、共用配置的工具才放进同一个文件夹，例如 `web` 中的 `web_search` 和 `web_fetch`。经常配合使用、但应当分别启用或分别审批的工具，各建一个文件夹。

文件夹名只能包含小写字母、数字和下划线，最长 64 个字符。只有一个工具时，文件夹名与工具名相同，如 `generate_image`；有多个工具时，取一个概括这组工具的名称，如 `web`。

与内置自定义工具同名时，使用自定义工具目录中的版本。修改内置工具时，先将整个文件夹复制到自定义工具目录，再修改副本；删除副本即恢复使用内置版本。

## tool.json

示例：文件夹 `query_weather`，调用一个需要 API key 的天气接口。

```json
{
	"label": "天气查询",
	"description": "和风天气接口的天气查询工具",
	"defaultPolicy": "allow",
	"config": [
		{ "name": "apiKey", "type": "secret", "label": "API key", "required": true }
	],
	"tools": [
		{
			"name": "query_weather",
			"label": "查询天气",
			"description": "查询指定城市的实时天气。",
			"parameters": {
				"type": "object",
				"properties": { "city": { "type": "string", "description": "城市名称" } },
				"required": ["city"],
				"additionalProperties": false
			},
			"script": "weather.ts"
		}
	]
}
```

顶层字段：

- `label`：网页端显示的名称。
- `description`：选填，网页端显示的说明，写明调用的接口及工具的用途。
- `defaultPolicy`：审批方式，`ask`（每次调用都需用户审批）或 `allow`（无需审批），默认 `ask`。只读取数据且不产生费用的工具可以用 `allow`；会修改数据、发送消息或产生费用的工具用 `ask`。
- `config`：选填，需要用户填写的配置项，见「配置」。
- `tools`：工具列表，至少一个。

`tools` 中每个工具的字段：

- `name`：工具名，只能包含小写字母、数字和下划线，须以字母开头，最长 64 个字符，不能与内置工具或其他自定义工具重名。采用「动词_名词」形式，如 `query_weather`、`generate_image`。
- `label`：动词开头的短说明，如「查询天气」；网页端在工具执行时显示「正在查询天气」。
- `description`：给模型的说明，用一句话写明工具的作用。
- `parameters`：参数，JSON Schema，`type` 为 `object`。每个参数的 `description` 写明含义、格式和取值限制，使用准确的术语，如「生成图片的提示词」，而不是「要画什么」。工具只是转发某个接口时，参数名和取值与该接口保持一致。
- `returns`：选填，在 `run_tool_script` 脚本中调用时的返回类型，TypeScript 写法，如 `{ city: string; temperature: number }`。写了 `returns` 时，脚本须输出 `structuredContent`；不写时，脚本中得到的返回值为 `{ text: string; images: InputImage[] }`。
- `script`：执行的脚本，文件夹中的 `.js`、`.mjs` 或 `.ts` 文件，由运行时自带的 Node 执行。使用其他语言时不写 `script`，改写 `command`，如 `["python", "query.py"]`，命令须在 PATH 中；Windows 上 `npx`、`pnpm` 这类 `.cmd` 命令也能执行。两者须写且只能写一个。
- `timeoutSeconds`：选填，最长运行时间（秒），默认 300，最大 7200。超过 30 秒的调用会转为后台任务。
- `progressive`：选填，为 `true` 时是渐进式工具：不直接提供给模型，只在 `more_tools` 中列出，需通过 `more_tools` 查看和调用。适用于不常用或说明很长的工具。

`tool.json` 中出现无法识别的字段时报错。

## 配置

脚本需要、但应由用户提供的值，如 API key、模型名，在 `tool.json` 的 `config` 中声明，不要写进脚本或 `tool.json`。固定不变的值（如接口地址）直接写在脚本中。不需要用户提供任何值的工具省略 `config`。

用户在网页端「设置 → 自定义工具」中填写配置。填写的值保存在数据目录（自定义工具目录的上一级）的 `custom-tools.json` 中，位置是 `<文件夹名>.values.<配置项名>`，`secret` 类型的值加密保存。该文件由运行时管理，不要修改。

工具被调用时，运行时把配置值放在标准输入的 `config` 中交给脚本，键为配置项的 `name`。未填写的选填项不包含在内；设了 `default` 的项未填写时取默认值。

配置项的字段：

- `name`：配置项名，只能包含英文字母、数字和下划线，且不能以数字开头。
- `type`：`text`、`secret` 或 `service`，见下。
- `label`：网页端表单中的名称。
- `description`：选填，网页端表单中的提示。
- `required`：是否必填。必填项未填写时，调用直接返回「自定义工具 <文件夹名> 不可用：缺少<label>」，不运行脚本。
- `default`：选填，默认值，仅适用于 `text` 类型。

类型：

- `text`：字符串，如模型名。
- `secret`：字符串，用于 API key、令牌等密钥，加密保存，网页端不显示已保存的值。
- `service`：一组接口地址和 API key。仅当工具调用的接口由模型供应商提供、与模型请求使用同一个地址和 key 时使用，如 OpenAI 的生图接口、DeepSeek 的搜索接口。用户可以选择模型配置（数据目录的 `models.json`）`providers` 中的一个供应商，运行时取它的 `baseUrl` 和 `apiKey`；也可以单独填写地址和 key。脚本收到 `{ "baseUrl": "https://api.example.com", "apiKey": "..." }`，`baseUrl` 不含 `/v1`。接口与模型供应商无关时不使用 `service`，key 用 `secret`。

## 脚本

标准输入是一段 JSON：

```json
{ "arguments": { "city": "杭州" }, "config": { "apiKey": "..." }, "workingDirectory": "<成员的工作目录>", "outputDirectory": "<存放文件的目录>" }
```

- `arguments`：模型调用工具时传入的参数。
- `config`：配置值，见「配置」。
- `workingDirectory`：调用工具的成员的工作目录。
- `outputDirectory`：这个工具存放文件的目录，在数据目录的 `tool-outputs/custom/<文件夹名>/`，调用前已建好。需要把内容存成文件时（如过长结果的完整内容）写在这里，并在结果中写明路径。

结果写到标准输出，格式与 MCP 工具的结果相同：

```json
{ "content": [{ "type": "text", "text": "杭州：晴，18°C" }] }
```

- `content` 中只能包含文字 `{ "type": "text", "text": "..." }` 和图片 `{ "type": "image", "data": "<base64>", "mimeType": "image/png" }`。图片由运行时保存为文件，结果中写明文件路径。
- 写了 `returns` 时，另加 `"structuredContent"`，值符合 `returns` 的类型。
- 结果的文字超过 2 万字时，运行时只保留开头 1.5 万字和结尾 5 千字，完整内容存成 `outputDirectory` 下的文件；图片最多附上 10 张。结果可能很长时（如网页、文档），由脚本自行截取到 2 万字以内，把完整内容存到 `outputDirectory`，在结果中写明路径，参考内置的 `web_fetch`。
- 出错时加 `"isError": true`，文字即提供给模型的错误原因。把接口返回的错误转换为明确的说明，使模型能判断是否应重试，如「返回 401：API key 无效」「返回 429：请求过于频繁，请稍后重试」。
- 退出码不为 0，或标准输出不是上述格式时，运行时按出错处理，并附上标准错误输出的最后几行。调试信息写到标准错误，不要写到标准输出。

运行环境：

- 工具在沙箱外运行，进程的工作目录是工具文件夹。读写成员的文件时使用 `workingDirectory`。
- 环境变量只有系统基本的几个，如 `PATH`、`HOME`、`TEMP`。密钥从 `config` 读取。
- 访问网络使用 Node 自带的 `fetch`。运行时自带的 npm 包（如 `openai`）通过 `createRequire` 取得：

  ```ts
  import { createRequire } from 'node:module';
  const require = createRequire(import.meta.url);
  const { OpenAI } = require('openai') as typeof import('openai');
  ```

  需要其他 npm 包时，在工具文件夹中安装。

## 试跑

编写完成后，通过管道将一段输入传给脚本，检查输出：

```bash
echo '{"arguments":{"city":"杭州"},"config":{"apiKey":"test"},"workingDirectory":".","outputDirectory":"."}' | node weather.ts
```

使用虚构的 key 可检查参数校验和出错时的输出。命令在沙箱中运行时可能无法访问外网；实际调用接口需等用户填写配置。

完成后告知用户：在「设置 → 自定义工具」中填写配置，并在成员设置中为需要的成员启用这个工具。`tool.json` 有误、脚本不存在或工具名重复时，该页面会显示原因。

## 修改和删除

- 修改：直接修改文件，立即生效。工具名或参数改变后，启用了该工具的成员在下次请求时会收到工具变动的说明。
- 删除：删除整个文件夹。用户填写的配置会保留，重新创建同名文件夹后继续生效。成员文件中的 `custom:<文件夹名>` 不需要删除。
