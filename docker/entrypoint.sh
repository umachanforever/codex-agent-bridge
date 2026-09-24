#!/bin/sh
set -eu
export CODEX_BRIDGE_CONTAINER=1
# Explicit arguments support diagnostics without invoking a model.
if [ "$#" -gt 0 ]; then
  exec "$@"
fi
set -- --auth-mode "${BRIDGE_AUTH_MODE:-reuse}"
if [ -n "${BRIDGE_AUTH_SOURCE:-}" ]; then
  set -- "$@" --auth-source "$BRIDGE_AUTH_SOURCE"
fi
case "${BRIDGE_PROFILE:-agent-service}" in
  agent-service) set -- "$@" --agent-service-model "${BRIDGE_MODEL:-gpt-6-luna}" ;;
  local) set -- "$@" --local-bridge-model "${BRIDGE_MODEL:-gpt-6-luna}" ;;
  *) echo "Invalid BRIDGE_PROFILE" >&2; exit 1 ;;
esac
exec node /app/dist/bin.js serve "$@" \
  --host 127.0.0.1 --port 8787 \
  --root /workspace --codex-home /data/codex --state-dir /data/state \
  --sync-auth always --login device-code --admin-port 8789 \
  --request-timeout "${BRIDGE_REQUEST_TIMEOUT:-21600s}" --shutdown-timeout 30s \
  --body-limit "${BRIDGE_BODY_LIMIT:-134217728}" \
  --max-requests "${BRIDGE_MAX_REQUESTS:-10000}"
