# Codex Agent Bridge

简体中文 | [English](../../README.md)

Codex Agent Bridge 通过兼容 OpenAI Chat Completions 的接口，将本地的 `codex app-server` 暴露给 AstrBot、WorkBuddy 等智能体客户端。内置 Web 管理控制台、独立的客户端 API Key、用量记录和 Docker 部署能力。

可使用 Node.js 或 Docker Compose 从本仓库安装。下文的部署命令会基于当前检出的源码构建服务。

## 目录

- [功能与限制](#功能与限制)
- [环境要求](#环境要求)
- [从源码运行](#从源码运行)
- [使用 Docker 部署](#使用-docker-部署)
- [接入客户端](#接入客户端)
- [安全与运维](#安全与运维)
- [文档与贡献](#文档与贡献)
- [许可](#许可)

## 功能与限制

- 文本对话、SSE 流式输出、客户端函数工具，以及携带工具结果的续写。
- 标准 `tool_calls` 只包含需要客户端执行的函数；Codex 自有的工具及 Agent 活动位于 `x_codex.activity`。
- 文本分段数组与无害的未知历史元数据；已知字段与执行策略仍会被校验。
- 默认复用本地 Codex 鉴权，并为代理分配独立可写的 Codex home；也可选择独立登录。
- Web 管理台支持查看状态、用量、API Key、运行时设置与主题切换。
- 默认接受客户端参数：原生设置交给 app-server，无对应字段的控制参数忽略并记录警告。token 上限参数不限制输出量或模型费用。
- 内置手动价格表，并支持可选的"模型辅助查询当前官方价格"。建议的变更需经复核确认后方可保存。
- 实测 token 用量，并按公开 API 价格估算标准短上下文成本——这既不是账单，也不是账户余额。
- 提供 Chat Completions 的子集，支持用户消息中的内联图片、音频、PDF、文本、CSV 和 XLSX 输入。非 PDF 的文件内容块是 `x_codex` 扩展，会在本地转换为文本。Responses API、音频输出及已上传文件 ID 暂不支持，详见[客户端 API](client-api.md)与[兼容性说明](compatibility.md)。

## 环境要求

- Node.js 22+（推荐 Node 24）、npm，以及一次本地 Codex 登录。
- Docker Compose v2（仅在使用 Docker 部署时需要）。

## 从源码运行

```sh
npm ci
npm --prefix web ci
npm run build
npm run build:web

node dist/bin.js serve --agent-service-model gpt-6-luna --admin-port 8789
```

保持最后一条命令持续运行。

- API 基础地址：`http://127.0.0.1:8787/v1`
- Web 控制台：`http://127.0.0.1:8789/admin/`
- 客户端 API Key：可选，可在控制台创建并用于用量归属。agent-service 模式允许不带 key 的请求。
- 管理员密码：首次启动时生成于 `<state-dir>/admin/admin-token`。使用 `node dist/bin.js --help` 可查看默认 state 目录。请在本地机器上私密读取，它不是客户端 API Key。
- 模型：示例使用 `gpt-6-luna`。在控制台设置中选择你账号可用的模型。

鉴权同步仅复制 `auth.json`，不会复制个人 Codex 配置。自定义 provider 需要在代理隔离的 Codex home 中单独配置，详见[鉴权说明](client-api.md#鉴权)。`codex-openai-proxy` CLI 别名与既有的默认 state 路径保持兼容。本项目打包产物同时提供 `codex-agent-bridge` 命令。

## 使用 Docker 部署

从本仓库首次部署时创建客户端 key，并将 Compose 指向存放登录信息的目录：

```sh
mkdir -p secrets
chmod 700 secrets
# 仅首次创建；切勿覆盖已有 key。
(set -C; umask 077; openssl rand -hex 32 | sed 's/^/sk-/' > secrets/bridge-token)
export LOCAL_CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
docker compose -f compose.yaml -f compose.local-auth.yaml up -d --build
docker compose -f compose.yaml -f compose.local-auth.yaml ps
```

本地鉴权目录以只读方式挂载。可写鉴权、状态与工作区数据存放在独立的 Docker volume 中。容器 UID 1000 需要能读取鉴权与 key 文件；在 Linux 上请设置合适的属主或 ACL，但不要将其设为全世界可读。

在默认 Compose 端口下，API 基础地址为 `http://127.0.0.1:8787/v1`，控制台为 `http://127.0.0.1:8787/admin/`。管理员密码位于容器内 `/data/state/admin/admin-token`。与上面的源码命令不同，Docker 使用同一个宿主机端口同时承载两个端点。

关于独立登录、升级、备份、代理，以及从既有 macOS 服务迁移，详见 [Docker 部署指南](docker.md)。`compose.desktop.yaml` 用于迁移既有的原生服务，而非默认的新装。后续停止与升级命令应使用相同的 Compose 文件与环境配置。桌面变体使用固定的容器名 `codex-agent-bridge-api` 与 `codex-agent-bridge-gateway`。
桌面迁移仅在私有环境文件中设置 `BRIDGE_PROXY` 时使用代理。

## 接入客户端

在客户端中选择一个兼容 OpenAI 的 Chat Completions 端点：

| 设置项   | 值                                                    |
| -------- | ----------------------------------------------------- |
| Base URL | `http://127.0.0.1:8787/v1`                            |
| API key  | 默认 agent-service 模式下用于用量归属的可选 `sk-` key |
| 模型     | 控制台或 `GET /v1/models` 给出的可用模型 ID           |
| 流式     | 支持 SSE                                              |

默认 agent-service 模式允许不带客户端 key 访问 `/health`、`/ready`、`/v1/models` 和补全接口。Docker 设置 `BRIDGE_PROFILE=local`，或原生运行时使用 `--local-bridge-model`，才会要求所有模型 API 路由提供 Bearer key。检查健康状态及模型列表不会产生模型回复。其它容器中的客户端无法通过自身的 `127.0.0.1` 访问宿主机；默认部署不暴露跨容器或公网端点。

## 安全与运维

本服务面向可信的本地客户端，而非公开、多租户或凭据共享的服务。API Key 支持吊销与用量归属；它们不会隔离文件系统或 Codex 会话。请遵守你的账号、组织及上游服务商的策略。

管理员密码与客户端 API Key 相互独立。控制台默认需要登录。原生直连可显式开启无初始密码的本地入口；容器与反向代理则保留密码鉴权。

控制台将当前浏览器来源的会话凭据保存在会话存储中；选择“记住登录”时改用本地存储。请使用可信的本地浏览器配置，详见[Web 管理](admin.md#密钥与浏览器安全)。

已登录管理员可确认轮换密钥；查看现有密钥需要管理口令。

没有匹配请求时，用量卡片显示 0 token；已有请求但上游未提供用量计数时显示“未知”，不会虚构计数。

请勿提交 `secrets/`、`deploy/local/`、登录文件、运行时日志或数据库。日志可能包含敏感文本。部署限制、升级与备份说明见 [Docker 指南](docker.md)。

## 文档与贡献

- [文档索引](index.md)：API、部署与维护主题。
- [Docker 部署](docker.md)：配置、升级与备份。
- [Web 管理](admin.md)：Key、用量计费、价格与登录。
- [故障排查](troubleshooting.md)：鉴权、速率限制、媒体与流式。
- [安全报告](security.md) · [发布清单](release.md) · [更新日志](changelog.md)

## 许可

本项目基于 [MIT 许可证](../../LICENSE) 发布。版权所有 © 2026 umachanforever。
