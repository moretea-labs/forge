#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
HELPER_NAME="${1:?helper filename is required}"
shift
HELPER_ID="${HELPER_NAME%.*}"

if command -v bun >/dev/null 2>&1 && [[ -f "$SOURCE_ROOT/src/cli/index.ts" && -f "$SOURCE_ROOT/assets/templates/helpers/$HELPER_NAME" ]]; then
  exec bun "$SOURCE_ROOT/src/cli/index.ts" run "$HELPER_ID" "$@"
fi

if command -v forge >/dev/null 2>&1; then
  exec forge run "$HELPER_ID" "$@"
fi

echo "Missing Forge runtime for helper $HELPER_ID" >&2
exit 1
