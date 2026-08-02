#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! command -v bun >/dev/null 2>&1; then
  if [[ "${REPO_HARNESS_ALLOW_NODE_ONLY:-0}" == "1" ]]; then
    echo "[ci] Bun unavailable; running explicit Node smoke only" >&2
    exec node --test tests/node/*.test.mjs
  fi
  echo "[ci] Bun is required; dependency installation belongs to the CI workflow" >&2
  exit 1
fi

exec bun run check:main
