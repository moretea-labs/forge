#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WATCHDOG="$ROOT/scripts/repo-harness-pi-recovery-watchdog.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
assert_file_contains() { [[ -f "$1" ]] && grep -q -- "$2" "$1" || fail "$1 does not contain $2"; }
assert_file_missing_or_empty() { [[ ! -s "$1" ]] || fail "$1 should be missing or empty"; }

cat > "$TMP/fake-curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
body=""; url=""
while (($#)); do
  case "$1" in
    -o) body="$2"; shift 2 ;;
    -w) shift 2 ;;
    --connect-timeout|--max-time) shift 2 ;;
    -sS|-L) shift ;;
    *) url="$1"; shift ;;
  esac
done
if [[ -f "${FAKE_RECOVERED_FILE:-/nonexistent}" ]]; then
  status=200; payload='{"status":"ok","ready":true}'
elif [[ "$url" == */ready ]]; then
  status="${FAKE_READY_STATUS:-200}"
  if [[ "$status" == 200 ]]; then ready=true; else ready=false; fi
  payload="{\"ready\":$ready,\"sessionCapacity\":{\"recoveryRecommended\":${FAKE_RECOVERY_RECOMMENDED:-false}}}"
elif [[ "$url" == *public* ]]; then
  status="${FAKE_PUBLIC_STATUS:-200}"; payload='{"status":"proxy"}'
else
  status="${FAKE_HEALTH_STATUS:-200}"; payload='{"status":"ok"}'
fi
printf '%s' "$payload" > "$body"
printf '%s' "$status"
[[ "$status" != 000 ]]
EOF
chmod +x "$TMP/fake-curl"

cat > "$TMP/fake-recovery" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
command="$1"
printf '%s\n' "$*" >> "$FAKE_RECOVERY_LOG"
case "$command" in
  status) echo '{"observedState":"degraded","currentOperationId":null}' ;;
  verify) echo '{"ok":false,"probes":{"active_gateway":{"ok":false}}}' ;;
  restart-supervisor) touch "$FAKE_RECOVERED_FILE"; echo '{"ok":true,"detail":"restarted"}' ;;
  *) echo '{"ok":true}' ;;
esac
EOF
chmod +x "$TMP/fake-recovery"

cat > "$TMP/fake-pi" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$FAKE_PI_LOG"
cat >> "$FAKE_PI_INPUT_LOG"
if [[ "${FAKE_PI_RECOVERS:-0}" == 1 ]]; then touch "$FAKE_RECOVERED_FILE"; fi
exit "${FAKE_PI_EXIT:-0}"
EOF
chmod +x "$TMP/fake-pi"

run_watchdog() {
  local state="$1" now="$2"
  mkdir -p "$state"
  env \
    REPO_HARNESS_REPO_ROOT="$ROOT" \
    REPO_HARNESS_CONTROLLER_HOME="$TMP/controller-home" \
    REPO_HARNESS_RECOVERY_BIN="$TMP/fake-recovery" \
    REPO_HARNESS_PI_BIN="$TMP/fake-pi" \
    REPO_HARNESS_CURL_BIN="$TMP/fake-curl" \
    REPO_HARNESS_PI_WATCHDOG_STATE_DIR="$state" \
    REPO_HARNESS_PI_WATCHDOG_NOW_EPOCH="$now" \
    REPO_HARNESS_PI_WATCHDOG_FAILURE_THRESHOLD_SECONDS=300 \
    REPO_HARNESS_PI_WATCHDOG_COOLDOWN_SECONDS=900 \
    REPO_HARNESS_PI_WATCHDOG_TIMEOUT_SECONDS=10 \
    REPO_HARNESS_PI_WATCHDOG_POST_ACTION_DELAY_SECONDS=0 \
    FAKE_HEALTH_STATUS="${FAKE_HEALTH_STATUS:-200}" \
    FAKE_READY_STATUS="${FAKE_READY_STATUS:-200}" \
    FAKE_PUBLIC_STATUS="${FAKE_PUBLIC_STATUS:-200}" \
    FAKE_RECOVERY_RECOMMENDED="${FAKE_RECOVERY_RECOMMENDED:-false}" \
    FAKE_PI_RECOVERS="${FAKE_PI_RECOVERS:-0}" \
    FAKE_PI_EXIT="${FAKE_PI_EXIT:-0}" \
    FAKE_PI_LOG="$state/pi.log" \
    FAKE_PI_INPUT_LOG="$state/pi-input.log" \
    FAKE_RECOVERY_LOG="$state/recovery.log" \
    FAKE_RECOVERED_FILE="$state/recovered" \
    "$WATCHDOG" --once
}

state="$TMP/healthy"
FAKE_HEALTH_STATUS=200 FAKE_READY_STATUS=200 run_watchdog "$state" 1000
assert_file_missing_or_empty "$state/pi.log"

state="$TMP/transient"
FAKE_HEALTH_STATUS=502 FAKE_READY_STATUS=503 run_watchdog "$state" 1000
assert_file_missing_or_empty "$state/pi.log"
[[ "$(cat "$state/first_failure_epoch")" == 1000 ]] || fail "first failure epoch not recorded"

state="$TMP/protected"; mkdir -p "$state"; echo 1 > "$state/first_failure_epoch"
FAKE_HEALTH_STATUS=200 FAKE_READY_STATUS=503 FAKE_RECOVERY_RECOMMENDED=false run_watchdog "$state" 1000
assert_file_missing_or_empty "$state/pi.log"
[[ ! -f "$state/first_failure_epoch" ]] || fail "protected readiness should clear escalation state"

state="$TMP/pi-recovers"; mkdir -p "$state"; echo 100 > "$state/first_failure_epoch"
FAKE_HEALTH_STATUS=502 FAKE_READY_STATUS=503 FAKE_PI_RECOVERS=1 run_watchdog "$state" 500
assert_file_contains "$state/pi.log" "--no-session"
assert_file_contains "$state/pi.log" "--no-context-files"
assert_file_contains "$state/pi-input.log" "Independent recovery verification"
if [[ -f "$state/recovery.log" ]] && grep -q '^restart-supervisor' "$state/recovery.log"; then fail "Supervisor restart should not run after PI recovery"; fi

state="$TMP/fallback"; mkdir -p "$state"; echo 100 > "$state/first_failure_epoch"
FAKE_HEALTH_STATUS=502 FAKE_READY_STATUS=503 FAKE_PI_EXIT=1 run_watchdog "$state" 500
assert_file_contains "$state/recovery.log" "restart-supervisor"
[[ -f "$state/recovered" ]] || fail "fallback restart did not recover"

state="$TMP/cooldown"; mkdir -p "$state"; echo 100 > "$state/first_failure_epoch"; echo 450 > "$state/last_pi_epoch"
FAKE_HEALTH_STATUS=502 FAKE_READY_STATUS=503 run_watchdog "$state" 500
assert_file_missing_or_empty "$state/pi.log"
if [[ -f "$state/recovery.log" ]] && grep -q '^restart-supervisor' "$state/recovery.log"; then fail "cooldown should not restart Supervisor"; fi

# A public-only outage may escalate to PI but must not restart a healthy local Supervisor.
state="$TMP/public-only"; mkdir -p "$state"; echo 100 > "$state/first_failure_epoch"
REPO_HARNESS_PUBLIC_HEALTH_URL="https://public.example/health" \
FAKE_HEALTH_STATUS=200 FAKE_READY_STATUS=200 FAKE_PUBLIC_STATUS=503 FAKE_PI_EXIT=1 run_watchdog "$state" 500
assert_file_contains "$state/pi-input.log" "https://public.example/health"
if [[ -f "$state/recovery.log" ]] && grep -q '^restart-supervisor' "$state/recovery.log"; then fail "public-only outage must not restart a healthy Supervisor"; fi

echo "repo-harness PI recovery watchdog tests passed"
