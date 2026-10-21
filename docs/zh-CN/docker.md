# Docker 部署

[English](../en/docker.md) | 简体中文

Docker Compose 会从本仓库构建代理，并只发布到 `127.0.0.1`。桥接容器使用独立可写 Codex home 运行固定版本 app-server，网关提供模型 API 与管理台。

## 选择鉴权来源

复用已有本地 Codex 登录时，按[中文 README](README.md#使用-docker-部署)创建密钥，将 `LOCAL_CODEX_HOME` 指向包含 `auth.json` 的目录，然后启动标准部署：

```sh
npm run deploy -- -f compose.yaml -f compose.local-auth.yaml
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

后续部署用相同的 Compose 文件、环境文件与 project name 执行 `npm run deploy -- ...`。脚本只替换本仓库对应的用户 crontab 项。从旧版本首次迁移时缺少请求入口维护门禁，应选择空闲维护窗口操作。

## 午夜自动升级

仓库脚本 `scripts/deploy-auto-update.mjs` 独立于 Codex App 运行。macOS/Linux 上的 `npm run deploy -- ...` 会安装宿主机当地时间每天 00:00 的用户 cron 任务。宿主机必须开机、cron 正常运行，部署用户可无交互使用 Node.js 22+、npm、Git 和 Docker Compose。直接 `docker compose up` 仍为手动部署，不安装定时任务。独立登录模式首次就绪失败时，先完成设备码登录再重试部署。

Compose 全局参数放在 `--` 后，例如 `npm run deploy -- --env-file .env -f compose.yaml -f compose.local-auth.yaml -p codex-agent-bridge`。插值配置保存在环境文件中，cron 不继承交互 shell 的临时环境变量。参数中不要放秘密。仓库或工具路径移动后重新执行部署命令。暂不支持 Windows 定时部署。

午夜先检查 `/health`；有在途请求、不健康或已有维护标记则跳过当晚。脚本查询 npm 的 Codex 稳定版，仅升级更高版本。在临时源码快照中安装新版本，包含本地未忽略的修改，并要求协议生成、格式、lint、离线测试、打包检查、镜像构建、原生 SQLite 和运行时版本检查全部通过。源仓库及固定版本保持原样。这些检查不生成模型回复。兼容性检查失败时旧服务继续运行，维护者需适配仓库。

替换前独占创建 `/data/state/update-maintenance`，新 Chat Completions 和内部文本补全返回 HTTP 503 `update_in_progress`，已接收的请求正常完成。60 秒内无法确认空闲则取消更新。替换后通过网关检查就绪与模型列表，失败则恢复旧镜像，保留数据卷。镜像回滚不能撤销上游持久化数据迁移，重要数据须备份，并在依赖无人值守升级前审查上游兼容性。未执行中的历史会话不阻止更新。

私有调度状态和简要失败信息位于已忽略的 `.auto-update/`，日志 `update.log` 权限为 600。兼容性失败可在独立检出中执行 `npm run update:codex -- EXACT_VERSION` 获取完整诊断。错过午夜不补跑，宿主机锁防止任务重叠。进程被强杀后，确认无更新进程，再移除 `.auto-update/lock` 及数据卷中的 `update-maintenance` 标记。卸载时用 `crontab -e` 仅移除以本仓库 `# codex-agent-bridge:...` 标记结尾的一行，保留其他任务。

## 备份

服务停止后，将 Codex home 与状态卷一起备份。状态卷包含管理员数据库、加密密钥和续写映射。客户端 key 与备份都应私密保存；恢复时必须匹配状态与加密密钥，不能在没有一致性快照的情况下复制正在使用的 SQLite 数据库。
