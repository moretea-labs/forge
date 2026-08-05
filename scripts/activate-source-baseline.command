#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=./lib/controller-home-env.sh
source "$ROOT/scripts/lib/controller-home-env.sh"

repo_harness_use_local_controller_home "$ROOT"
repo_harness_prepare_runtime_path
BUN_BIN="$(repo_harness_resolve_bun || true)"
if [ -z "$BUN_BIN" ]; then
  echo "Bun is required to activate the source Runtime baseline." >&2
  exit 127
fi

cd "$ROOT"
exec "$BUN_BIN" "$ROOT/scripts/activate-source-baseline.ts" request --repo "$ROOT"
