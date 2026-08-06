#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

command -v bun >/dev/null 2>&1 || {
  echo "Bun is required to verify forge V8." >&2
  exit 127
}

TEST_FILES=(
  "tests/runtime/facade-contracts.test.ts"
  "tests/cli/controller-service.test.ts"
  "tests/cli/mcp-controller.test.ts"
  "tests/cli/local-bridge.test.ts"
  "tests/runtime/thin-harness-gateway-routing.test.ts"
  "tests/runtime/runtime-observability.test.ts"
)

for test_file in "${TEST_FILES[@]}"; do
  [[ -f "$test_file" ]] || {
    echo "Controller V8 verification test is missing: $test_file" >&2
    exit 2
  }
done

bun scripts/test-governance.ts --no-cache "${TEST_FILES[@]}"
bun run check:type
