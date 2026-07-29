#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if command -v bun >/dev/null 2>&1; then
  focused=0
  for arg in "$@"; do
    if [[ "$arg" != -* ]]; then
      focused=1
      break
    fi
  done

  test_timeout_ms="${BUN_TEST_TIMEOUT_MS:-60000}"
  test_max_concurrency="${BUN_TEST_MAX_CONCURRENCY:-1}"
  file_cooldown_seconds="${BUN_TEST_FILE_COOLDOWN_SECONDS:-0.1}"

  if [[ "$focused" -eq 1 ]]; then
    exec bun test --timeout "$test_timeout_ms" --max-concurrency "$test_max_concurrency" "$@"
  fi

  run_test_file() {
    local test_file="$1"
    echo "[tests] $test_file" >&2
    bun scripts/run-bun-test-file.ts --timeout "$test_timeout_ms" --max-concurrency "$test_max_concurrency" "$test_file"
    sleep "$file_cooldown_seconds"
  }

  found=0
  while IFS= read -r -d '' test_file; do
    found=1
    run_test_file "$test_file"
  done < <(git ls-files -z 'tests/*.test.ts' 'tests/**/*.test.ts' 'tests/**/*.test.mjs' | LC_ALL=C sort -z)

  if [[ "$found" -ne 1 ]]; then
    echo "[tests] no test files matched." >&2
    exit 1
  fi
  exit 0
fi

cat >&2 <<'MSG'
[tests] Bun is not installed, so the Bun-native test suite cannot run.
[tests] Running the Node-only smoke suite instead.
[tests] For exhaustive tests install Bun and run: npm run test:bun
MSG

node --test tests/node/*.test.mjs
