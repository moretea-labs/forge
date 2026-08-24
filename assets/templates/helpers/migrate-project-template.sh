#!/bin/bash
# Run the canonical Forge adoption path without guessing a developer checkout.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SELF_SOURCE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SOURCE_ROOT="${FORGE_SOURCE_ROOT:-${AGENTIC_DEV_ROOT:-${AGENTIC_DEV_SKILL_ROOT:-}}}"

run_source_root() {
  local root="$1"
  shift
  [[ -f "$root/src/cli/index.ts" ]] || return 1
  command -v bun >/dev/null 2>&1 || {
    echo "[migrate] bun is required to run Forge from source: $root" >&2
    exit 1
  }
  exec bun "$root/src/cli/index.ts" adopt "$@" --no-codegraph --no-verify
}

run_source_root "$SELF_SOURCE_ROOT" "$@"
if [[ -n "$SOURCE_ROOT" ]]; then
  run_source_root "$SOURCE_ROOT" "$@"
fi

if command -v forge >/dev/null 2>&1; then
  exec forge adopt "$@" --no-codegraph --no-verify
fi

echo "[migrate] Missing Forge CLI; set FORGE_SOURCE_ROOT to a Forge source checkout." >&2
exit 1
