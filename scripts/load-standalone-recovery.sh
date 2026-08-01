#!/usr/bin/env bash
set -euo pipefail

if [[ "${OSTYPE:-}" != darwin* ]]; then
  echo "standalone recovery LaunchAgents require macOS" >&2
  exit 2
fi

if [[ $# -ne 1 || -z "${1:-}" ]]; then
  echo "usage: $0 /absolute/controller-home" >&2
  exit 2
fi

controller_home="$1"
case "$controller_home" in
  /*) ;;
  *)
    echo "controller home must be an absolute path" >&2
    exit 2
    ;;
esac

uid="$(id -u)"
domain="gui/$uid"

ensure_loaded() {
  local label="$1"
  local plist="$2"
  local target="$domain/$label"

  if launchctl print "$target" >/dev/null 2>&1; then
    printf 'already loaded: %s\n' "$target"
    return 0
  fi
  if [[ ! -f "$plist" ]]; then
    echo "missing LaunchAgent plist: $plist" >&2
    return 1
  fi
  launchctl bootstrap "$domain" "$plist"
  launchctl print "$target" >/dev/null
  printf 'loaded: %s\n' "$target"
}

ensure_loaded \
  com.moretea.repo-harness-recovery-watchdog \
  "$controller_home/recovery/launchd/com.moretea.repo-harness-recovery-watchdog.plist"
ensure_loaded \
  com.moretea.repo-harness-recovery-gateway \
  "$controller_home/recovery/launchd/com.moretea.repo-harness-recovery-gateway.plist"
