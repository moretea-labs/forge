#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${REPO_HARNESS_REPO_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
CONTROLLER_HOME="${REPO_HARNESS_CONTROLLER_HOME:-$REPO_ROOT/_ops/controller-home}"
RECOVERY_BIN="${REPO_HARNESS_RECOVERY_BIN:-$CONTROLLER_HOME/recovery/bin/repo-harness-recovery}"
PI_BIN="${REPO_HARNESS_PI_BIN:-pi}"
CURL_BIN="${REPO_HARNESS_CURL_BIN:-/usr/bin/curl}"
LOCAL_BASE_URL="${REPO_HARNESS_LOCAL_BASE_URL:-http://127.0.0.1:8765}"
PUBLIC_HEALTH_URL="${REPO_HARNESS_PUBLIC_HEALTH_URL:-}"
CHECK_INTERVAL_SECONDS="${REPO_HARNESS_PI_WATCHDOG_INTERVAL_SECONDS:-15}"
FAILURE_THRESHOLD_SECONDS="${REPO_HARNESS_PI_WATCHDOG_FAILURE_THRESHOLD_SECONDS:-300}"
PI_COOLDOWN_SECONDS="${REPO_HARNESS_PI_WATCHDOG_COOLDOWN_SECONDS:-900}"
PI_TIMEOUT_SECONDS="${REPO_HARNESS_PI_WATCHDOG_TIMEOUT_SECONDS:-1200}"
POST_ACTION_DELAY_SECONDS="${REPO_HARNESS_PI_WATCHDOG_POST_ACTION_DELAY_SECONDS:-10}"
STATE_DIR="${REPO_HARNESS_PI_WATCHDOG_STATE_DIR:-$CONTROLLER_HOME/recovery/pi-watchdog}"
LOG_FILE="${REPO_HARNESS_PI_WATCHDOG_LOG_FILE:-$STATE_DIR/watchdog.log}"
LABEL="com.moretea.repo-harness-pi-recovery-watchdog"
MODE="run"

usage() {
  cat <<'EOF'
Usage: repo-harness-pi-recovery-watchdog.sh [--once|--install|--uninstall]

  --once       Run one probe/escalation cycle.
  --install    Copy this script below Controller Home and install a user LaunchAgent.
  --uninstall  Remove the user LaunchAgent. State and logs are preserved.
EOF
}

while (($#)); do
  case "$1" in
    --once) MODE="once" ;;
    --install) MODE="install" ;;
    --uninstall) MODE="uninstall" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR" 2>/dev/null || true

log() {
  printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" | tee -a "$LOG_FILE" >&2
}

require_positive_integer() {
  local name="$1" value="$2"
  if ! [[ "$value" =~ ^[0-9]+$ ]] || ((value <= 0)); then
    log "$name must be a positive integer, got: $value"
    exit 2
  fi
}

require_positive_integer CHECK_INTERVAL_SECONDS "$CHECK_INTERVAL_SECONDS"
require_positive_integer FAILURE_THRESHOLD_SECONDS "$FAILURE_THRESHOLD_SECONDS"
require_positive_integer PI_COOLDOWN_SECONDS "$PI_COOLDOWN_SECONDS"
require_positive_integer PI_TIMEOUT_SECONDS "$PI_TIMEOUT_SECONDS"

now_epoch() {
  if [[ -n "${REPO_HARNESS_PI_WATCHDOG_NOW_EPOCH:-}" ]]; then
    printf '%s' "$REPO_HARNESS_PI_WATCHDOG_NOW_EPOCH"
  else
    date +%s
  fi
}

read_state() {
  local key="$1" fallback="$2"
  if [[ -r "$STATE_DIR/$key" ]]; then cat "$STATE_DIR/$key"; else printf '%s' "$fallback"; fi
}

write_state() {
  local key="$1" value="$2"
  local temporary="$STATE_DIR/$key.$"
  printf '%s' "$value" > "$temporary"
  mv "$temporary" "$STATE_DIR/$key"
}

clear_failure_state() {
  rm -f "$STATE_DIR/first_failure_epoch" "$STATE_DIR/consecutive_failures" "$STATE_DIR/last_failure_summary"
}

is_2xx() { [[ "$1" =~ ^2[0-9][0-9]$ ]]; }
is_retryable() { [[ "$1" == "000" || "$1" == "502" || "$1" == "503" ]]; }

probe_url() {
  local name="$1" url="$2" status
  local body_tmp="$STATE_DIR/$name.body.$"
  status="$($CURL_BIN -sS -L --connect-timeout 5 --max-time 10 -o "$body_tmp" -w '%{http_code}' "$url" 2>/dev/null || true)"
  [[ "$status" =~ ^[0-9]{3}$ ]] || status="000"
  [[ -f "$body_tmp" ]] || : > "$body_tmp"
  mv "$body_tmp" "$STATE_DIR/$name.body"
  write_state "$name.status" "$status"
  printf '%s' "$status"
}

ready_recovery_recommended() {
  grep -Eq '"recoveryRecommended"[[:space:]]*:[[:space:]]*true' "$STATE_DIR/ready.body" 2>/dev/null
}

collect_probe() {
  local health ready public="disabled"
  health="$(probe_url health "$LOCAL_BASE_URL/health")"
  ready="$(probe_url ready "$LOCAL_BASE_URL/ready")"
  if [[ -n "$PUBLIC_HEALTH_URL" ]]; then public="$(probe_url public "$PUBLIC_HEALTH_URL")"; fi
  printf '%s|%s|%s' "$health" "$ready" "$public"
}

probe_local_is_healthy() {
  local summary="$1" health ready public
  IFS='|' read -r health ready public <<<"$summary"
  is_2xx "$health" && is_2xx "$ready"
}

probe_is_healthy() {
  local summary="$1" health ready public
  IFS='|' read -r health ready public <<<"$summary"
  probe_local_is_healthy "$summary" && { [[ "$public" == "disabled" ]] || is_2xx "$public"; }
}

probe_is_escalatable() {
  local summary="$1" health ready public
  IFS='|' read -r health ready public <<<"$summary"
  if is_retryable "$health"; then return 0; fi
  if is_2xx "$health" && [[ "$ready" == "503" ]] && ready_recovery_recommended; then return 0; fi
  if [[ "$public" != "disabled" ]] && is_retryable "$public"; then return 0; fi
  return 1
}

recovery_json() {
  local command="$1"
  if [[ ! -x "$RECOVERY_BIN" ]]; then
    printf '{"ok":false,"error":"RECOVERY_BINARY_UNAVAILABLE"}'
    return 127
  fi
  "$RECOVERY_BIN" "$command" --controller-home "$CONTROLLER_HOME" 2>>"$LOG_FILE"
}

write_pi_input() {
  local summary="$1" status_json="$2" verify_json="$3" output_path="$4"
  cat > "$output_path" <<EOF
Repository: $REPO_ROOT
Controller Home: $CONTROLLER_HOME
Public health URL: ${PUBLIC_HEALTH_URL:-disabled}
Observed health statuses (local health|local ready|public health): $summary

Independent recovery status:
$status_json

Independent recovery verification:
$verify_json
EOF
  chmod 600 "$output_path"
}

pi_prompt() {
  cat <<'EOF'
Act as the bounded recovery engineer for repo-harness-controller-runtime. The primary endpoint has remained at HTTP 502/503 or unreachable beyond the local recovery grace period.

Restore service with the smallest safe action and prove recovery. First inspect the supplied independent recovery status/verification and current repository Git status. Preserve every pre-existing uncommitted change. Prefer the immutable recovery binary, Supervisor/Gateway restart, and connector reconnection over source changes. Never reset, clean, force-checkout, rewrite history, delete unknown worktrees, expose credentials, or perform remote writes. Never roll back unless the independent recovery evidence proves the exact Supervisor-registered previous release is known-good.

If a source fix is necessary, create an isolated worktree and branch, make only the bounded stability fix, run targeted checks, commit, merge to the source branch only when safe, then delete the temporary worktree and branch. Re-check local /health, /ready, independent recovery verify, and the public endpoint before declaring success. Return a concise evidence report.
EOF
}

run_pi_with_timeout() {
  local input_path="$1" prompt="$2" child deadline rc process_state
  (
    cd "$REPO_ROOT"
    "$PI_BIN" --approve --no-session --no-extensions --no-skills --no-prompt-templates --no-context-files \
      --tools read,bash,edit,write,grep,find,ls -p "$prompt" < "$input_path"
  ) >>"$LOG_FILE" 2>&1 &
  child=$!
  deadline=$(( $(date +%s) + PI_TIMEOUT_SECONDS ))
  while kill -0 "$child" 2>/dev/null; do
    process_state="$(ps -o stat= -p "$child" 2>/dev/null | tr -d '[:space:]')"
    if [[ -z "$process_state" || "$process_state" == Z* ]]; then break; fi
    if (( $(date +%s) >= deadline )); then
      log "PI timeout reached; terminating pid=$child"
      kill -TERM "$child" 2>/dev/null || true
      sleep 2
      kill -KILL "$child" 2>/dev/null || true
      break
    fi
    sleep 1
  done
  if wait "$child"; then rc=0; else rc=$?; fi
  return "$rc"
}

invoke_pi() {
  local summary="$1" now last_pi status_json verify_json input_path prompt rc
  now="$(now_epoch)"
  last_pi="$(read_state last_pi_epoch 0)"
  if ((last_pi > 0 && now - last_pi < PI_COOLDOWN_SECONDS)); then
    log "PI escalation suppressed by cooldown; remaining=$((PI_COOLDOWN_SECONDS - (now - last_pi)))s"
    return 3
  fi
  if ! command -v "$PI_BIN" >/dev/null 2>&1 && [[ ! -x "$PI_BIN" ]]; then
    log "PI CLI unavailable: $PI_BIN"
    return 127
  fi

  status_json="$(recovery_json status || true)"
  verify_json="$(recovery_json verify || true)"
  input_path="$STATE_DIR/pi-input.$now.json"
  write_pi_input "$summary" "$status_json" "$verify_json" "$input_path"
  prompt="$(pi_prompt)"
  write_state last_pi_epoch "$now"
  log "Escalating sustained outage to PI; summary=$summary"
  if run_pi_with_timeout "$input_path" "$prompt"; then rc=0; else rc=$?; fi
  rm -f "$input_path"
  if ((rc == 0)); then
    log "PI completed; verifying recovery"
    return 0
  fi
  log "PI failed or timed out; rc=$rc"
  return "$rc"
}

fallback_restart_supervisor() {
  local now request_id
  [[ -x "$RECOVERY_BIN" ]] || return 127
  now="$(now_epoch)"
  request_id="pi-watchdog-$now"
  log "Requesting bounded independent Supervisor restart; request_id=$request_id"
  "$RECOVERY_BIN" restart-supervisor --controller-home "$CONTROLLER_HOME" --request-id "$request_id" >>"$LOG_FILE" 2>&1
}

cycle() {
  local now summary first failures elapsed post_summary pi_rc
  now="$(now_epoch)"
  summary="$(collect_probe)"
  if probe_is_healthy "$summary"; then
    if [[ -f "$STATE_DIR/first_failure_epoch" ]]; then log "Recovered; summary=$summary"; fi
    clear_failure_state
    return 0
  fi

  if ! probe_is_escalatable "$summary"; then
    log "Observed non-escalatable state; summary=$summary"
    clear_failure_state
    return 0
  fi

  first="$(read_state first_failure_epoch "$now")"
  failures="$(read_state consecutive_failures 0)"
  failures=$((failures + 1))
  write_state first_failure_epoch "$first"
  write_state consecutive_failures "$failures"
  write_state last_failure_summary "$summary"
  elapsed=$((now - first))
  log "Retryable outage; summary=$summary elapsed=${elapsed}s failures=$failures"

  if ((elapsed < FAILURE_THRESHOLD_SECONDS)); then return 0; fi
  if invoke_pi "$summary"; then pi_rc=0; else pi_rc=$?; fi
  if ((pi_rc == 3)); then return 0; fi

  if ((POST_ACTION_DELAY_SECONDS > 0)); then sleep "$POST_ACTION_DELAY_SECONDS"; fi
  post_summary="$(collect_probe)"
  if probe_is_healthy "$post_summary"; then
    log "Recovered after PI; summary=$post_summary"
    clear_failure_state
    return 0
  fi

  log "Still unhealthy after PI; summary=$post_summary"
  if probe_local_is_healthy "$post_summary"; then
    log "Local runtime remains healthy; refusing Supervisor restart for a public-only outage"
    return 0
  fi
  fallback_restart_supervisor || true
  if ((POST_ACTION_DELAY_SECONDS > 0)); then sleep "$POST_ACTION_DELAY_SECONDS"; fi
  post_summary="$(collect_probe)"
  if probe_is_healthy "$post_summary"; then
    log "Recovered after independent Supervisor restart; summary=$post_summary"
    clear_failure_state
  else
    log "Recovery remains incomplete; summary=$post_summary"
  fi
}

xml_escape() {
  local value="$1"
  value=${value//&/&amp;}; value=${value//</&lt;}; value=${value//>/&gt;}
  printf '%s' "$value"
}

install_launchagent() {
  [[ "$(uname -s)" == "Darwin" ]] || { log "--install currently supports macOS launchd only"; exit 2; }
  command -v "$PI_BIN" >/dev/null 2>&1 || { log "PI CLI unavailable: $PI_BIN"; exit 2; }
  [[ -x "$RECOVERY_BIN" ]] || { log "Independent recovery binary unavailable: $RECOVERY_BIN"; exit 2; }
  local installed_dir installed_script agent_dir agent_plist install_repo_root common_git_dir
  local repo_xml home_xml pi_xml path_xml public_health_xml user_home_xml user_xml logname_xml
  installed_dir="$CONTROLLER_HOME/recovery/bin"
  installed_script="$installed_dir/repo-harness-pi-recovery-watchdog"
  agent_dir="$HOME/Library/LaunchAgents"
  agent_plist="$agent_dir/$LABEL.plist"
  mkdir -p "$installed_dir" "$agent_dir" "$CONTROLLER_HOME/recovery/audit"
  cp "$0" "$installed_script"
  chmod 700 "$installed_script"
  install_repo_root="$REPO_ROOT"
  common_git_dir="$(git -C "$REPO_ROOT" rev-parse --git-common-dir 2>/dev/null || true)"
  if [[ -n "$common_git_dir" ]]; then
    [[ "$common_git_dir" == /* ]] || common_git_dir="$REPO_ROOT/$common_git_dir"
    install_repo_root="$(cd "$common_git_dir/.." && pwd -P)"
  fi
  repo_xml="$(xml_escape "$install_repo_root")"; home_xml="$(xml_escape "$CONTROLLER_HOME")"
  pi_xml="$(xml_escape "$(command -v "$PI_BIN")")"; path_xml="$(xml_escape "$PATH")"
  public_health_xml="$(xml_escape "$PUBLIC_HEALTH_URL")"
  user_home_xml="$(xml_escape "$HOME")"; user_xml="$(xml_escape "${USER:-$(id -un)}")"
  logname_xml="$(xml_escape "${LOGNAME:-${USER:-$(id -un)}}")"
  cat > "$agent_plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>/usr/bin/env</string><string>-i</string>
    <string>HOME=$user_home_xml</string><string>USER=$user_xml</string><string>LOGNAME=$logname_xml</string>
    <string>PATH=$path_xml</string><string>PI_CODING_AGENT_DIR=$user_home_xml/.pi/agent</string>
    <string>REPO_HARNESS_REPO_ROOT=$repo_xml</string>
    <string>REPO_HARNESS_CONTROLLER_HOME=$home_xml</string>
    <string>REPO_HARNESS_PI_BIN=$pi_xml</string>
    <string>REPO_HARNESS_PUBLIC_HEALTH_URL=$public_health_xml</string>
    <string>$(xml_escape "$installed_script")</string>
  </array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$home_xml/recovery/audit/pi-watchdog.stdout.log</string>
  <key>StandardErrorPath</key><string>$home_xml/recovery/audit/pi-watchdog.stderr.log</string>
</dict></plist>
EOF
  chmod 600 "$agent_plist"
  launchctl bootout "gui/$UID/$LABEL" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$UID" "$agent_plist"
  launchctl kickstart -k "gui/$UID/$LABEL"
  log "Installed and started LaunchAgent: $LABEL"
}

uninstall_launchagent() {
  local agent_plist="$HOME/Library/LaunchAgents/$LABEL.plist"
  launchctl bootout "gui/$UID/$LABEL" >/dev/null 2>&1 || true
  rm -f "$agent_plist"
  log "Uninstalled LaunchAgent: $LABEL"
}

case "$MODE" in
  install) install_launchagent; exit 0 ;;
  uninstall) uninstall_launchagent; exit 0 ;;
esac

LOCK_DIR="$STATE_DIR/run.lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  log "Another PI recovery watchdog instance already owns the lock"
  exit 0
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT INT TERM

log "PI recovery watchdog started; local=$LOCAL_BASE_URL threshold=${FAILURE_THRESHOLD_SECONDS}s interval=${CHECK_INTERVAL_SECONDS}s"
while true; do
  cycle || true
  [[ "$MODE" == "once" ]] && break
  sleep "$CHECK_INTERVAL_SECONDS"
done
