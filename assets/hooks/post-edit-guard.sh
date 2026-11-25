#!/bin/bash
# Post-Edit Guard — PostToolUse on Edit|Write
# Combines doc-drift reminders, continuous contract verification, and task handoff generation.

set -euo pipefail
export LC_ALL=C

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/hook-input.sh"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/lib/workflow-state.sh"

run_continuous_contract_verification() {
  local active_plan contract_file checks_file

  [[ -f "scripts/verify-contract.sh" ]] || return 0

  active_plan="$(get_active_plan || true)"
  [[ -n "$active_plan" && -f "$active_plan" ]] || return 0

  contract_file="$(derive_contract_path "$active_plan" || true)"
  [[ -n "$contract_file" && -f "$contract_file" ]] || return 0
  checks_file="$(workflow_checks_file)"
  mkdir -p "$(dirname "$checks_file")"

  if contract_references_path "$contract_file" "$FILE_PATH"; then
    bash "scripts/verify-contract.sh" --contract "$contract_file" --quiet --report-file "$checks_file" || true
  fi
}

run_brain_doc_sync() {
  [[ -x "scripts/sync-brain-docs.sh" ]] || return 0
  [[ -f ".ai/harness/brain-manifest.json" ]] || return 0

  # Fast-path: most edits are not repo-to-brain sources. Avoid starting the JS
  # manifest reader unless the changed repo path appears in the manifest.
  if ! grep -Fq "\"$FILE_PATH\"" ".ai/harness/brain-manifest.json"; then
    return 0
  fi

  if bash "scripts/sync-brain-docs.sh" --changed "$FILE_PATH"; then
    :
  else
    local status=$?
    echo "[SyncChain] WARN: brain-doc-sync failed for $FILE_PATH (exit $status)"
  fi
}

# Single jq call for the one field this guard needs.
FILE_PATH=""
if [[ -n "${HOOK_STDIN_JSON:-}" ]] && command -v jq >/dev/null 2>&1; then
  _fp="$(printf '%s' "$HOOK_STDIN_JSON" | jq -r '
    .file_path // .tool_input.file_path // .trigger_file_path // .parent_file_path // ""
  ' 2>/dev/null)" || _fp=""
  if [[ -n "$_fp" ]]; then
    HOOK_STDIN_JSON_VALID="1"
    export HOOK_STDIN_JSON_VALID
    FILE_PATH="$(hook_normalize_file_path "$_fp")"
  fi
fi
[[ -z "$FILE_PATH" ]] && FILE_PATH="$(hook_get_file_path "${1:-}")"
[[ -z "$FILE_PATH" ]] && exit 0

BASENAME=$(basename "$FILE_PATH")
DIRNAME=$(dirname "$FILE_PATH")

if [[ "$FILE_PATH" == deploy/* ]]; then
  echo "[DeployAsset] Deployment operations asset changed: $FILE_PATH"
  echo "  Confirm secrets, real env files, provider state, artifacts, logs, and scratch files remain in ignored _ops/ before committing."
  echo "  Keep deployment SQL directly under deploy/sql/ with 4-digit ascending prefixes."
fi

if [[ "$BASENAME" == "package.json" && "$DIRNAME" =~ (^|/)packages/([^/]+) ]]; then
  PKG_NAME="packages/${BASH_REMATCH[2]}"
  if [[ -n "$PKG_NAME" ]]; then
    echo "[DocDrift] $PKG_NAME/package.json changed"
    echo "  Check: update affected source/tests and the tracked GitHub Issue/Project when durable acceptance changes"
  fi
fi

if [[ "$FILE_PATH" =~ (^|/)packages/([^/]+)/src/([^/]+)/index\.ts$ ]]; then
  PKG="${BASH_REMATCH[2]}"
  MODULE="${BASH_REMATCH[3]}"
  echo "[DocDrift] New module '$MODULE' in $PKG"
  echo "  Check: update affected source/tests and the tracked GitHub Issue/Project when architecture/acceptance changes"
fi

if [[ "$FILE_PATH" =~ (^|/)apps/[^/]+/src/.+ ]]; then
  echo "[DocDrift] App source changed: $FILE_PATH"
  echo "  Check: update affected source/tests and the tracked GitHub Issue/Project when architecture/acceptance changes"
fi

if [[ "$BASENAME" == "metro.config.js" ]] || [[ "$BASENAME" == "metro.config.ts" ]]; then
  echo "[DocDrift] Metro config changed"
  echo "  Check: update README/Pages only when public operator guidance changed"
fi

if [[ "$BASENAME" == "tsconfig.json" && "$DIRNAME" =~ (^|/)(packages|apps)/ ]]; then
  echo "[DocDrift] TypeScript config changed in $(basename "$DIRNAME")"
  echo "  Check: update affected source/tests; update README/Pages only for public guidance"
fi

if [[ "$BASENAME" == "turbo.json" ]]; then
  echo "[DocDrift] Turborepo config changed"
  echo "  Check: update affected source/tests and the tracked GitHub Issue/Project when architecture/acceptance changes"
fi

if [[ "$BASENAME" =~ ^wrangler.*\.toml$ ]]; then
  echo "[DocDrift] Wrangler config changed: $BASENAME"
  echo "  Check: update README/Pages only when public deployment guidance changed"
fi

# Aggregated advisories (route-registry keeps one PostToolUse edit entry; the
# dispatcher-level aggregation lives here).
if [[ -f "$SCRIPT_DIR/first-principles-guard.sh" ]]; then
  bash "$SCRIPT_DIR/first-principles-guard.sh" "$FILE_PATH" </dev/null || true
elif [[ -f "$SCRIPT_DIR/anti-simplification.sh" ]]; then
  bash "$SCRIPT_DIR/anti-simplification.sh" "$FILE_PATH" </dev/null || true
fi

run_brain_doc_sync

run_continuous_contract_verification

case "$FILE_PATH" in
  tasks/todos.md|plans/*.md|tasks/reviews/*.review.md|.ai/harness/checks/latest.json)
    ;;
  *)
    exit 0
    ;;
esac

active_plan="$(get_active_plan || true)"
if [[ "$FILE_PATH" == "tasks/todos.md" && -z "$active_plan" ]] && grep -Eq '^> \*\*Status\*\*:[[:space:]]*Backlog[[:space:]]*$' tasks/todos.md; then
  rm -f "$(workflow_task_state_file)"
  echo "[SessionContinuation] Deferred-goal ledger updated; no active execution state was created."
  exit 0
fi

if [[ "$FILE_PATH" == "tasks/todos.md" ]] && [[ -f "tasks/todos.md" ]] && ! grep -Eq '^> \*\*Status\*\*:[[:space:]]*Backlog[[:space:]]*$' tasks/todos.md; then
  workflow_sync_task_state_from_todo "tasks/todos.md" "$(workflow_task_state_file)"
fi

workflow_write_session_continuation "task-progress" || true
if [[ -f "$(workflow_session_continuation_file)" ]]; then
  echo "[SessionContinuation] Refreshed non-authoritative session cache $(workflow_session_continuation_file)."
fi
