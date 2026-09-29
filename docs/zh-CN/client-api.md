# 客户端 API 参考

[English](../en/client-api.md) | 简体中文

本文说明代理的 Chat Completions API 与兼容行为。安装方法见[中文 README](README.md)。示例使用 `--agent-service-model` 启用的 agent-service profile。

## 鉴权

默认 `--auth-mode reuse` 复用现有 Codex 鉴权，但不会发起登录或退出。子 Codex 使用代理专属 home，默认为 `~/.codex-openai-proxy/codex-home`，可用 `--codex-home` 修改。启动时依次从 `--auth-source`、`$CODEX_HOME` 或普通本地 Codex home 复制严格更新的 `auth.json`；`--sync-auth never` 保留已经准备好的隔离凭据。桥接不会写回来源，也不会同步个人 Codex 配置。鉴权缺失或无效时会返回可操作错误；在本地重新登录后重启即可。隔离 home 中的自定义 provider 配置不会被覆盖。

显式 `--auth-mode independent` 使用完全独立的登录，并可自行恢复失败登录。通过 `--login <auto|device-code|browser>` 选择流程：

- `auto`：stderr 是 TTY 时使用交互式浏览器登录，否则使用 device-code。
- `browser`：强制交互式浏览器登录；无法启动浏览器时使用 stderr 输出的授权 URL。
- `device-code`：在 stderr 输出验证 URL 与一次性代码，适合容器、服务、CI 和远程终端。

登录完成前，补全请求返回 `app_server_not_ready`，`/ready` 返回 503。登录期限固定为 5 分钟。授权 URL 和 device code 都应视为凭据；明文日志可能包含它们。ChatGPT refresh token 只能使用一次，并发使用同一登录的副本可能使其中一个失效；需要隔离时使用 independent 模式。删除代理 home 中的登录只会让代理退出，不影响 Codex CLI 自己的会话。

### 临时 Responses Lite 覆盖

固定的 Codex `0.155.1` 运行时启动时安装临时模型目录覆盖，使声明的客户端函数保持为直接 Responses 工具，而不是嵌套 code-mode 回调。启动会在不产生模型 turn 的情况下刷新目录；失败时保留此前可用缓存。目录在该代理进程生命周期内保持固定。实现与升级影响见 [Codex 兼容性](compatibility.md#临时模型目录覆盖)。

## 指令配置

每个新的 Chat Completions 请求都会把 transcript 中的客户端 `system` 消息按顺序用空行连接，作为 Codex `baseInstructions`。没有 system 消息时发送空字符串。这会替换该 thread 的 Codex 默认基础提示词与 `model_instructions_file`；Codex 运行时指令、工具定义、项目指令和托管策略仍会生效。

鉴权同步只复制 `auth.json`。代理 home 中的配置、请求工作目录加载的指令文件及可信项目的 `.codex/config.toml` 仍会影响请求。home 隔离不等于隔离项目指令或托管策略。

system 消息不会通过 `thread/inject_items` 注入，因为已由 `baseInstructions` 提供；客户端 developer 消息仍保留为 developer 历史，其他历史保持内容和顺序。Codex 会把基础指令表示为上游 developer 指令，因此代理不保证 system 与 developer 之间额外的优先级。

原生 thread 续写保留已有基础指令与历史。续写 transcript 中的新 system 消息不会修改该 thread，包括重启后的续写。要修改指令，请去掉 `previous_response_id`，并避免通过隐式待处理工具结果续写，发送一个新请求。

## 使用 OpenAI 客户端

将 OpenAI 兼容客户端指向 `http://127.0.0.1:8787/v1`。agent-service profile 可以不带 API key；配置管理台后，托管 key 可用于用量归属。local profile 必须提供 Bearer key。仅在库强制要求且使用无托管 key 的 agent-service profile 时使用占位值。

```js
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://127.0.0.1:8787/v1",
  apiKey: "local",
});

const completion = await client.chat.completions.create({
  model: "gpt-6-luna",
  messages: [{ role: "user", content: "Summarize this project." }],
});

console.log(completion.choices[0].message.content);
```

或使用 `curl`：

```sh
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "gpt-6-luna",
    "messages": [{"role": "user", "content": "Summarize this project."}]
  }'
```

不启动 Codex thread 或 turn 即可列出模型：

```sh
curl http://127.0.0.1:8787/v1/models
```

## 支持范围

| 支持 | 不支持 |
| --- | --- |
| `POST /v1/chat/completions` 文本消息及用户消息中的内联图片、音频、PDF 和 `x_codex` 文本/表格文件 | 音频输出与已上传 file ID |
| `GET /v1/models` 返回可见模型 | Responses API、embeddings、Images API、audio API，以及模型读取/删除/修改端点 |
| SSE 流式与非流式响应 | 远程非回环监听 |
| 将 `reasoning_effort`、verbosity 和 service tier 传给 app-server | 强制工具选择 |
| 客户端函数工具、`tool_calls` 与 `finish_reason: "tool_calls"` | 每个响应多个 choice |
| 默认启用流式 usage 块；`stream_options.include_usage: false` 可关闭 | |
| OpenAI 形状的 JSON 错误 | |

默认接受客户端参数。原生设置直接交由 app-server 判断名称是否支持；`service_tier: "auto"` 保留默认值，`"fast"` 映射为 `"priority"`。`response_format` 的 `json_schema` 直接传递 schema，`json_object` 映射为通用 object schema，`text` 保持普通输出。其他格式类型会被接受并警告后忽略。

没有原生对应项的参数每个请求只发出一次 `unsupported_chat_fields_ignored` 警告后忽略，包括采样控制、`n`、`parallel_tool_calls`、token 上限、强制或命名工具选择、未知顶层字段与额外 `stream_options` 字段。响应仍只有一个 choice，工具选择保持自动，忽略的参数不会限制并行性、输出大小或模型成本。

旧 `functions` 声明映射为动态函数工具。`function_call` 作为 `tool_choice` 别名：`auto` 暴露工具，`none` 不暴露，其他格式正确的 selector 警告后退化为自动选择。同时提供两种工具声明源或两种 selector 源属于歧义并被拒绝。已知值格式错误、消息或工具结构无效、续写不匹配、媒体超限和不安全策略都会在模型执行前返回 OpenAI 形状错误。设置阶段由 app-server 返回的 JSON-RPC 无效参数错误映射为 HTTP 400 `app_server_invalid_parameters`，公开响应使用稳定摘要，不透传原生错误文本。

用户消息可以按顺序包含 `text`、`image_url`、`input_audio` 与 `file` part。图片必须是以 `data:image/png`、`data:image/jpeg`、`data:image/webp` 或 `data:image/gif` 开头的 base64 URL，每张解码后不超过 20 MiB；音频只接受 base64 `wav` 或 `mp3`。文件需要 basename `filename`，并在 `file_data` 中提供 base64 data URL。标准 Chat Completions 只接受内联 PDF；本代理还通过 `x_codex` 扩展接受 CSV、XLSX 与 UTF-8 文本文件。CSV 使用 `text/csv`；XLSX 使用 OpenXML spreadsheet MIME 类型或 `application/octet-stream`；其他 UTF-8 文件必须使用 `text/*`、JSON、XML、JavaScript 或 YAML MIME 类型。单个音频或文件解码后不超过 20 MiB，请求 body 默认上限 128 MiB。

PDF 会在创建 thread 前提取每页文本并渲染完整页面 PNG；CSV 和 XLSX 转换为带文件名、sheet 名的行数组。CSV/XLSX 每文件最多 10,000 行、256 列，XLSX 最多 16 个 sheet、ZIP 展开数据最多 32 MiB。请求提取文本最多 2 MiB。PDF 每请求最多 16 页、提取文本最多 2 MiB、单页图片最多 8 MiB、渲染 PNG 总计最多 40 MiB；超限时不会静默丢页。模型是否支持图片或音频仍由所选 app-server 模型决定。远程 URL、本地路径、`file_id` 和非 user 角色中的媒体会在 turn 开始前被拒绝。

`GET /v1/models` 分页读取已鉴权 app-server 的 `model/list`，只返回可见模型。它不启动 Codex thread 或 turn。`created: 0` 与 `owned_by: "openai"` 是兼容占位值。

## 流式响应

按通常方式设置 `stream: true`：

```sh
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "gpt-6-luna",
    "reasoning_effort": "high",
    "messages": [{"role": "user", "content": "Describe this repository."}],
    "stream": true
  }'
```

标准客户端会收到 assistant 文本、函数调用、finish reason，以及 Codex 报告精确计数时的 usage 块。usage 默认启用，可用 `stream_options.include_usage: false` 关闭；这与 OpenAI 的 opt-in 默认行为不同。Codex reasoning 与内部活动使用下文的非标准字段。

代理在提交 HTTP 200 前先取得流的第一个事件。输出前失败因此会返回真实状态的普通 JSON HTTP 错误，例如配额失败 429、模型容量不足 503 `server_overloaded`，其他情况通常为 502。已有可见输出后失败时保持 HTTP 200，发送一个带类型的 SSE error event 后关闭，不发送 `[DONE]`。

## 函数工具

函数工具遵循标准的多请求 Chat Completions 流程：

1. 在 `tools` 中发送函数定义。
2. 接收包含 `tool_calls` 的 assistant 响应。
3. 在客户端执行函数。
4. 发送 assistant 工具调用消息与对应 `role: "tool"` 结果，并重复原请求的 `tools`、`reasoning_effort` 与 `x_codex` 设置。

调用与结果之间设置发生变化时，代理会用新设置和所提供 transcript 在新 Codex thread 上执行，并报告 `x_codex.threadReused: false`；原待处理调用仍可由后续匹配请求续写。针对活动批次的部分、外来、重复或被修改结果会在执行前拒绝。没有提交结果时，显式 selector 会开启新 thread 并保留待处理批次。

完整 transcript 的多轮工具历史只会把末尾连续的 `role: "tool"` block 与当前待处理批次关联；较早完成的工具交换只作为历史。显式 `previous_response_id` 续写可在工具结果后跟一个或多个连续 user 消息，它们会按顺序进入同一个续写 turn，最后一条作为 turn input。未配对的历史调用或结果会被丢弃，并每请求报告一次 `unpaired_history_tool_items_dropped`。

代理捕获客户端工具批次后立即结束 Codex turn，完成 usage 收集再返回 `tool_calls`。后续结果只注入持久 thread，不会再次作为客户端工具调用发布。待处理调用可跨代理重启保存并按正常保留期过期；重启后带活动工具的续写会在新 thread 上执行。

## Codex 专用扩展

以下字段是可加性的非标准扩展；严格 Chat Completions 客户端应忽略或移除它们。

### 续写 Codex thread

把已完成响应的 `id` 作为顶层 `previous_response_id`，以优先续写其持久 Codex thread。该字段不是标准 Chat Completions 字段；每次请求都应携带希望模型看到的完整 transcript：

```json
{
  "model": "gpt-6-luna",
  "messages": [{ "role": "user", "content": "Now explain the test strategy." }],
  "previous_response_id": "chatcmpl_codex_..."
}
```

- 原生续写通常只把新 user 消息作为 turn input；续写不可用时，代理只能用本次提供的完整 transcript 新建 thread，无法恢复省略的早期文本。
- 原生复用要求模型、`reasoning_effort`、工具和 `x_codex` 设置一致；变化时改用新 thread。
- 未知、过期、已取代、本地竞争的映射或设置变化会新建 thread，并报告 `x_codex.threadReused: false`。app-server 自身报告的远端活动、不可恢复或 RPC 失败仍为错误，代理不会发起第二次执行。
- fallback transcript 必须完整配对 assistant 工具调用与紧随其后的工具结果，不能有孤立结果。
- 待处理批次可在结果 block 后跟连续 user 消息；结果和消息按顺序进入同一原生续写。
- 已完成 thread 可跨代理重启；重启后存在活动客户端工具时使用新 thread，无工具续写仍可原生复用。

### 接收 Codex 活动

assistant delta 或消息可包含非标准 `reasoning` 字符串。成功响应还包含响应级 `x_codex.instructionSources`，列出 app-server 报告已加载的环境原生指令文件路径；这些路径属于敏感明文。`x_codex.threadReused` 表示本请求是否成功恢复现有 thread。聚合响应各出现一次，流式响应只在首块出现。

进行中或已完成的 Codex 自有工作只出现在响应级 `x_codex.activity`。`calls` 标识命令、文件变化、MCP、Web 搜索、协作调用及后续明确支持的活动，`results` 提供对应状态与输出。聚合响应汇总一次；流式响应使用 `choices: []` 的扩展块发送增量。

标准 `tool_calls` 只用于客户端声明且尚未解决的函数。只要标准 `tool_calls` 非空，响应就以 `finish_reason: "tool_calls"` 结束；`finish_reason: "stop"` 不包含标准工具调用。Codex 自有活动不需要 `role: "tool"` 跟进。

协作活动结果可能包含已清理的 `receiverThreadIds` 与 `agentsStates`，只保留子状态和消息字段。子生命周期以 `subAgentActivity` 出现在同一扩展中，Agent 路径会被删除。`webSearch` 的不完整 start 占位不会暴露，代理使用 completed item 中的 query 与 action。

assistant 消息还可携带 OpenAI 兼容客户端使用的 `reasoning_content`；它与 `reasoning` 一样只允许 assistant 字符串输入，收到请求时会从历史中移除。

### 选择 Codex 策略

每请求 Codex 控制项位于非标准顶层 `x_codex`：

```json
{
  "model": "gpt-6-luna",
  "messages": [{ "role": "user", "content": "Review this project." }],
  "x_codex": {
    "cwd": "/absolute/path/to/project",
    "sandbox": "workspace-write",
    "web_search": "disabled"
  }
}
```

| 字段 | 值 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `cwd` | 绝对路径 | 配置的 `--root` | 必须是 root 或其后代；拒绝相对路径与 symlink 逃逸 |
| `sandbox` | `disabled`、`read-only`、`workspace-write`、`danger-full-access` | `disabled` | `disabled` 移除内置执行环境 |
| `web_search` | `disabled`、`cached`、`indexed`、`live` | `disabled` | 按 Codex thread 应用 |

`disabled` 不提供内置 shell 或执行环境中的本地文件读写。代理将其实现为 Codex 原生 `read-only` 加 `environments: []`，因此托管策略必须允许 `read-only`。托管 Web 搜索由 `x_codex.web_search` 单独选择。

原生 Windows 在没有用户、项目或托管配置指定 backend 时默认提供 `windows.sandbox = "unelevated"`。这不会改变 `x_codex.sandbox` 的 opt-in 要求；unelevated backend 隔离弱于 elevated backend。

多 Agent 是 app-server 进程配置，不是每请求策略。默认关闭；操作方传入 `--subagents true` 后才开启。启用 sandbox 或 Web 搜索不会自动允许子 Agent。

> **项目信任：** 使用 `workspace-write` 与 `cwd` 新建 thread 可能使 Codex 在 `config.toml` 中把项目标为可信。请尽量缩小 `--root`。

## 用量元数据

Codex 报告精确用量时，响应包含标准 `prompt_tokens`、`completion_tokens`、`total_tokens`，以及可用的缓存输入和 reasoning token 明细。计数不完整时省略 `usage`，绝不估算。

app-server 报告 thread idle 后，代理固定收集一秒的 usage 更新，即使之前已有计数。请求取消、传输失败或十秒终止收集上限可提前结束。流式响应先发送 `choices: []` 的 usage 块，再发送 `finish_reason` 块，最后 `[DONE]`；客户端应按字段查找 usage，不要假设它是最后一块。

一个响应可能包含多个 Codex 模型请求。用量从最新完整累计值减去已保存边界，以保留内部工具执行前后的 reasoning。以 `tool_calls` 结束的响应会中断 turn、收集迟到用量并为续写保存边界；未收到 usage 时保持起始边界，使后续续写仍可统计此前未报告的工作。

## 配额错误

只有 app-server 的 `codexErrorInfo: "usageLimitExceeded"` 映射为 HTTP 429 与 `error.type: "rate_limit_error"`，通常代码为 `usage_limit_exceeded`。每个失败请求最多执行一次可取消、带缓存的 `account/rateLimits/read` 用于补充信息，而不是公开额度端点或主动准入检查。

存在可信未来重置时间时，非标准 `error.x_codex.reset_at` 使用 Unix 秒；响应尚未提交时同时设置匹配的整数秒 `Retry-After`。查询失败或格式错误时省略二者但保留类型化 429。明确的 workspace credits 耗尽使用 `insufficient_credits` 且无 reset；workspace 使用上限按是否存在可信个人 spend-control reset 选择 `workspace_usage_limit_exceeded` 或 `usage_limit_exceeded`。代理不会睡眠、排队、消耗 reset credit、重试或重放请求。

## 容量错误

app-server 的 `serverOverloaded` 映射为 HTTP 503、`error.type: "server_error"` 与 `error.code: "server_overloaded"`，保留 Codex 消息。它是上游容量问题，不是账号配额，因此不查询 rate limit，也不携带 `Retry-After` 或 `reset_at`。其他未分类 turn 失败仍为 502 `app_server_error`。代理不会自动重试容量错误；应稍后重试或选择其他模型。

## 安全与限制

- listener 只接受 `127.0.0.1`、`::1`、`localhost`；拒绝非回环 `Host` 与任何包含 `Origin` 的请求。
- local profile 的所有模型 API 路由都需要客户端 Bearer key；agent-service profile 和裸 CLI 可不带 key。agent-service 中的托管 key 只用于归属，不是访问控制。
- 结构化 JSON 日志输出到 stderr，且不脱敏。所有级别都可能包含文件路径、登录 URL、token、提示词、子进程 stderr 或工具细节。
- 成功 `/health`、`/ready` 及启动未完成时的 503 探测记录在 debug；这些路径的拒绝与失败仍记录在 info。

裸 CLI 默认限制如下；部署 profile 可覆盖，详见 [Docker 部署](docker.md)：

| 限制 | 默认值 |
| --- | --- |
| JSON body | 128 MiB |
| 并发 HTTP 请求 | 100，超过时返回 429 `overloaded` |
| 请求期限 | 30 秒 |
| 登录/启动期限 | 固定 5 分钟 |

请求与本地活动 Codex thread 竞争时会改用新 thread；app-server 自身报告 thread 活动时仍返回 409 `thread_busy`。app-server 崩溃后代理会有限退避重启，此时 `/ready` 返回 503。请求期限会取消下游工作、关闭尚未结束的响应并释放并发槽，包括因客户端不再读取而阻塞的 stream。
