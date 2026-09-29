# Docker 部署

[English](../en/docker.md) | 简体中文

Docker Compose 会从本仓库构建代理，并只发布到 `127.0.0.1`。桥接容器使用独立可写 Codex home 运行固定版本 app-server，网关提供模型 API 与管理台。

## 选择鉴权来源

复用已有本地 Codex 登录时，按[中文 README](README.md#使用-docker-部署)创建密钥，将 `LOCAL_CODEX_HOME` 指向包含 `auth.json` 的目录，然后启动标准部署：

```sh
docker compose -f compose.yaml -f compose.local-auth.yaml up -d --build
docker compose -f compose.yaml -f compose.local-auth.yaml ps
```

来源目录以只读方式挂载。容器只会把更新的 `auth.json` 复制进自己的可写卷，不会修改来源。

若使用独立容器登录，设置 `BRIDGE_AUTH_MODE=independent` 并仅使用 `compose.yaml`。在 `/ready` 返回 200 前，需要通过桥接容器的私有输出完成 device-code 登录；该输出属于敏感明文。

`compose.desktop.yaml` 保留已有原生服务的迁移布局，使用独立管理端口、宿主机运行目录和 `deploy/local/.env` 中的私有设置。仅在维护该布局时使用，并确保环境文件与运行数据不进入版本控制。容器需要 HTTP 代理时，在被忽略的环境文件中设置 `BRIDGE_PROXY`，地址必须能从 Docker 访问，例如宿主机代理可使用 `http://host.docker.internal:<port>`。未设置时，Compose 使用空代理配置并直连；镜像构建阶段使用相同选择。

## 端点与限制

标准 Compose 在宿主机 8787 端口同时提供 API 与控制台；桌面迁移配置使用 8787 提供 API、8789 提供控制台。两者都只发布到回环地址，其他容器不能通过自身的 `127.0.0.1` 访问。

Docker 默认请求期限为 6 小时、JSON body 上限 128 MiB、最大并发 HTTP 请求 10,000。通过 Compose 环境中的 `BRIDGE_REQUEST_TIMEOUT`、`BRIDGE_BODY_LIMIT` 和 `BRIDGE_MAX_REQUESTS` 修改。超时使用 `30m`、`21600s` 等 CLI 时长格式，body 限制使用字节；启动时会校验三者。`BRIDGE_MAX_REQUESTS=0` 会取消并发限制，只应在受控本地负载下使用；超过正数限制的请求返回 HTTP 429 `overloaded`。

默认 agent-service profile 允许模型 API 请求不带 key；托管 Bearer key 只用于用量归属。设置 `BRIDGE_PROFILE=local` 后必须提供客户端 Bearer key。管理台使用保存在桥接状态卷中的独立管理员密码；Docker 始终保留密码鉴权，包括经过网关访问时。

## 升级与备份

每次升级都使用相同的 Compose 文件、环境和 project name。替换服务前先在控制台确认没有在途请求，因为重启会中断它们。随后用与启动时相同的选项运行 `docker compose ... up -d --build`，并使用客户端 key 验证 `/ready`。

服务停止后，将 Codex home 与状态卷一起备份。状态卷包含管理员数据库、加密密钥和续写映射。客户端 key 与备份都应私密保存；恢复时必须匹配状态与加密密钥，不能在没有一致性快照的情况下复制正在使用的 SQLite 数据库。
