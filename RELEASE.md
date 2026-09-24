# Release checklist

## 公开仓库维护

- 保持 package 的 repository、homepage、bugs 与本仓库一致；不要沿用上游身份。
- 检查依赖及引入代码的许可，确认与本项目发布方式一致。
- 检查工作区、暂存区以及计划推送的完整 Git 历史。忽略规则不能移除历史中的秘密。
- 不发布 `deploy/local/`、`secrets/`、登录凭据、数据库、个人路径或运行日志。
- 启用私人漏洞报告、分支保护和 CI 检查；确认 SECURITY.md 的联系流程实际可用。

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

2026-09-23 的 npm 官方公告检查显示根开发依赖有 7 项告警（3 high、
4 moderate），涉及 Vitest/mocker、brace-expansion、js-yaml、nanoid
及 PostCSS 等依赖链。生产依赖裁剪后的镜像安装审计为 0 项；
这不等同于整项目安全审计。正式发布前应单独更新受影响开发依赖、
重新运行完整检查并再次审计，不要用自动强制升级替代兼容性验证。

1. 确认包名/镜像命名空间的所有权，填写准确仓库元数据并选择版本。
2. 明确批准发布后才移除 `private`，配置当前仓库专属的发布身份与受保护环境。
3. 对最终 commit 重新执行检查，核对 tarball 的文件允许清单与校验和。
4. 发布不可变版本，记录支持的平台、Codex 版本、限制和升级步骤。
5. 不覆盖既有 tag；失败时核对注册表状态再处理。

## 升级与回滚

升级前确认没有在途请求，并离线备份状态、管理数据库及主密钥、隔离 Codex home 和部署配置。SQLite 备份必须一致，不能运行时只复制主数据库而遗漏 WAL。

保留旧镜像/commit 与匹配的状态备份。使用完全相同的 Compose 文件和环境配置重建服务，确认 readiness、密钥拒绝及管理端登录。重启会中断在途请求；不能保证正在执行的工具批次恢复。未经确认不要执行 `docker compose down -v`。
