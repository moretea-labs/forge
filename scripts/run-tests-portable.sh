#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if command -v bun >/dev/null 2>&1; then
  if [[ "$#" -eq 0 ]]; then
    exec bun scripts/test-governance.ts affected
  fi
  exec bun scripts/test-governance.ts "$@"
fi

if [[ "$#" -gt 0 ]]; then
  exec node --test "$@"
fi

echo "[tests] Bun is required for the affected test gate." >&2
echo "[tests] Node-only smoke: npm run test:node-smoke" >&2
exit 1
