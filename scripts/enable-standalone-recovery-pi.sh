#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="${REPO_HARNESS_SOURCE_REPO_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd -P)}"
CONTROLLER_HOME="${REPO_HARNESS_CONTROLLER_HOME:-$REPO_ROOT/_ops/controller-home}"
RECOVERY_PUBLIC_URL="${REPO_HARNESS_RECOVERY_PUBLIC_URL:-}"
PI_COMMAND="${REPO_HARNESS_PI_COMMAND:-pi}"
TAILSCALE_COMMAND="${REPO_HARNESS_TAILSCALE_COMMAND:-tailscale}"
BUN_COMMAND="${REPO_HARNESS_BUN_COMMAND:-bun}"
NODE_COMMAND="${REPO_HARNESS_NODE_COMMAND:-node}"
CURL_COMMAND="${REPO_HARNESS_CURL_COMMAND:-/usr/bin/curl}"
RECOVERY_TUNNEL_LABEL="${REPO_HARNESS_RECOVERY_TUNNEL_LABEL:-com.moretea.repo-harness-recovery-tunnel}"
PI_MINIMUM_FAILURES="${REPO_HARNESS_PI_MINIMUM_FAILURES:-12}"
PI_MINIMUM_FAILURE_DURATION_MS="${REPO_HARNESS_PI_MINIMUM_FAILURE_DURATION_MS:-300000}"
PI_COOLDOWN_MS="${REPO_HARNESS_PI_COOLDOWN_MS:-3600000}"
PI_TIMEOUT_MS="${REPO_HARNESS_PI_TIMEOUT_MS:-900000}"
PI_REPO_ROOT="${REPO_HARNESS_PI_REPO_ROOT:-}"
MODE="install"

usage() {
  cat <<'EOF'
Usage: enable-standalone-recovery-pi.sh [options]

Modes:
  --install             Enable and verify standalone Recovery PI fallback (default).
  --verify              Verify the installed Recovery PI/tunnel configuration.
  --prepare-workspace   Create or refresh only the owned clean PI workspace.
  --print-plan          Print the bounded installation plan without changing the host.

Options:
  --controller-home PATH
  --recovery-public-url HTTPS_URL   Must end in /recovery/mcp.
  --pi-command PATH
  --pi-repo-root PATH
  --tailscale-command PATH
  --recovery-tunnel-label LABEL
EOF
}

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
log() { printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >&2; }
need_value() { (($# >= 2)) || die "$1 requires a value"; }

while (($#)); do
  case "$1" in
    --install) MODE="install" ;;
    --verify) MODE="verify" ;;
    --prepare-workspace) MODE="prepare" ;;
    --print-plan) MODE="plan" ;;
    --controller-home) need_value "$@"; CONTROLLER_HOME="$2"; shift ;;
    --recovery-public-url) need_value "$@"; RECOVERY_PUBLIC_URL="$2"; shift ;;
    --pi-command) need_value "$@"; PI_COMMAND="$2"; shift ;;
    --pi-repo-root) need_value "$@"; PI_REPO_ROOT="$2"; shift ;;
    --tailscale-command) need_value "$@"; TAILSCALE_COMMAND="$2"; shift ;;
    --recovery-tunnel-label) need_value "$@"; RECOVERY_TUNNEL_LABEL="$2"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done

command_path() {
  local value="$1" resolved directory
  if [[ "$value" == */* ]]; then
    [[ -x "$value" ]] || die "executable is unavailable: $value"
    resolved="$value"
  else
    resolved="$(command -v "$value" 2>/dev/null || true)"
    [[ -n "$resolved" && -x "$resolved" ]] || die "executable is unavailable: $value"
  fi
  directory="$(cd "$(dirname "$resolved")" && pwd -P)"
  printf '%s/%s' "$directory" "$(basename "$resolved")"
}

canonical_path() {
  "$NODE_COMMAND" -e 'process.stdout.write(require("fs").realpathSync(process.argv[1]))' "$1"
}

validate_integer() {
  local name="$1" value="$2" minimum="$3"
  [[ "$value" =~ ^[0-9]+$ ]] && ((value >= minimum)) || die "$name must be an integer >= $minimum"
}

normalize_recovery_url() {
  "$NODE_COMMAND" -e '
    const url = new URL(process.argv[1]);
    if (url.protocol !== "https:" || url.pathname !== "/recovery/mcp" || url.search || url.hash) process.exit(2);
    process.stdout.write(url.toString());
  ' "$1" 2>/dev/null || die "recovery public URL must be HTTPS and end exactly in /recovery/mcp"
}

url_host() { "$NODE_COMMAND" -e 'process.stdout.write(new URL(process.argv[1]).hostname)' "$1"; }
health_url() { "$NODE_COMMAND" -e 'const u=new URL(process.argv[1]); u.pathname="/recovery/health"; process.stdout.write(u.toString())' "$1"; }

config_value() {
  local config="$CONTROLLER_HOME/recovery/config/recovery.json" field="$1"
  [[ -r "$config" ]] || return 0
  "$NODE_COMMAND" -e '
    const fs=require("fs");
    const value=process.argv[2].split(".").reduce((v,k)=>v && v[k], JSON.parse(fs.readFileSync(process.argv[1],"utf8")));
    if (typeof value === "string") process.stdout.write(value);
  ' "$config" "$field"
}

xml_escape() {
  local value="$1"
  value=${value//&/&amp;}; value=${value//</&lt;}; value=${value//>/&gt;}
  printf '%s' "$value"
}

print_command() {
  printf 'INSTALL_COMMAND='
  printf '%q ' "$@"
  printf '\n'
}

REPO_ROOT="$(git -C "$REPO_ROOT" rev-parse --show-toplevel 2>/dev/null)" || die "source repository is not a Git worktree"
if [[ -d "$CONTROLLER_HOME" ]]; then
  CONTROLLER_HOME="$(cd "$CONTROLLER_HOME" && pwd -P)"
elif [[ "$MODE" == "plan" ]]; then
  controller_parent="$(cd "$(dirname "$CONTROLLER_HOME")" && pwd -P)"
  CONTROLLER_HOME="$controller_parent/$(basename "$CONTROLLER_HOME")"
else
  mkdir -p "$CONTROLLER_HOME"
  CONTROLLER_HOME="$(cd "$CONTROLLER_HOME" && pwd -P)"
fi
repo_key="$(printf '%s' "$REPO_ROOT" | shasum -a 256 | awk '{print substr($1,1,12)}')"
if [[ -z "$PI_REPO_ROOT" && "$MODE" == "verify" ]]; then PI_REPO_ROOT="$(config_value agentRepair.repoRoot)"; fi
PI_REPO_ROOT="${PI_REPO_ROOT:-$HOME/.repo-harness/recovery-workspaces/$(basename "$REPO_ROOT")-$repo_key}"
PI_REPO_OWNER_FILE="$PI_REPO_ROOT.owner"
RECOVERY_TUNNEL_PLIST="${REPO_HARNESS_RECOVERY_TUNNEL_PLIST:-$HOME/Library/LaunchAgents/$RECOVERY_TUNNEL_LABEL.plist}"
[[ "$RECOVERY_TUNNEL_LABEL" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{2,180}$ ]] || die "invalid recovery tunnel launchd label"
[[ "$RECOVERY_TUNNEL_PLIST" == /* ]] || die "recovery tunnel plist path must be absolute"
RECOVERY_TUNNEL_HELPER="$CONTROLLER_HOME/recovery/bin/repo-harness-recovery-tailscale-tunnel"
CURRENT_CONFIG="$CONTROLLER_HOME/recovery/config/recovery.json"
PRIMARY_MCP_URL="$(config_value publicMcpUrl)"
LEGACY_PRIMARY_TUNNEL_LABEL="$(config_value publicTunnelService.label)"

validate_integer REPO_HARNESS_PI_MINIMUM_FAILURES "$PI_MINIMUM_FAILURES" 6
validate_integer REPO_HARNESS_PI_MINIMUM_FAILURE_DURATION_MS "$PI_MINIMUM_FAILURE_DURATION_MS" 30000
validate_integer REPO_HARNESS_PI_COOLDOWN_MS "$PI_COOLDOWN_MS" 60000
validate_integer REPO_HARNESS_PI_TIMEOUT_MS "$PI_TIMEOUT_MS" 30000

if [[ -z "$RECOVERY_PUBLIC_URL" && "$MODE" == "verify" ]]; then RECOVERY_PUBLIC_URL="$(config_value recoveryPublicUrl)"; fi
[[ -n "$RECOVERY_PUBLIC_URL" ]] || die "--recovery-public-url or REPO_HARNESS_RECOVERY_PUBLIC_URL is required"
RECOVERY_PUBLIC_URL="$(normalize_recovery_url "$RECOVERY_PUBLIC_URL")"

build_install_command() {
  INSTALL_COMMAND=("$BUN_COMMAND" "$PI_REPO_ROOT/scripts/install-standalone-recovery.ts" --controller-home "$CONTROLLER_HOME")
  if [[ -n "$PRIMARY_MCP_URL" ]]; then INSTALL_COMMAND+=(--public-mcp-url "$PRIMARY_MCP_URL"); fi
  INSTALL_COMMAND+=(
    --recovery-public-url "$RECOVERY_PUBLIC_URL"
    --recovery-tunnel-service-label "$RECOVERY_TUNNEL_LABEL"
    --recovery-tunnel-service-plist "$RECOVERY_TUNNEL_PLIST"
    --enable-pi-agent
    --pi-command "$PI_COMMAND"
    --pi-repo-root "$PI_REPO_ROOT"
    --pi-timeout-ms "$PI_TIMEOUT_MS"
    --pi-cooldown-ms "$PI_COOLDOWN_MS"
    --pi-minimum-failures "$PI_MINIMUM_FAILURES"
    --pi-minimum-failure-duration-ms "$PI_MINIMUM_FAILURE_DURATION_MS"
  )
}

if [[ "$MODE" == "plan" ]]; then
  build_install_command
  printf 'SOURCE_REPO=%s\nPI_REPO_ROOT=%s\nRECOVERY_TUNNEL_LABEL=%s\nRECOVERY_TUNNEL_PLIST=%s\n' \
    "$REPO_ROOT" "$PI_REPO_ROOT" "$RECOVERY_TUNNEL_LABEL" "$RECOVERY_TUNNEL_PLIST"
  if [[ -n "$LEGACY_PRIMARY_TUNNEL_LABEL" ]]; then printf 'PRIMARY_TUNNEL_UNTOUCHED=%s\n' "$LEGACY_PRIMARY_TUNNEL_LABEL"; fi
  printf 'LEGACY_WATCHDOG_ACTION=remove\n'
  print_command "${INSTALL_COMMAND[@]}"
  exit 0
fi

prepare_workspace() {
  local source_head owner temporary parent
  source_head="$(git -C "$REPO_ROOT" rev-parse HEAD)"
  [[ ! -L "$PI_REPO_ROOT" && ! -L "$PI_REPO_OWNER_FILE" ]] || die "PI workspace and ownership marker must not be symlinks"
  if [[ -e "$PI_REPO_ROOT" || -e "$PI_REPO_OWNER_FILE" ]]; then
    [[ -d "$PI_REPO_ROOT/.git" && -r "$PI_REPO_OWNER_FILE" ]] || die "PI workspace exists without a valid ownership marker: $PI_REPO_ROOT"
    owner="$(sed -n '2p' "$PI_REPO_OWNER_FILE")"
    [[ "$owner" == "$REPO_ROOT" ]] || die "PI workspace ownership mismatch: $PI_REPO_ROOT"
    [[ -z "$(git -C "$PI_REPO_ROOT" status --porcelain --untracked-files=all)" ]] || die "owned PI workspace is dirty; refusing to erase recovery evidence"
    git -C "$PI_REPO_ROOT" fetch --prune origin
    git -C "$PI_REPO_ROOT" checkout --detach "$source_head"
  else
    parent="$(dirname "$PI_REPO_ROOT")"
    mkdir -p "$parent"
    parent="$(cd "$parent" && pwd -P)"
    PI_REPO_ROOT="$parent/$(basename "$PI_REPO_ROOT")"
    PI_REPO_OWNER_FILE="$PI_REPO_ROOT.owner"
    temporary="$PI_REPO_ROOT.tmp.$$"
    rm -rf "$temporary"
    if ! git clone --local --no-hardlinks "$REPO_ROOT" "$temporary"; then rm -rf "$temporary"; die "failed to clone the dedicated PI workspace"; fi
    if ! git -C "$temporary" checkout --detach "$source_head"; then rm -rf "$temporary"; die "failed to detach the dedicated PI workspace"; fi
    mv "$temporary" "$PI_REPO_ROOT"
    printf 'repo-harness-recovery-workspace-v1\n%s\n' "$REPO_ROOT" > "$PI_REPO_OWNER_FILE"
    chmod 600 "$PI_REPO_OWNER_FILE"
  fi
  PI_REPO_ROOT="$(cd "$PI_REPO_ROOT" && pwd -P)"
  PI_REPO_OWNER_FILE="$PI_REPO_ROOT.owner"
  [[ -z "$(git -C "$PI_REPO_ROOT" status --porcelain --untracked-files=all)" ]] || die "PI workspace is not clean after preparation"
  [[ "$(git -C "$PI_REPO_ROOT" rev-parse HEAD)" == "$source_head" ]] || die "PI workspace did not reach the source commit"
  log "Prepared clean PI workspace at $PI_REPO_ROOT commit=$source_head"
}

if [[ "$MODE" == "prepare" ]]; then prepare_workspace; exit 0; fi

remove_legacy_watchdog() {
  local label="com.moretea.repo-harness-pi-recovery-watchdog"
  launchctl bootout "gui/$UID/$label" >/dev/null 2>&1 || true
  rm -f "$HOME/Library/LaunchAgents/$label.plist"
  rm -f "$CONTROLLER_HOME/recovery/bin/repo-harness-pi-recovery-watchdog"
  rmdir "$CONTROLLER_HOME/recovery/pi-watchdog/run.lock" >/dev/null 2>&1 || true
}

install_tunnel_service() {
  local tailscale_status tailscale_dns expected_host helper_tmp plist_tmp tailscale_q
  tailscale_status="$($TAILSCALE_COMMAND status --json 2>/dev/null || true)"
  if ! grep -Eq '"BackendState"[[:space:]]*:[[:space:]]*"Running"' <<<"$tailscale_status"; then
    "$TAILSCALE_COMMAND" up
    tailscale_status="$($TAILSCALE_COMMAND status --json)"
  fi
  tailscale_dns="$(printf '%s' "$tailscale_status" | "$NODE_COMMAND" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write((JSON.parse(s).Self?.DNSName||"").replace(/\.$/,"")))')"
  expected_host="$(url_host "$RECOVERY_PUBLIC_URL")"
  [[ -n "$tailscale_dns" && "$expected_host" == "$tailscale_dns" ]] || die "Recovery URL host $expected_host does not match the local Tailscale DNS name $tailscale_dns"

  mkdir -p "$(dirname "$RECOVERY_TUNNEL_HELPER")" "$(dirname "$RECOVERY_TUNNEL_PLIST")" "$CONTROLLER_HOME/recovery/audit"
  helper_tmp="$RECOVERY_TUNNEL_HELPER.tmp.$$"
  tailscale_q="$(printf '%q' "$TAILSCALE_COMMAND")"
  cat > "$helper_tmp" <<EOF
#!/usr/bin/env bash
set -euo pipefail
TAILSCALE=$tailscale_q
status="\$("\$TAILSCALE" status --json 2>/dev/null || true)"
if ! grep -Eq '"BackendState"[[:space:]]*:[[:space:]]*"Running"' <<<"\$status"; then "\$TAILSCALE" up; fi
"\$TAILSCALE" funnel --bg --yes --https=443 --set-path /recovery http://127.0.0.1:8787
"\$TAILSCALE" funnel --bg --yes --https=443 --set-path /.well-known http://127.0.0.1:8787
"\$TAILSCALE" funnel status | grep -q '/recovery'
"\$TAILSCALE" funnel status | grep -q '/.well-known'
EOF
  chmod 700 "$helper_tmp"
  mv "$helper_tmp" "$RECOVERY_TUNNEL_HELPER"
  "$RECOVERY_TUNNEL_HELPER"

  plist_tmp="$RECOVERY_TUNNEL_PLIST.tmp.$$"
  cat > "$plist_tmp" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$(xml_escape "$RECOVERY_TUNNEL_LABEL")</string>
  <key>ProgramArguments</key><array>
    <string>/usr/bin/env</string><string>-i</string>
    <string>HOME=$(xml_escape "$HOME")</string><string>PATH=/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <string>$(xml_escape "$RECOVERY_TUNNEL_HELPER")</string>
  </array>
  <key>RunAtLoad</key><true/><key>StartInterval</key><integer>60</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$(xml_escape "$CONTROLLER_HOME/recovery/audit/tailscale-tunnel.stdout.log")</string>
  <key>StandardErrorPath</key><string>$(xml_escape "$CONTROLLER_HOME/recovery/audit/tailscale-tunnel.stderr.log")</string>
</dict></plist>
EOF
  chmod 600 "$plist_tmp"
  mv "$plist_tmp" "$RECOVERY_TUNNEL_PLIST"
  launchctl bootout "gui/$UID/$RECOVERY_TUNNEL_LABEL" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$UID" "$RECOVERY_TUNNEL_PLIST"
  launchctl kickstart -k "gui/$UID/$RECOVERY_TUNNEL_LABEL"
  launchctl print "gui/$UID/$RECOVERY_TUNNEL_LABEL" >/dev/null
}

verify_install() {
  local recovery_bin="$CONTROLLER_HOME/recovery/bin/repo-harness-recovery" public_health
  [[ -x "$recovery_bin" ]] || die "immutable Recovery binary is unavailable"
  "$NODE_COMMAND" - "$CURRENT_CONFIG" "$RECOVERY_PUBLIC_URL" "$RECOVERY_TUNNEL_LABEL" "$RECOVERY_TUNNEL_PLIST" "$PI_COMMAND" "$PI_REPO_ROOT" "$PI_MINIMUM_FAILURES" "$PI_MINIMUM_FAILURE_DURATION_MS" "$PI_COOLDOWN_MS" <<'NODE'
const fs=require('fs');
const [configPath, publicUrl, label, plist, command, repoRoot, failures, duration, cooldown]=process.argv.slice(2);
const c=JSON.parse(fs.readFileSync(configPath,'utf8'));
const fail=(m)=>{throw new Error(m)};
if (c.recoveryPublicUrl !== publicUrl) fail('recoveryPublicUrl mismatch');
if (c.recoveryTunnelService?.label !== label || c.recoveryTunnelService?.plistPath !== plist) fail('recoveryTunnelService mismatch');
if (c.agentRepair?.enabled !== true) fail('agentRepair is disabled');
if (c.agentRepair?.command !== command || c.agentRepair?.repoRoot !== repoRoot) fail('agentRepair command/workspace mismatch');
if (c.agentRepair?.minimumFailures !== Number(failures) || c.agentRepair?.minimumFailureDurationMs !== Number(duration)) fail('agentRepair failure threshold mismatch');
if (c.agentRepair?.cooldownMs !== Number(cooldown)) fail('agentRepair cooldown mismatch');
console.log('CONFIG_OK');
NODE
  "$recovery_bin" verify --controller-home "$CONTROLLER_HOME"
  launchctl print "gui/$UID/$RECOVERY_TUNNEL_LABEL" >/dev/null
  public_health="$(health_url "$RECOVERY_PUBLIC_URL")"
  "$CURL_COMMAND" -fsS --connect-timeout 5 --max-time 15 "$public_health" >/dev/null
  "$TAILSCALE_COMMAND" funnel status | grep -q '/recovery'
  "$TAILSCALE_COMMAND" funnel status | grep -q '/.well-known'
  printf 'RECOVERY_PI_READY controller_home=%s pi_repo=%s public=%s\n' "$CONTROLLER_HOME" "$PI_REPO_ROOT" "$RECOVERY_PUBLIC_URL"
}

NODE_COMMAND="$(command_path "$NODE_COMMAND")"
NODE_COMMAND="$(canonical_path "$NODE_COMMAND")"
CURL_COMMAND="$(canonical_path "$(command_path "$CURL_COMMAND")")"
TAILSCALE_COMMAND="$(canonical_path "$(command_path "$TAILSCALE_COMMAND")")"
# Preserve the selected shim itself. Realpathing a Volta/asdf/mise shim can
# turn it into a generic dispatcher that refuses direct execution.
PI_COMMAND="$(command_path "$PI_COMMAND")"

if [[ "$MODE" == "verify" ]]; then
  [[ -d "$PI_REPO_ROOT" ]] || die "configured PI workspace is unavailable: $PI_REPO_ROOT"
  PI_REPO_ROOT="$(cd "$PI_REPO_ROOT" && pwd -P)"
  verify_install
  exit 0
fi
[[ "$(uname -s)" == "Darwin" ]] || die "installation currently requires macOS launchd"
BUN_COMMAND="$(canonical_path "$(command_path "$BUN_COMMAND")")"
prepare_workspace
remove_legacy_watchdog
install_tunnel_service
build_install_command
(cd "$PI_REPO_ROOT" && "${INSTALL_COMMAND[@]}")
verify_install
