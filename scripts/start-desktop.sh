#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
DOCKER_BIN=${DOCKER_BIN:-/usr/local/bin/docker}
# Docker Desktop is required for the containers; never launch the retired native proxy.
if ! "$DOCKER_BIN" info >/dev/null 2>&1; then
  /usr/bin/open -g -a Docker
fi
attempt=0
until "$DOCKER_BIN" info >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 120 ]; then echo "Docker Desktop did not become ready" >&2; exit 1; fi
  sleep 2
done
exec "$DOCKER_BIN" compose --env-file deploy/local/.env -f compose.desktop.yaml -p codex-agent-bridge up -d --no-build
