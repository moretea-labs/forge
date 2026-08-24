#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUN_BIN="${BUN_BIN:-bun}"
LABEL="${FORGE_MCP_BENCH_LABEL:-host-runtime-direct}"
PORT="${FORGE_MCP_BENCH_PORT:-18765}"
ITERATIONS="${FORGE_MCP_BENCH_ITERATIONS:-50}"
CONNECT_ITERATIONS="${FORGE_MCP_BENCH_CONNECT_ITERATIONS:-30}"

for value in "$PORT" "$ITERATIONS" "$CONNECT_ITERATIONS"; do
  if ! [[ "$value" =~ ^[0-9]+$ ]] || [[ "$value" == "0" ]]; then
    echo "benchmark:mcp-host requires positive integer port/iteration values" >&2
    exit 2
  fi
done
if (( PORT < 1024 || PORT > 65535 )); then
  echo "FORGE_MCP_BENCH_PORT must be between 1024 and 65535" >&2
  exit 2
fi

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/forge-mcp-host-bench.XXXXXX")"
CONTROLLER_HOME="$TMP_ROOT/controller-home"
REGISTER_JSON="$TMP_ROOT/repository.json"
INSTALL_JSON="$TMP_ROOT/runtime-install.json"
READY_JSON="$TMP_ROOT/runtime-ready.json"
STEADY_JSON="$TMP_ROOT/steady.json"
CONNECT_JSON="$TMP_ROOT/connect.json"
RUNTIME_PID=""

cleanup() {
  if [[ -n "$RUNTIME_PID" ]] && kill -0 "$RUNTIME_PID" 2>/dev/null; then
    kill "$RUNTIME_PID" 2>/dev/null || true
    for _ in $(seq 1 20); do
      kill -0 "$RUNTIME_PID" 2>/dev/null || break
      sleep 0.1
    done
    kill -9 "$RUNTIME_PID" 2>/dev/null || true
  fi
  for _ in $(seq 1 5); do
    rm -rf "$TMP_ROOT" 2>/dev/null && return 0
    sleep 0.1
  done
  rm -rf "$TMP_ROOT" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

TOKEN="$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")"
export FORGE_MCP_TOKEN="$TOKEN"
export FORGE_MCP_BENCH_TOKEN="$TOKEN"

cd "$ROOT"
"$BUN_BIN" bin/forge.mjs repo register "$ROOT" \
  --controller-home "$CONTROLLER_HOME" \
  --json > "$REGISTER_JSON"
REPO_ID="$(node -e "const x=require(process.argv[1]); const id=x?.repository?.repoId; if(!id) process.exit(2); process.stdout.write(id)" "$REGISTER_JSON")"

"$BUN_BIN" bin/forge.mjs runtime service install-package \
  --controller-home "$CONTROLLER_HOME" \
  --host 127.0.0.1 \
  --port "$PORT" \
  --portable > "$INSTALL_JSON"
RUNTIME_PID="$(node -e "const x=require(process.argv[1]); const pid=x?.pid; if(!Number.isInteger(pid)||pid<=0) process.exit(2); process.stdout.write(String(pid))" "$INSTALL_JSON")"

curl --fail --silent --show-error \
  --retry 30 --retry-delay 1 --retry-connrefused \
  "http://127.0.0.1:${PORT}/ready" > "$READY_JSON"

"$BUN_BIN" run benchmark:mcp-transport -- \
  --endpoint "http://127.0.0.1:${PORT}/mcp" \
  --label "$LABEL" \
  --repo-id "$REPO_ID" \
  --tool rh_status \
  --iterations "$ITERATIONS" \
  --warmup 3 \
  --timing-log "$CONTROLLER_HOME/audit/mcp-timings.jsonl" > "$STEADY_JSON"

"$BUN_BIN" run benchmark:mcp-transport -- \
  --endpoint "http://127.0.0.1:${PORT}/mcp" \
  --label "$LABEL" \
  --repo-id "$REPO_ID" \
  --tool rh_status \
  --iterations "$CONNECT_ITERATIONS" \
  --warmup 0 \
  --include-connect \
  --timing-log "$CONTROLLER_HOME/audit/mcp-timings.jsonl" > "$CONNECT_JSON"

node - "$STEADY_JSON" "$CONNECT_JSON" "$READY_JSON" <<'NODE'
const fs = require('fs');
const os = require('os');
const path = require('path');
const [steadyPath, connectPath, readyPath] = process.argv.slice(2);
const steady = JSON.parse(fs.readFileSync(steadyPath, 'utf8'));
const connect = JSON.parse(fs.readFileSync(connectPath, 'utf8'));
const ready = JSON.parse(fs.readFileSync(readyPath, 'utf8'));
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  host: {
    platform: process.platform,
    arch: process.arch,
    cpuCount: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
  },
  ready,
  steady,
  connectInclusive: connect,
};
const text = `${JSON.stringify(report, null, 2)}\n`;
const output = process.env.FORGE_MCP_BENCH_OUTPUT?.trim();
if (output) {
  const target = path.resolve(output);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text, 'utf8');
}
process.stdout.write(text);
NODE
