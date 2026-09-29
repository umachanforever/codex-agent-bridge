# Troubleshooting

English | [简体中文](../zh-CN/troubleshooting.md)

Record the project commit or version, Node.js or Docker version, deployment profile, client version, and error code first. Do not paste complete logs; reproduce with synthetic messages. Health checks do not call a model, while real conversations consume upstream usage.

| Symptom | Check and resolution |
| --- | --- |
| 401 or cannot connect | Every model API route requires a bridge API key in local mode; agent-service mode accepts requests without one. Do not use the administrator password or Codex credentials. |
| Cannot sign in to the console | Source deployments default to port 8789; standard Compose serves `/admin/` on 8787. Read `admin-token` from the active state directory. Containers retain password mode. |
| 503 or not ready | Confirm that local Codex authentication exists, the auth-source mount is readable, and the isolated home is writable. Reuse mode does not start login automatically. |
| Upstream authentication expired | Sign in locally again and restart the bridge. Concurrent copies of an OAuth refresh token may invalidate one another. Select independent authentication when separate credentials are required. |
| Custom provider unavailable | Authentication sync does not copy `config.toml`. Configure the isolated home and inspect its model catalog. Do not make a personal home directory writable by a container. |
| 429 | Distinguish local `overloaded` from upstream `usage_limit_exceeded`. Raising local concurrency cannot change upstream quota or rate limits. |
| 503 `server_overloaded` | The upstream model is at capacity, independently of local concurrency. Retry later or select an available model. |
| Timeout | Check client, gateway, bridge, and upstream deadlines. Extending the bridge deadline does not change the client's deadline. |
| History contains unknown fields | Confirm that an agent-service or local compatibility profile is active. Harmless metadata is ignored; invalid types for known fields are still rejected. |
| Image, audio, or file rejected | Use a supported inline base64 value and MIME type. Remote URLs, local paths, uploaded file IDs, and resources over the configured limits are rejected. The selected model must also support that media. |
| JSON does not stream token by token | `json_schema` output is sent after completion and validation; ordinary text still streams incrementally. |
| Docker pull or build fails | Docker daemon proxy settings affect image pulls, while build proxy settings affect dependency downloads. A container's localhost is not the host. |
| Tool continuation fails after restart | Submit a complete paired tool history or start a new conversation. Persistence does not guarantee recovery of in-flight work; do not blindly retry tools with side effects. |

If the error remains, use the issue template with a minimal sanitized request. See the [client API](client-api.md) and [compatibility notes](compatibility.md) for protocol limits. Report security issues privately as described in the [security policy](security.md).
