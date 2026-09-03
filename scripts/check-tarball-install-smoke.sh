#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PACKAGE_VERSION="$(node -e 'const fs=require("node:fs"); const pkg=JSON.parse(fs.readFileSync("package.json","utf8")); console.log(pkg.version)')"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

CLEAN_HOME="$TMP_DIR/home"
CONTROLLER_HOME="$TMP_DIR/controller-home"
XDG_STATE_HOME_DIR="$TMP_DIR/xdg-state"
NPM_CACHE_DIR="$TMP_DIR/npm-cache"
mkdir -p "$CLEAN_HOME" "$XDG_STATE_HOME_DIR" "$NPM_CACHE_DIR"
export HOME="$CLEAN_HOME"
export FORGE_CONTROLLER_HOME="$CONTROLLER_HOME"
export XDG_STATE_HOME="$XDG_STATE_HOME_DIR"
export npm_config_cache="$NPM_CACHE_DIR"
unset BUN_INSTALL

if [[ -e "$FORGE_CONTROLLER_HOME" ]]; then
  echo "[tarball-smoke] ERROR: isolated Controller Home must start empty: $FORGE_CONTROLLER_HOME" >&2
  exit 1
fi

if [[ "$#" -gt 0 ]]; then
  TARBALL_PATH="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
  if [[ ! -f "$TARBALL_PATH" ]]; then
    echo "[tarball-smoke] ERROR: tarball not found: $TARBALL_PATH" >&2
    exit 1
  fi
  TARBALL="$(basename "$TARBALL_PATH")"
else
  PACK_OUTPUT="$(npm pack --silent --pack-destination "$TMP_DIR")"
  TARBALL="$(printf '%s\n' "$PACK_OUTPUT" | awk '/\.tgz$/ { name=$0 } END { print name }')"
  if [[ -z "$TARBALL" ]]; then
    echo "[tarball-smoke] ERROR: npm pack did not report a tarball filename" >&2
    printf '%s\n' "$PACK_OUTPUT" >&2
    exit 1
  fi
  TARBALL_PATH="$TMP_DIR/$TARBALL"
fi
APP_DIR="$TMP_DIR/app"
TARGET_REPO="$TMP_DIR/target-repo"

mkdir -p "$APP_DIR" "$TARGET_REPO"
git -C "$TARGET_REPO" init -q

cd "$APP_DIR"
printf '{"private":true,"name":"forge-tarball-smoke","version":"0.0.0"}
' > package.json
npm install "$TARBALL_PATH" --omit=optional --ignore-scripts --no-audit --no-fund >/dev/null

CLI="$APP_DIR/node_modules/.bin/forge"
HOOK="$APP_DIR/node_modules/.bin/forge-hook"

VERSION="$("$CLI" --version)"
if [[ "$VERSION" != "$PACKAGE_VERSION" ]]; then
  echo "[tarball-smoke] ERROR: forge --version returned $VERSION, expected $PACKAGE_VERSION" >&2
  exit 1
fi

(cd "$TARGET_REPO" && "$CLI" status --json >"$TMP_DIR/status.json")
"$CLI" adopt --repo "$TARGET_REPO" --dry-run --json >"$TMP_DIR/adopt-plan.json"
node - "$TMP_DIR/adopt-plan.json" <<'JS_EOF'
const fs = require('node:fs');
const path = process.argv[2];
const plan = JSON.parse(fs.readFileSync(path, 'utf8'));
if (plan.protocol !== 1 || plan.command !== "adopt" || plan.apply !== false) {
  console.error("[tarball-smoke] ERROR: packaged adopt dry-run did not return protocol v1 plan JSON");
  process.exit(1);
}
JS_EOF

if ! "$CLI" run check-task-workflow --help >/dev/null; then
  echo "[tarball-smoke] ERROR: packaged 'forge run check-task-workflow --help' failed (run dispatcher / helper lookup / bin startup broken)" >&2
  exit 1
fi
printf '{"prompt":"review release readiness"}\n' | "$HOOK" prompt-guard-decide >/dev/null

SETUP_OUTPUT="$TMP_DIR/setup-open.txt"
"$CLI" setup open --controller mcp --tunnel none --capability computer.observe.v1 --json >"$SETUP_OUTPUT"
for marker in \
  "forge setup: open" \
  "Primary controller: mcp" \
  "Install the user-level Forge Runtime" \
  "forge runtime service install-package --controller-home"; do
  if ! grep -Fq "$marker" "$SETUP_OUTPUT"; then
    echo "[tarball-smoke] ERROR: packaged setup did not expose expected bootstrap marker: $marker" >&2
    cat "$SETUP_OUTPUT" >&2
    exit 1
  fi
done

case "$(uname -s)" in
  Darwin)
    if ! grep -Eq 'Platform: macos/[^;]+; service=launchd' "$SETUP_OUTPUT"; then
      echo "[tarball-smoke] ERROR: macOS packaged bootstrap did not select launchd" >&2
      cat "$SETUP_OUTPUT" >&2
      exit 1
    fi
    ;;
  Linux)
    if ! grep -Eq 'Platform: (linux|wsl2)/[^;]+; service=(systemd-user|portable)' "$SETUP_OUTPUT"; then
      echo "[tarball-smoke] ERROR: Linux packaged bootstrap did not select systemd-user or the explicit portable fallback" >&2
      cat "$SETUP_OUTPUT" >&2
      exit 1
    fi
    ;;
esac

COMPUTER_STATUS="$TMP_DIR/computer-status.json"
"$CLI" computer status --controller-home "$FORGE_CONTROLLER_HOME" --json >"$COMPUTER_STATUS"
node - "$COMPUTER_STATUS" <<'JS_EOF'
const fs = require('node:fs');
const path = process.argv[2];
const status = JSON.parse(fs.readFileSync(path, 'utf8'));
if (status.schemaVersion !== 1 || status.product !== 'computer' || !Array.isArray(status.capabilities)) {
  console.error('[tarball-smoke] ERROR: packaged Computer status did not expose the capability-level contract');
  process.exit(1);
}
if (status.ready !== true) {
  const blockers = status.capabilities.filter((entry) => entry.ready !== true);
  if (blockers.length === 0 || blockers.some((entry) => typeof entry.reason !== 'string' || entry.reason.trim().length === 0)) {
    console.error('[tarball-smoke] ERROR: non-ready Computer status lacked a precise capability blocker');
    process.exit(1);
  }
}
JS_EOF

if [[ -d "$FORGE_CONTROLLER_HOME" ]] && grep -RIlF "$ROOT" "$FORGE_CONTROLLER_HOME" 2>/dev/null | grep -q .; then
  echo "[tarball-smoke] ERROR: packaged Controller state captured the Forge source checkout path" >&2
  exit 1
fi

CLI_REALPATH="$(node -e 'const fs=require("node:fs"); console.log(fs.realpathSync(process.argv[1]))' "$CLI")"
APP_REALPATH="$(node -e 'const fs=require("node:fs"); console.log(fs.realpathSync(process.argv[1]))' "$APP_DIR")"
case "$CLI_REALPATH" in
  "$APP_REALPATH"/*) ;;
  *)
    echo "[tarball-smoke] ERROR: packaged forge executable resolved outside isolated install: $CLI_REALPATH" >&2
    exit 1
    ;;
esac

echo "[tarball-smoke] OK: ${TARBALL} installs under isolated HOME/Controller Home and packaged CLI bins start without Bun."
