#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUN_BIN="${BUN_BIN:-bun}"
RUNTIME_PORT="${FORGE_CLOUD_MCP_RUNTIME_PORT:-18765}"
GATEWAY_PORT="${FORGE_CLOUD_MCP_GATEWAY_PORT:-18767}"
HOLD_SECONDS="${FORGE_CLOUD_MCP_HOLD_SECONDS:-1500}"
TUNNEL_ID="${FORGE_CLOUD_TUNNEL_ID:-}"
TUNNEL_ALIAS="${FORGE_CLOUD_TUNNEL_ALIAS:-forge-cloud-ci}"
TUNNEL_CLIENT_VERSION="${FORGE_TUNNEL_CLIENT_VERSION:-v0.0.12}"
MCP_AUTH_MODE="${FORGE_CLOUD_MCP_AUTH_MODE:-none}"
RUNTIME_API_KEY="${FORGE_CLOUD_TUNNEL_RUNTIME_API_KEY:-}"

if [[ -z "$TUNNEL_ID" ]]; then
  echo 'FORGE_CLOUD_TUNNEL_ID is required' >&2
  exit 2
fi
if [[ -z "$RUNTIME_API_KEY" ]]; then
  echo 'FORGE_CLOUD_TUNNEL_RUNTIME_API_KEY is required' >&2
  exit 2
fi
if ! [[ "$HOLD_SECONDS" =~ ^[0-9]+$ ]]; then
  echo 'FORGE_CLOUD_MCP_HOLD_SECONDS must be a non-negative integer' >&2
  exit 2
fi

TMP_ROOT="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/forge-cloud-mcp-e2e.XXXXXX")"
CONTROLLER_HOME="$TMP_ROOT/controller-home"
SETUP_LOG="$TMP_ROOT/setup.log"
INSTALL_JSON="$TMP_ROOT/runtime-install.json"
GATEWAY_LOG="$TMP_ROOT/gateway.log"
TUNNEL_ARCHIVE="$TMP_ROOT/tunnel-client.zip"
TUNNEL_DIR="$TMP_ROOT/tunnel-client"
TUNNEL_CLIENT="$TUNNEL_DIR/tunnel-client"
TUNNEL_STATUS_JSON="$TMP_ROOT/tunnel-status.json"
RUNTIME_PID=''
GATEWAY_PID=''

cleanup() {
  if [[ -x "$TUNNEL_CLIENT" ]]; then
    "$TUNNEL_CLIENT" runtimes stop "$TUNNEL_ALIAS" --json >/dev/null 2>&1 || true
  fi
  for pid in "$GATEWAY_PID" "$RUNTIME_PID"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  unset RUNTIME_API_KEY
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT INT TERM

cd "$ROOT"

"$BUN_BIN" bin/forge.mjs mcp setup chatgpt \
  --user-level \
  --controller-home "$CONTROLLER_HOME" \
  --host 127.0.0.1 \
  --port "$RUNTIME_PORT" \
  --local-controller-port $((RUNTIME_PORT + 1)) \
  --connector-port "$GATEWAY_PORT" > "$SETUP_LOG"

"$BUN_BIN" bin/forge.mjs repo register "$ROOT" \
  --controller-home "$CONTROLLER_HOME" \
  --json > "$TMP_ROOT/repository.json"

"$BUN_BIN" bin/forge.mjs runtime service install-package \
  --controller-home "$CONTROLLER_HOME" \
  --host 127.0.0.1 \
  --port "$RUNTIME_PORT" \
  --portable > "$INSTALL_JSON"
RUNTIME_PID="$(node -e "const x=require(process.argv[1]); const pid=x?.pid; if(!Number.isInteger(pid)||pid<=0) process.exit(2); process.stdout.write(String(pid))" "$INSTALL_JSON")"

curl --fail --silent --show-error \
  --retry 30 --retry-delay 1 --retry-connrefused \
  "http://127.0.0.1:${RUNTIME_PORT}/ready" > "$TMP_ROOT/runtime-ready.json"

FORGE_CONTROLLER_LIFECYCLE_OWNER=1 \
  "$BUN_BIN" bin/forge.mjs mcp serve \
  --repo "$ROOT" \
  --controller-home "$CONTROLLER_HOME" \
  --transport http \
  --host 127.0.0.1 \
  --port "$GATEWAY_PORT" \
  --profile controller \
  --auth "$MCP_AUTH_MODE" > "$GATEWAY_LOG" 2>&1 &
GATEWAY_PID=$!

case "$MCP_AUTH_MODE" in
  oauth)
    for _ in $(seq 1 30); do
      if curl --fail --silent "http://127.0.0.1:${GATEWAY_PORT}/.well-known/oauth-authorization-server" > "$TMP_ROOT/local-oauth.json" 2>/dev/null; then
        break
      fi
      if ! kill -0 "$GATEWAY_PID" 2>/dev/null; then
        cat "$GATEWAY_LOG" >&2
        exit 1
      fi
      sleep 1
    done
    test -s "$TMP_ROOT/local-oauth.json"
    ;;
  none)
    MCP_INITIALIZE_HEADERS="$TMP_ROOT/mcp-initialize.headers"
    MCP_INITIALIZE_BODY="$TMP_ROOT/mcp-initialize.body"
    MCP_INITIALIZE_PAYLOAD='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"forge-cloud-readiness","version":"1"}}}'
    for _ in $(seq 1 30); do
      if curl --fail --silent --show-error \
        --dump-header "$MCP_INITIALIZE_HEADERS" \
        --output "$MCP_INITIALIZE_BODY" \
        --request POST \
        --header 'content-type: application/json' \
        --header 'accept: application/json, text/event-stream' \
        --data "$MCP_INITIALIZE_PAYLOAD" \
        "http://127.0.0.1:${GATEWAY_PORT}/mcp" 2>/dev/null \
        && grep -Eiq '^mcp-session-id:[[:space:]]*[^[:space:]]+' "$MCP_INITIALIZE_HEADERS" \
        && grep -q 'forge-mcp' "$MCP_INITIALIZE_BODY"; then
        break
      fi
      if ! kill -0 "$GATEWAY_PID" 2>/dev/null; then
        cat "$GATEWAY_LOG" >&2
        exit 1
      fi
      sleep 1
    done
    grep -Eiq '^mcp-session-id:[[:space:]]*[^[:space:]]+' "$MCP_INITIALIZE_HEADERS"
    grep -q 'forge-mcp' "$MCP_INITIALIZE_BODY"
    ;;
  bearer)
    echo 'FORGE_CLOUD_MCP_AUTH_MODE=bearer is not supported by the unauthenticated Secure Tunnel connector path; use oauth or none.' >&2
    exit 2
    ;;
  *)
    echo "unsupported FORGE_CLOUD_MCP_AUTH_MODE: $MCP_AUTH_MODE" >&2
    exit 2
    ;;
esac

mkdir -p "$TUNNEL_DIR"
TUNNEL_CLIENT_ASSET="tunnel-client-${TUNNEL_CLIENT_VERSION}-linux-amd64.zip"
curl -LfsS \
  "https://github.com/openai/tunnel-client/releases/download/${TUNNEL_CLIENT_VERSION}/${TUNNEL_CLIENT_ASSET}" \
  -o "$TUNNEL_ARCHIVE"
unzip -q "$TUNNEL_ARCHIVE" -d "$TUNNEL_DIR"
chmod +x "$TUNNEL_CLIENT" "$TUNNEL_DIR/cloudflared"

FORGE_RUNTIME_API_KEY="$RUNTIME_API_KEY" \
  "$TUNNEL_CLIENT" runtimes connect \
  --alias "$TUNNEL_ALIAS" \
  --tunnel-id "$TUNNEL_ID" \
  --runtime-api-key 'env:FORGE_RUNTIME_API_KEY' \
  --mcp-server-url "http://127.0.0.1:${GATEWAY_PORT}/mcp" \
  --profile "$TUNNEL_ALIAS" \
  --profile-dir "$TMP_ROOT/tunnel-profiles" \
  --json > "$TMP_ROOT/tunnel-connect.json"

"$TUNNEL_CLIENT" runtimes status "$TUNNEL_ALIAS" --json > "$TUNNEL_STATUS_JSON"
node - "$TUNNEL_STATUS_JSON" <<'NODE'
const fs = require('node:fs');
const status = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (status.process_running !== true || status.healthy !== true || status.ready !== true) {
  console.error('FORGE_CLOUD_TUNNEL_NOT_READY');
  process.exit(1);
}
NODE

printf 'FORGE_CLOUD_TUNNEL_ID=%s\n' "$TUNNEL_ID"
printf 'FORGE_CLOUD_TUNNEL_ALIAS=%s\n' "$TUNNEL_ALIAS"
printf 'FORGE_CLOUD_MCP_RUN_ID=%s\n' "${GITHUB_RUN_ID:-unknown}"
printf 'FORGE_CLOUD_MCP_RUNNER_OS=%s\n' "${RUNNER_OS:-unknown}"
printf 'FORGE_CLOUD_MCP_RUNNER_ARCH=%s\n' "${RUNNER_ARCH:-unknown}"
printf 'FORGE_CLOUD_MCP_AUTH_MODE=%s\n' "$MCP_AUTH_MODE"

elapsed=0
while (( elapsed < HOLD_SECONDS )); do
  kill -0 "$RUNTIME_PID" 2>/dev/null || { echo 'runtime exited' >&2; exit 1; }
  kill -0 "$GATEWAY_PID" 2>/dev/null || { cat "$GATEWAY_LOG" >&2; exit 1; }
  "$TUNNEL_CLIENT" runtimes status "$TUNNEL_ALIAS" --json > "$TUNNEL_STATUS_JSON"
  node - "$TUNNEL_STATUS_JSON" <<'NODE'
const fs = require('node:fs');
const status = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (status.process_running !== true || status.healthy !== true || status.ready !== true) process.exit(1);
NODE
  sleep 60
  elapsed=$((elapsed + 60))
  printf 'FORGE_CLOUD_MCP_HEARTBEAT elapsed=%ss tunnel_id=%s\n' "$elapsed" "$TUNNEL_ID"
done
