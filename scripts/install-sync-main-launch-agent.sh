#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.moretea.forge.sync-main"
AGENT_DIR="$HOME/Library/LaunchAgents"
PLIST="$AGENT_DIR/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs"
DOMAIN="gui/$(id -u)"

if [[ "${1:-install}" == uninstall ]]; then
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "[sync-main-agent] uninstalled $LABEL"
  exit 0
fi
[[ $# -eq 0 || "$1" == install ]] || {
  echo "Usage: $0 [install|uninstall]" >&2
  exit 2
}

# launchd does not inherit an interactive shell's PATH or proxy environment.
# Preserve explicit proxy variables; otherwise derive HTTP(S) proxy from the
# current macOS system proxy so scheduled Git fetches use the same route.
if [[ -z "${HTTPS_PROXY:-}" ]]; then
  proxy_state="$(scutil --proxy 2>/dev/null || true)"
  proxy_enabled="$(awk '/HTTPSEnable :/{print $3; exit}' <<<"$proxy_state")"
  proxy_host="$(awk '/HTTPSProxy :/{print $3; exit}' <<<"$proxy_state")"
  proxy_port="$(awk '/HTTPSPort :/{print $3; exit}' <<<"$proxy_state")"
  if [[ "$proxy_enabled" == 1 && -n "$proxy_host" && -n "$proxy_port" ]]; then
    export HTTPS_PROXY="http://$proxy_host:$proxy_port"
    export HTTP_PROXY="${HTTP_PROXY:-$HTTPS_PROXY}"
  fi
fi

mkdir -p "$AGENT_DIR" "$LOG_DIR"
python3 - "$PLIST" "$ROOT" "$LABEL" <<'PY'
import os
import plistlib
import sys
from pathlib import Path

plist_path = Path(sys.argv[1])
root = Path(sys.argv[2])
label = sys.argv[3]
logs = Path.home() / 'Library' / 'Logs'
env = {
    'PATH': f"{Path.home()}/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    'GIT_TERMINAL_PROMPT': '0',
    'GIT_HTTP_LOW_SPEED_LIMIT': '1',
    'GIT_HTTP_LOW_SPEED_TIME': '15',
}
for key in ('HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'):
    value = os.environ.get(key)
    if value:
        env[key] = value
payload = {
    'Label': label,
    'ProgramArguments': ['/bin/bash', str(root / 'scripts' / 'sync-main.sh')],
    'WorkingDirectory': str(root),
    'RunAtLoad': True,
    'StartInterval': 300,
    'ProcessType': 'Background',
    'LowPriorityIO': True,
    'EnvironmentVariables': env,
    'StandardOutPath': str(logs / 'forge-sync-main.log'),
    'StandardErrorPath': str(logs / 'forge-sync-main-error.log'),
}
plist_path.write_bytes(plistlib.dumps(payload, fmt=plistlib.FMT_XML, sort_keys=False))
PY

plutil -lint "$PLIST"
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST"
launchctl enable "$DOMAIN/$LABEL"
launchctl kickstart -k "$DOMAIN/$LABEL"
echo "[sync-main-agent] installed $LABEL; sync runs at login and every 300 seconds"
launchctl print "$DOMAIN/$LABEL" | grep -E 'state =|runs =|pid =|working directory =|stdout path =|stderr path ='
