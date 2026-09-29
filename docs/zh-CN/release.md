# 发布清单

[English](../en/release.md) | 简体中文

## 公开仓库维护

- 保持 package 的 repository、homepage、bugs 与本仓库一致；不要沿用上游身份。
- 检查依赖及引入代码的许可，确认与本项目发布方式一致。
- 检查工作区、暂存区以及计划推送的完整 Git 历史。忽略规则不能移除历史中的秘密。
- 不发布 `deploy/local/`、`secrets/`、登录凭据、数据库、个人路径或运行日志。
- 启用私人漏洞报告、分支保护和 CI 检查；确认[安全策略](security.md)中的联系流程实际可用。

## 候选验证

```sh
npm ci
npm --prefix web ci
npm run build:web
npm run check
npm run test:package
docker build -t codex-agent-bridge:candidate .
BRIDGE_TEST_IMAGE=codex-agent-bridge:candidate node scripts/docker-smoke.mjs
```

先检查 Docker smoke 脚本的用法与环境需求；它使用测试凭据和 fake backend，不调用真实模型。跨平台验证由离线 CI 完成。本地通过不等于所有平台通过。

手动的 **Validate release candidate** workflow 仅验证并保存 tarball，权限只读，不创建 commit/tag、不推送、不发布。Registry-backed smoke 是可选的干净依赖安装检查，不是发布动作。

## npm 或镜像发布前

1. 确认包名/镜像命名空间的所有权，填写准确仓库元数据并选择版本。
2. 审计当前依赖和生产镜像；逐项处理结果，不使用自动强制升级替代兼容性验证。
3. 明确批准发布后才移除 `private`，配置当前仓库专属的发布身份与受保护环境。
4. 对最终 commit 重新执行检查，核对 tarball 的文件允许清单与校验和。
5. 发布不可变版本，记录支持的平台、Codex 版本、限制和升级步骤。
6. 不覆盖既有 tag；失败时核对注册表状态再处理。

## 升级与回滚

升级前确认没有在途请求，并离线备份状态、管理数据库及主密钥、隔离 Codex home 和部署配置。SQLite 备份必须一致，不能运行时只复制主数据库而遗漏 WAL。

保留旧镜像/commit 与匹配的状态备份。使用完全相同的 Compose 文件和环境配置重建服务，确认 readiness 与管理端登录；local profile 验证无效密钥被拒绝，agent-service profile 验证匿名请求可用且不产生密钥归属。重启会中断在途请求；不能保证正在执行的工具批次恢复。未经确认不要执行 `docker compose down -v`。
