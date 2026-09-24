# Docker deployment

Docker Compose builds the proxy from this repository and publishes it only on
`127.0.0.1`. The bridge container runs the pinned app-server with a separate
writable Codex home. The gateway serves the model API and management console.

## Choose an authentication source

For an existing local Codex login, follow the key creation steps in the
[README](../README.md#deploy-with-docker), set `LOCAL_CODEX_HOME` to the directory
containing `auth.json`, and start the standard deployment:

```sh
docker compose -f compose.yaml -f compose.local-auth.yaml up -d --build
docker compose -f compose.yaml -f compose.local-auth.yaml ps
```

The source directory is mounted read-only. The container copies a newer
`auth.json` into its own writable volume; it does not modify the source.

Even with `danger-full-access` or `--local-host-tools true`, built-in tools in a
container can only access mounted paths using container path names. For direct
Mac paths across the host filesystem, run the proxy as a native macOS process
with `--root /` and the local-profile opt-in. macOS file permissions and
privacy grants still apply.

For a separate container login, set `BRIDGE_AUTH_MODE=independent` and use
`compose.yaml` without the local-auth override. Complete the device-code login
shown in the bridge's private container output before expecting `/ready` to
return 200. Treat that output as sensitive plaintext.

`compose.desktop.yaml` preserves the repository's native-service migration
layout. It uses a separate management port, host-backed runtime directories,
and private settings in `deploy/local/.env`. Use it only when maintaining that
layout; keep its environment file and runtime data outside version control.
Set `BRIDGE_PROXY` in that ignored environment file only if the container needs
an HTTP proxy. Use an address reachable from Docker (for example,
`http://host.docker.internal:<your-port>` for a proxy on the host). When
`BRIDGE_PROXY` is unset, Compose passes empty proxy settings and direct
connections are used. The same choice applies during the image build.

## Endpoints and limits

The standard Compose configuration serves both the API and console on host
port 8787. The desktop migration configuration serves the API on 8787 and the
console on 8789. Both publish only on loopback; these ports are not reachable
through another container's `127.0.0.1`.

Docker defaults to a six-hour request deadline, a 128 MiB JSON body limit, and
10,000 concurrent HTTP requests. Set `BRIDGE_REQUEST_TIMEOUT`, `BRIDGE_BODY_LIMIT`,
or `BRIDGE_MAX_REQUESTS` in the Compose environment to change them. The timeout
uses CLI duration syntax such as `30m` or `21600s`; the body limit is bytes.
The CLI validates all three values at startup. `BRIDGE_MAX_REQUESTS=0` disables
the concurrency limit and should be used only for a controlled local workload.
Requests beyond a positive limit receive HTTP 429 `overloaded`.

The model API requires a client Bearer key. The management console uses a
separate administrator password stored in the bridge state volume. Docker
retains password authentication, including when accessed through the gateway.

## Upgrade and backup

Use the same Compose files, environment, and project name for every upgrade.
Check the console for active requests before replacing the service, since a
restart interrupts them. Then run `docker compose ... up -d --build` with the
same options used to start it and verify `/ready` with a client key.

Back up the Codex home and state volumes together while the service is stopped.
The state volume contains the administrator database, its encryption key, and
continuation mappings. Keep the client key and backup private. Restore the
matching state and encryption key together; do not copy a live SQLite database
without a consistent snapshot.
