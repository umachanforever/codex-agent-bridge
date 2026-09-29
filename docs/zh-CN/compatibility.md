# Codex 兼容性

[English](../en/compatibility.md) | 简体中文

代理一次只面向一个 app-server 契约。当前运行时依赖为在 `package.json` 中精确固定的 `@openai/codex` **0.155.1**。生成的实验性 TypeScript 与 JSON Schema 契约提交在 `protocol/`，版本与生成命令记录于 `protocol/VERSION.json`。默认启动与协议生成都使用包内可执行文件；显式 `--codex-path` 必须报告相同版本。升级 Codex 前必须重新审查契约。

| 兼容边界 | 当前行为 | Codex 升级影响 |
| --- | --- | --- |
| JSON-RPC 与生成类型 | 使用固定包和 `--experimental` 生成；`npm run check:protocol` 将临时重新生成结果与已提交契约比较。 | 修改翻译或策略代码前审查 method、notification 与字段变化；使用 `npm run generate:protocol` 重新生成，不手工修改生成文件。 |
| 模型目录与直接客户端函数 | 0.155.1 使用临时 Responses Lite 覆盖。 | 删除覆盖前重新验证直接及并行函数调用；Schema 通过不能证明模型行为。 |
| Codex home 与鉴权 | 所有 root 共用代理专属 Codex home，只从普通 Codex home 同步 `auth.json`。 | 新版本复用该 home 前审查磁盘缓存、配置格式与 token 处理。 |
| 续写状态 | 每个 root 使用独立、schema 版本为 0 的持久响应存储。 | 审查记录格式与重启行为；不兼容格式需要显式迁移或拒绝，不能静默改写。 |

## 客户端参数兼容性

所有 profile 默认接受格式正确的客户端控制项。原生 reasoning、verbosity 与 service-tier 名称直接交由 app-server 校验，代理不维护第二套枚举。JSON object 输出使用通用 object schema，旧 `functions` 声明映射为动态工具。没有原生对应项的参数会被接受并忽略，每个请求只发出一次结构化警告；它们不会作为任意 `turn/start` 字段传递，也不会进入 Codex 配置或执行策略。

WorkBuddy 的连接探测包含 `max_tokens`。两个 token 上限字段可以同时出现，但都不会限制输出或成本；警告会明确包含 `output_token_limit_enforced: false`。同样，`n` 不会生成多个 choice，强制工具选择与 `parallel_tool_calls: false` 也不会被执行。已知字段格式错误、声明或 selector 冲突，以及安全或生命周期约束仍会报错。设置阶段的原生 JSON-RPC 无效参数拒绝映射为 HTTP 400 `app_server_invalid_parameters`。详见[客户端 API](client-api.md#支持范围)。

## 临时模型目录覆盖

Codex 0.155.1 可能把标记为 `use_responses_lite` 的模型放入 code mode，使客户端函数变成嵌套回调。代理将 `models_cache.json` 克隆为 `models.no-responses-lite.json`，把所有模型的 `use_responses_lite` 设为 `false`，并从使用 Responses Lite 的条目中删除 `tool_mode`。来源缓存仍由 Codex 管理，不会被修改。

所选 home 的 `config.toml` 会加入带标记的顶层 `model_catalog_json` 配置并指向克隆文件；这会替换此前的顶层模型目录选择，但保留其他配置。该覆盖只适用于当前固定版本。只有在完成运行时审查并通过 opt-in live contract、确认直接批量客户端函数正常后才能删除。

每个新代理进程启动时，会通过临时 Codex home 中的私有 app-server 做一次有界的目录刷新。只有固定客户端版本写出的非空有效新缓存才会替换所选缓存。随后重建克隆文件并重启私有 app-server，使启动期目录选择生效。刷新失败时保留旧缓存并记录警告；ready 仍要求存在可用覆盖。同一代理进程内的 app-server 恢复不会重复刷新。`GET /v1/models` 使用该进程固定的最终目录，不启动模型 turn。

## Home、凭据与续写状态

| 数据 | 默认位置 | 兼容规则 |
| --- | --- | --- |
| Codex home | `~/.codex-openai-proxy/codex-home` 或 `--codex-home` | 多个代理 root 共用，与普通 `~/.codex` 分离；保存登录、模型缓存、覆盖和 Codex 配置。 |
| 鉴权来源 | `--auth-source`、`$CODEX_HOME` 或普通本地 Codex home | 默认 reuse 只复制缺失或严格更新的凭据，不发起登录/退出，也不写回。`--sync-auth never` 保留隔离凭据；`--auth-mode independent` 启用独立登录。共享轮换 refresh token 仍可能冲突。 |
| 续写存储 | `~/.codex-openai-proxy` 下按 root hash 分区，或 `--state-dir` | 保存不透明响应到 thread 的映射和待处理客户端工具调用 30 天。当前 schema 为 0；格式错误或未知版本的记录不受信任。卸载不会自动删除该状态。 |

固定的 0.155.1 运行时可以复用代理 home。持久文件名与状态 schema 保持不变，模型目录覆盖会保留未知缓存元数据。后续 Codex 版本必须重新审查。鉴权与续写的用户行为见[客户端 API](client-api.md)。

## 验证边界

子 Agent 启动可能表现为 `subAgentActivity` 或 `spawnAgent`。代理只在 `x_codex` 活动扩展中保留 `kind` 与 `agentThreadId`，不会暴露 Agent 路径。opt-in 子 Agent 契约验证一次子 Agent 启动，并通过 `agentsStates` 或使用不产生模型工作的 `thread/read` 读取子 thread 完成历史，确认其 provider 已完成。

默认 `npm run check` 完全离线且可复现，覆盖生成协议漂移、类型、转换及失败路径；`npm run test:package` 另行离线验证打包 CLI。两者都不能证明模型选择、真实账号鉴权或远程 npm 发布。单独选择的 live 配置只使用 `gpt-6-luna`、串行运行，核心契约上限为 32 个去重的上游响应，system-prompt 契约另有 2 个；上限不代表正常调用数量。

更改 Codex 固定版本时，使用仓库的 `update-codex` 工作流，检查生成 diff 与上述行为边界，运行离线和打包检查，并在这里记录兼容性与持久化决策。live 验证必须单独授权和预算。
