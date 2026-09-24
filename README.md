# Codex Agent Bridge

English | [简体中文](README.zh-CN.md)

Codex Agent Bridge exposes a local `codex app-server` through an OpenAI Chat Completions compatible API for agent clients such as AstrBot and WorkBuddy. It includes a web management console, separate client API keys, usage records, and Docker deployment.

Install from this repository with Node.js or Docker Compose. The deployment commands below build the service from the checked-out source.

## Table of contents

- [Features and limits](#features-and-limits)
- [Requirements](#requirements)
- [Run from source](#run-from-source)
- [Deploy with Docker](#deploy-with-docker)
- [Connect a client](#connect-a-client)
- [Security and operations](#security-and-operations)
- [Documentation and contribution](#documentation-and-contribution)
- [License](#license)

## Features and limits

- Text conversations, SSE streaming, client function tools, and continuation with tool results.
- Text-part arrays and harmless unknown history metadata; known fields and execution policies are still validated.
- Reuse of local Codex authentication by default, with a separate writable Codex home for the proxy. Independent login is optional.
- Web management for status, usage, API keys, runtime settings, and theme selection.
- A manual price table and an optional model-assisted lookup of current official prices. Suggested changes require review and confirmation before saving.
- Measured token usage and an estimated standard short-context cost based on public API prices. This is neither a bill nor an account balance.
- A Chat Completions subset with inline user image, audio, PDF, text, CSV, and XLSX input. Non-PDF file parts are an `x_codex` extension converted locally to text. The Responses API, audio output, uploaded file IDs, and some OpenAI parameters are unsupported. See the [client API](docs/client-api.md) and [compatibility notes](docs/compatibility.md).

The client executes tools it declares, such as WorkBuddy's local file operations. Codex built-in tools run where the proxy runs. Full access inside Docker does not grant host access. The default service profile disables built-in tools and does not mount the host workspace or Docker socket.

For Codex built-in tools to use native Mac paths, run the proxy natively with `--root /` and explicitly add `--local-host-tools true` to a `--local-bridge-model` configuration. This lets requests that declare client tools also use Codex built-in tools; `x_codex.sandbox` can still select a stricter policy. Writes remain subject to the proxy user's macOS permissions and privacy grants. Use this configuration only with trusted clients.

## Requirements

- Node.js 22+ (Node 24 recommended), npm, and a local Codex login.
- Docker Compose v2 for container deployment.

## Run from source

From this checkout:

```sh
npm ci
npm --prefix web ci
npm run build
npm run build:web

# First creation only. Do not rerun when the key already exists.
mkdir -p secrets
chmod 700 secrets
(umask 077; node --input-type=module -e 'import { randomBytes } from "node:crypto"; import { writeFileSync } from "node:fs"; writeFileSync("secrets/bridge-token", "sk-" + randomBytes(32).toString("base64url") + "\n", { flag: "wx", mode: 0o600 });')

CODEX_BRIDGE_TOKEN_FILE="$PWD/secrets/bridge-token" \
  node dist/bin.js serve --agent-service-model gpt-6-luna --admin-port 8789
```

Keep the final command running. The key generation and environment variable examples use a POSIX shell; on Windows, set the same environment variable in PowerShell before running the `node` command.

- API base URL: `http://127.0.0.1:8787/v1`
- Web console: `http://127.0.0.1:8789/admin/`
- Client API key: the contents of `secrets/bridge-token`, or a separate key created in the console.
- Admin password: generated on first start in `<state-dir>/admin/admin-token`. Use `node dist/bin.js --help` to find the default state directory. Read it privately on the local machine; it is not a client API key.
- Model: the example uses `gpt-6-luna`. In the console settings, choose a model available to your account from the model list.

Authentication sync copies only `auth.json`, not personal Codex configuration. A custom provider requires separate configuration in the proxy's isolated Codex home; see [authentication](docs/client-api.md#authentication). The `codex-openai-proxy` CLI alias and existing default state paths remain compatible. This project's packaged output also provides the `codex-agent-bridge` command.

## Deploy with Docker

From this checkout, create a client key on first deployment and point Compose to the directory containing your login:

```sh
mkdir -p secrets
chmod 700 secrets
# First creation only; never overwrite an existing key.
(set -C; umask 077; openssl rand -hex 32 | sed 's/^/sk-/' > secrets/bridge-token)
export LOCAL_CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
docker compose -f compose.yaml -f compose.local-auth.yaml up -d --build
docker compose -f compose.yaml -f compose.local-auth.yaml ps
```

The local authentication directory is mounted read-only. Writable authentication, state, and workspace data live in separate Docker volumes. Container UID 1000 must be able to read the authentication and key files; on Linux, set the appropriate owner or ACL without making them world-readable.

With the default Compose port, the API base URL is `http://127.0.0.1:8787/v1` and the console is `http://127.0.0.1:8787/admin/`. The admin password is in `/data/state/admin/admin-token` inside the bridge container. Docker uses one host port for both endpoints, unlike the source command above.

For independent login, upgrades, backups, proxies, and migration from an existing macOS service, see the [Docker deployment guide](docs/docker.md). `compose.desktop.yaml` is for migrating an existing native service, not the default new installation. Use the same Compose files and environment settings for subsequent stop and upgrade commands.
The desktop migration uses a proxy only when `BRIDGE_PROXY` is set in its private environment file.
The desktop variant uses the fixed container names `codex-agent-bridge-api` and `codex-agent-bridge-gateway`.

## Connect a client

Choose an OpenAI compatible Chat Completions endpoint in your client:

| Setting   | Value                                                                               |
| --------- | ----------------------------------------------------------------------------------- |
| Base URL  | `http://127.0.0.1:8787/v1`                                                          |
| API key   | A `sk-` key issued by this proxy, not Codex login credentials or the admin password |
| Model     | An available model ID from the console or `GET /v1/models`                          |
| Streaming | Supported; structured JSON is sent after completion and validation                  |

`/health`, `/ready`, and `/v1/models` require a client Bearer key. Checking these endpoints does not generate a model response. A client in another container cannot reach the host through its own `127.0.0.1`; the default deployment does not expose a cross-container or public endpoint.

## Security and operations

This service is intended for trusted local clients, not a public, multi-tenant, or credential-sharing service. API keys support revocation and usage attribution; they do not isolate filesystems or Codex sessions. Follow your account, organization, and upstream provider policies.

The admin password and client API keys are separate. The console requires login by default. A native direct connection can explicitly enable local entry without an initial password; containers and reverse proxies retain password authentication. Before allowing broader tool execution, consider which credentials and files the tools can access in their environment.

The console stores its session bearer for this browser origin in session storage, or in local storage when “remember login” is selected. Use it from a trusted local browser profile; see [web management](docs/admin.md#keys-and-browser-security).

Do not commit `secrets/`, `deploy/local/`, login files, runtime logs, or databases. Logs may contain sensitive text. Docker defaults to 10,000 concurrent requests, a 128 MiB request body limit, and a six-hour deadline; restarting interrupts active requests.

## Documentation and contribution

- [Documentation index](docs/README.md): protocol, architecture, and maintenance topics.
- [Docker deployment](docs/docker.md): configuration, upgrades, and backups.
- [Web management](docs/admin.md): keys, usage accounting, theme, and login.
- [Troubleshooting](docs/troubleshooting.md): authentication, rate limits, tools, and streaming.
- [Security reports](SECURITY.md) · [Release checklist](RELEASE.md) · [Changelog](CHANGELOG.md)

## License

This project is licensed under the [MIT License](LICENSE). Copyright (c) 2026 umachanforever.

Cache-refresh failures preserve the previous catalog, and malformed nonfinite usage counters are omitted.
