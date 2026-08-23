#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUN_BIN="${BUN_BIN:-bun}"
RUNTIME_PORT="${FORGE_CLOUD_MCP_RUNTIME_PORT:-18765}"
GATEWAY_PORT="${FORGE_CLOUD_MCP_GATEWAY_PORT:-18767}"
AUTH_PROXY_PORT="${FORGE_CLOUD_OAUTH_PROXY_PORT:-18768}"
HOLD_SECONDS="${FORGE_CLOUD_MCP_HOLD_SECONDS:-1500}"
TUNNEL_ID="${FORGE_CLOUD_TUNNEL_ID:-tunnel_6a8a862b52188191b859cf61e7cdb9a3}"
TUNNEL_ALIAS="${FORGE_CLOUD_TUNNEL_ALIAS:-forge-cloud-ci}"
AUTH_TUNNEL_ID="${FORGE_CLOUD_AUTH_TUNNEL_ID:-52259e78-1451-4c14-85ef-eeffe0e2ef51}"
AUTH_PUBLIC_ORIGIN="${FORGE_CLOUD_AUTH_PUBLIC_ORIGIN:-https://forge-cloud-auth.moretea-lab.tech}"
TUNNEL_CLIENT_VERSION="${FORGE_TUNNEL_CLIENT_VERSION:-v0.0.12}"
RUNTIME_API_KEY_ENV="${FORGE_CLOUD_TUNNEL_RUNTIME_API_KEY_ENV:-CONTROL_PLANE_API_KEY}"

TMP_ROOT="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/forge-cloud-mcp-e2e.XXXXXX")"
CONTROLLER_HOME="$TMP_ROOT/controller-home"
SETUP_LOG="$TMP_ROOT/setup.log"
INSTALL_JSON="$TMP_ROOT/runtime-install.json"
GATEWAY_LOG="$TMP_ROOT/gateway.log"
TUNNEL_ARCHIVE="$TMP_ROOT/tunnel-client.zip"
TUNNEL_DIR="$TMP_ROOT/tunnel-client"
TUNNEL_CLIENT="$TUNNEL_DIR/tunnel-client"
TUNNEL_STATUS_JSON="$TMP_ROOT/tunnel-status.json"
AUTH_PROXY_SCRIPT="$TMP_ROOT/oauth-only-proxy.mjs"
AUTH_TUNNEL_LOG="$TMP_ROOT/oauth-public-tunnel.log"
AUTH_TUNNEL_CREDENTIALS_FILE="$TMP_ROOT/oauth-tunnel-credentials.json"
RUNTIME_PID=''
GATEWAY_PID=''
AUTH_PROXY_PID=''
AUTH_TUNNEL_PID=''

cleanup() {
  if [[ -x "$TUNNEL_CLIENT" ]]; then
    "$TUNNEL_CLIENT" runtimes stop "$TUNNEL_ALIAS" --json >/dev/null 2>&1 || true
  fi
  for pid in "$AUTH_TUNNEL_PID" "$AUTH_PROXY_PID" "$GATEWAY_PID" "$RUNTIME_PID"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  for pid in "$AUTH_TUNNEL_PID" "$AUTH_PROXY_PID" "$GATEWAY_PID" "$RUNTIME_PID"; do
    if [[ -n "$pid" ]]; then
      wait "$pid" 2>/dev/null || true
    fi
  done
  for _ in 1 2 3 4 5; do
    rm -rf "$TMP_ROOT" 2>/dev/null || true
    [[ ! -e "$TMP_ROOT" ]] && break
    sleep 1
  done
}
trap cleanup EXIT INT TERM

if [[ -z "${!RUNTIME_API_KEY_ENV:-}" ]]; then
  echo "FORGE_CLOUD_TUNNEL_RUNTIME_KEY_MISSING env=$RUNTIME_API_KEY_ENV" >&2
  exit 1
fi

if [[ -z "${FORGE_CLOUD_AUTH_TUNNEL_CREDENTIALS_B64:-}" ]]; then
  echo 'FORGE_CLOUD_AUTH_TUNNEL_CREDENTIALS_MISSING' >&2
  exit 1
fi

cd "$ROOT"

mkdir -p "$TUNNEL_DIR"
TUNNEL_CLIENT_ASSET="tunnel-client-${TUNNEL_CLIENT_VERSION}-linux-amd64.zip"
curl -LfsS \
  "https://github.com/openai/tunnel-client/releases/download/${TUNNEL_CLIENT_VERSION}/${TUNNEL_CLIENT_ASSET}" \
  -o "$TUNNEL_ARCHIVE"
unzip -q "$TUNNEL_ARCHIVE" -d "$TUNNEL_DIR"
chmod +x "$TUNNEL_CLIENT" "$TUNNEL_DIR/cloudflared"

cat > "$AUTH_PROXY_SCRIPT" <<'NODE'
import http from 'node:http';
const upstreamPort = Number(process.argv[2]);
const listenPort = Number(process.argv[3]);
const allowed = new Set([
  '/.well-known/oauth-authorization-server',
  '/authorize',
  '/token',
  '/register',
  '/revoke',
]);
const server = http.createServer((req, res) => {
  const parsed = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (!allowed.has(parsed.pathname)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return;
  }
  const headers = { ...req.headers, host: `127.0.0.1:${upstreamPort}` };
  const upstream = http.request({
    hostname: '127.0.0.1',
    port: upstreamPort,
    method: req.method,
    path: req.url,
    headers,
  }, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
    upstreamRes.pipe(res);
  });
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('oauth upstream unavailable');
  });
  req.pipe(upstream);
});
server.listen(listenPort, '127.0.0.1');
NODE
node "$AUTH_PROXY_SCRIPT" "$GATEWAY_PORT" "$AUTH_PROXY_PORT" > "$TMP_ROOT/oauth-proxy.log" 2>&1 &
AUTH_PROXY_PID=$!

umask 077
printf '%s' "$FORGE_CLOUD_AUTH_TUNNEL_CREDENTIALS_B64" | base64 --decode > "$AUTH_TUNNEL_CREDENTIALS_FILE"
chmod 600 "$AUTH_TUNNEL_CREDENTIALS_FILE"

"$TUNNEL_DIR/cloudflared" tunnel --no-autoupdate \
  --credentials-file "$AUTH_TUNNEL_CREDENTIALS_FILE" \
  --url "http://127.0.0.1:${AUTH_PROXY_PORT}" \
  run "$AUTH_TUNNEL_ID" > "$AUTH_TUNNEL_LOG" 2>&1 &
AUTH_TUNNEL_PID=$!

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

FORGE_MCP_PUBLIC_ORIGIN="$AUTH_PUBLIC_ORIGIN" \
FORGE_CONTROLLER_LIFECYCLE_OWNER=1 \
  "$BUN_BIN" bin/forge.mjs mcp serve \
  --repo "$ROOT" \
  --controller-home "$CONTROLLER_HOME" \
  --transport http \
  --host 127.0.0.1 \
  --port "$GATEWAY_PORT" \
  --profile controller \
  --auth oauth > "$GATEWAY_LOG" 2>&1 &
GATEWAY_PID=$!

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

curl --fail --silent --show-error \
  --retry 20 --retry-delay 1 --retry-all-errors \
  "$AUTH_PUBLIC_ORIGIN/.well-known/oauth-authorization-server" > "$TMP_ROOT/public-oauth.json"
node - "$TMP_ROOT/public-oauth.json" "$AUTH_PUBLIC_ORIGIN" <<'NODE'
const fs = require('node:fs');
const metadata = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const origin = process.argv[3];
if (metadata.authorization_endpoint !== `${origin}/authorize`) {
  console.error('FORGE_CLOUD_OAUTH_AUTHORIZATION_ENDPOINT_MISMATCH');
  process.exit(1);
}
NODE

"$TUNNEL_CLIENT" runtimes connect \
  --alias "$TUNNEL_ALIAS" \
  --tunnel-id "$TUNNEL_ID" \
  --runtime-api-key "env:$RUNTIME_API_KEY_ENV" \
  --mcp-server-url "http://127.0.0.1:${GATEWAY_PORT}/mcp" \
  --profile "$TUNNEL_ALIAS" \
  --profile-dir "$TMP_ROOT/tunnel-profiles" \
  --json > "$TMP_ROOT/tunnel-connect.json"

"$TUNNEL_CLIENT" runtimes status "$TUNNEL_ALIAS" --json > "$TUNNEL_STATUS_JSON"
node - "$TUNNEL_STATUS_JSON" <<'NODE'
const fs = require('node:fs');
const status = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (status.healthy !== true || status.ready !== true) {
  console.error('FORGE_CLOUD_TUNNEL_NOT_READY');
  process.exit(1);
}
NODE

printf 'FORGE_CLOUD_TUNNEL_ID=%s\n' "$TUNNEL_ID"
printf 'FORGE_CLOUD_TUNNEL_ALIAS=%s\n' "$TUNNEL_ALIAS"
printf 'FORGE_CLOUD_OAUTH_ORIGIN=%s\n' "$AUTH_PUBLIC_ORIGIN"
printf 'FORGE_CLOUD_MCP_RUN_ID=%s\n' "${GITHUB_RUN_ID:-unknown}"
printf 'FORGE_CLOUD_MCP_RUNNER_OS=%s\n' "${RUNNER_OS:-unknown}"
printf 'FORGE_CLOUD_MCP_RUNNER_ARCH=%s\n' "${RUNNER_ARCH:-unknown}"

elapsed=0
while (( elapsed < HOLD_SECONDS )); do
  kill -0 "$RUNTIME_PID" 2>/dev/null || { echo 'runtime exited' >&2; exit 1; }
  kill -0 "$GATEWAY_PID" 2>/dev/null || { cat "$GATEWAY_LOG" >&2; exit 1; }
  "$TUNNEL_CLIENT" runtimes status "$TUNNEL_ALIAS" --json > "$TUNNEL_STATUS_JSON"
  node - "$TUNNEL_STATUS_JSON" <<'NODE'
const fs = require('node:fs');
const status = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (status.healthy !== true || status.ready !== true) process.exit(1);
NODE
  sleep 60
  elapsed=$((elapsed + 60))
  printf 'FORGE_CLOUD_MCP_HEARTBEAT elapsed=%ss tunnel_id=%s\n' "$elapsed" "$TUNNEL_ID"
done
# fresh-run trigger after Actions secret provisioning
# fresh-run trigger after exact workflow secret provisioning

# Secure Tunnel is the external trust boundary; loopback cloud MCP intentionally uses auth none.
