#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
SCRIPT="$ROOT/scripts/enable-standalone-recovery-pi.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
assert_contains() { grep -q -- "$2" "$1" || fail "$1 does not contain $2"; }
assert_not_contains() { if grep -q -- "$2" "$1"; then fail "$1 unexpectedly contains $2"; fi; }

bash -n "$SCRIPT"

SOURCE="$TMP/source"
mkdir -p "$SOURCE"
git -C "$SOURCE" init -q
git -C "$SOURCE" config user.email recovery-test@example.invalid
git -C "$SOURCE" config user.name recovery-test
printf 'stable\n' > "$SOURCE/README.md"
git -C "$SOURCE" add README.md
git -C "$SOURCE" commit -qm initial

CONTROLLER="$TMP/controller-home"
mkdir -p "$CONTROLLER/recovery/config"
cat > "$CONTROLLER/recovery/config/recovery.json" <<'JSON'
{
  "schemaVersion": 1,
  "publicMcpUrl": "https://primary.example.test/mcp",
  "publicTunnelService": {
    "platform": "launchd",
    "label": "com.cloudflare.cloudflared",
    "plistPath": "/tmp/com.cloudflare.cloudflared.plist"
  }
}
JSON

PLAN="$TMP/plan.txt"
env \
  REPO_HARNESS_SOURCE_REPO_ROOT="$SOURCE" \
  REPO_HARNESS_CONTROLLER_HOME="$CONTROLLER" \
  REPO_HARNESS_RECOVERY_PUBLIC_URL="https://device.tailnet.ts.net/recovery/mcp" \
  REPO_HARNESS_PI_COMMAND="/fake/pi" \
  REPO_HARNESS_TAILSCALE_COMMAND="/fake/tailscale" \
  REPO_HARNESS_BUN_COMMAND="/fake/bun" \
  REPO_HARNESS_PI_REPO_ROOT="$TMP/pi-workspace" \
  "$SCRIPT" --print-plan > "$PLAN"

assert_contains "$PLAN" "--public-mcp-url"
assert_contains "$PLAN" "https://primary.example.test/mcp"
assert_contains "$PLAN" "--recovery-public-url"
assert_contains "$PLAN" "--recovery-tunnel-service-label"
assert_contains "$PLAN" "--enable-pi-agent"
assert_contains "$PLAN" "--pi-minimum-failure-duration-ms"
assert_contains "$PLAN" "300000"
assert_contains "$PLAN" "PRIMARY_TUNNEL_UNTOUCHED=com.cloudflare.cloudflared"
assert_contains "$PLAN" "LEGACY_WATCHDOG_ACTION=remove"
assert_not_contains "$PLAN" "--public-tunnel-service-label"

if env \
  REPO_HARNESS_SOURCE_REPO_ROOT="$SOURCE" \
  REPO_HARNESS_CONTROLLER_HOME="$CONTROLLER" \
  REPO_HARNESS_RECOVERY_PUBLIC_URL="http://device.tailnet.ts.net/recovery/mcp" \
  REPO_HARNESS_PI_REPO_ROOT="$TMP/invalid" \
  "$SCRIPT" --print-plan >/dev/null 2>&1; then
  fail "insecure recovery URL was accepted"
fi

PI_WORKSPACE="$TMP/pi-workspace"
env \
  REPO_HARNESS_SOURCE_REPO_ROOT="$SOURCE" \
  REPO_HARNESS_CONTROLLER_HOME="$CONTROLLER" \
  REPO_HARNESS_RECOVERY_PUBLIC_URL="https://device.tailnet.ts.net/recovery/mcp" \
  REPO_HARNESS_PI_REPO_ROOT="$PI_WORKSPACE" \
  "$SCRIPT" --prepare-workspace >/dev/null

[[ -d "$PI_WORKSPACE/.git" ]] || fail "dedicated PI clone was not created"
[[ -r "$PI_WORKSPACE.owner" ]] || fail "workspace ownership marker was not created"
[[ -z "$(git -C "$PI_WORKSPACE" status --porcelain --untracked-files=all)" ]] || fail "prepared PI workspace is dirty"
[[ "$(git -C "$PI_WORKSPACE" rev-parse HEAD)" == "$(git -C "$SOURCE" rev-parse HEAD)" ]] || fail "PI workspace commit mismatch"

printf 'dirty\n' >> "$PI_WORKSPACE/README.md"
if env \
  REPO_HARNESS_SOURCE_REPO_ROOT="$SOURCE" \
  REPO_HARNESS_CONTROLLER_HOME="$CONTROLLER" \
  REPO_HARNESS_RECOVERY_PUBLIC_URL="https://device.tailnet.ts.net/recovery/mcp" \
  REPO_HARNESS_PI_REPO_ROOT="$PI_WORKSPACE" \
  "$SCRIPT" --prepare-workspace >/dev/null 2>&1; then
  fail "dirty PI workspace was erased"
fi

printf 'standalone Recovery PI enablement tests passed\n'


# Installer must preserve an executable shim path instead of resolving its
# target. This models Volta, whose generic dispatcher rejects direct calls.
SHIM_DIR="$TMP/shims"
SHIM_TARGET="$TMP/volta-shim"
SHIM_PATH="$SHIM_DIR/pi"
mkdir -p "$SHIM_DIR"
cat > "$SHIM_TARGET" <<'EOF'
#!/usr/bin/env bash
[[ "$(basename "$0")" != "volta-shim" ]]
EOF
chmod 755 "$SHIM_TARGET"
ln -s "$SHIM_TARGET" "$SHIM_PATH"
"$SHIM_PATH" || fail "shim path should be executable"
if "$SHIM_TARGET"; then fail "direct generic dispatcher should fail"; fi

INSTALLER_CONTROLLER="$TMP/installer-controller"
INSTALLER_OUTPUT="$TMP/installer-output.json"
(
  cd "$ROOT"
  bun scripts/install-standalone-recovery.ts \
    --controller-home "$INSTALLER_CONTROLLER" \
    --stage-only \
    --enable-pi-agent \
    --pi-command "$SHIM_PATH" \
    --pi-repo-root "$SOURCE"
) > "$INSTALLER_OUTPUT"
node - "$INSTALLER_OUTPUT" "$SHIM_PATH" <<'NODE'
const fs = require('fs');
const [outputPath, shimPath] = process.argv.slice(2);
const output = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
if (output.config?.agentRepair?.command !== shimPath) {
  throw new Error(`installer rewrote shim path: ${output.config?.agentRepair?.command}`);
}
NODE

printf 'standalone Recovery PI shim regression passed\n'
