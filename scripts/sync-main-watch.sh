#!/usr/bin/env bash
# Periodically fast-forward local main to origin/main via scripts/sync-main.sh.
# Does not commit, stash, rebase, reset, or create branches.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INTERVAL_SECONDS="${1:-300}"

if [[ ! "$INTERVAL_SECONDS" =~ ^[0-9]+$ ]] || (( INTERVAL_SECONDS < 30 )); then
  echo "sync-main-watch: interval must be an integer >= 30 seconds" >&2
  exit 2
fi

echo "[sync-main-watch] refreshing main every ${INTERVAL_SECONDS}s"
while true; do
  if ! bash "$SCRIPT_DIR/sync-main.sh"; then
    echo "[sync-main-watch] sync failed; will retry after ${INTERVAL_SECONDS}s" >&2
  fi
  sleep "$INTERVAL_SECONDS"
done
