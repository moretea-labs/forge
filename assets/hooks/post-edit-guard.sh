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

run_architecture_queue_sync() {
  local queue_output status

  [[ -x "scripts/architecture-queue.sh" ]] || return 0

  if queue_output="$(bash "scripts/architecture-queue.sh" record --file "$FILE_PATH" 2>&1)"; then
    :
  else
    status=$?
    [[ -n "$queue_output" ]] && printf '%s\n' "$queue_output"
    echo "[SyncChain] WARN: architecture-queue failed for $FILE_PATH (exit $status)"
    return 0
  fi
  [[ -n "$queue_output" ]] && printf '%s\n' "$queue_output"

  if printf '%s\n' "$queue_output" | grep -q '^\[ArchitectureDrift\] Request:'; then
    if [[ -x "scripts/context-contract-sync.sh" ]]; then
      if bash "scripts/context-contract-sync.sh" sync-latest; then
        :
      else
        status=$?
        echo "[SyncChain] WARN: context-contract-sync failed after $FILE_PATH (exit $status)"
      fi
    fi
    if [[ -n "${FORGE_CLI:-}" && -f "$FORGE_CLI" ]] && command -v bun >/dev/null 2>&1; then
      if bun "$FORGE_CLI" capability-context request --from-latest-architecture-event; then
        :
      else
        status=$?
        echo "[SyncChain] WARN: capability-context request failed after $FILE_PATH (exit $status)"
      fi
    elif command -v forge >/dev/null 2>&1; then
      if forge capability-context request --from-latest-architecture-event; then
        :
      else
        status=$?
        echo "[SyncChain] WARN: capability-context request failed after $FILE_PATH (exit $status)"
      fi
    elif command -v bun >/dev/null 2>&1 && [[ -f "src/cli/index.ts" ]]; then
      if bun src/cli/index.ts capability-context request --from-latest-architecture-event; then
        :
      else
        status=$?
        echo "[SyncChain] WARN: capability-context request failed after $FILE_PATH (exit $status)"
      fi
    fi
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

FILE_PATH="$(hook_get_file_path "${1:-}")"
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
    echo "  Check: docs/packages.md exports table may need updating"
  fi
fi

if [[ "$FILE_PATH" =~ (^|/)packages/([^/]+)/src/([^/]+)/index\.ts$ ]]; then
  PKG="${BASH_REMATCH[2]}"
  MODULE="${BASH_REMATCH[3]}"
  echo "[DocDrift] New module '$MODULE' in $PKG"
  echo "  Check: docs/packages.md and docs/architecture.md may need updating"
fi

if [[ "$FILE_PATH" =~ (^|/)apps/[^/]+/src/.+ ]]; then
  echo "[DocDrift] App source changed: $FILE_PATH"
  echo "  Check: docs/architecture.md source tree may need updating"
fi

if [[ "$BASENAME" == "metro.config.js" ]] || [[ "$BASENAME" == "metro.config.ts" ]]; then
  echo "[DocDrift] Metro config changed"
  echo "  Check: docs/guides/metro-esm-gotchas.md may need updating"
fi

if [[ "$BASENAME" == "tsconfig.json" && "$DIRNAME" =~ (^|/)(packages|apps)/ ]]; then
  echo "[DocDrift] TypeScript config changed in $(basename "$DIRNAME")"
  echo "  Check: docs/packages.md may need updating"
fi

if [[ "$BASENAME" == "turbo.json" ]]; then
  echo "[DocDrift] Turborepo config changed"
  echo "  Check: docs/architecture.md pipeline section may need updating"
fi

if [[ "$BASENAME" =~ ^wrangler.*\.toml$ ]]; then
  echo "[DocDrift] Wrangler config changed: $BASENAME"
  echo "  Check: docs/guides/cf-deployment.md bindings/routes may need updating"
fi

# Aggregated advisories (route-registry keeps one PostToolUse edit entry; the
# dispatcher-level aggregation lives here).
if [[ -f "$SCRIPT_DIR/first-principles-guard.sh" ]]; then
  bash "$SCRIPT_DIR/first-principles-guard.sh" "$FILE_PATH" </dev/null || true
elif [[ -f "$SCRIPT_DIR/anti-simplification.sh" ]]; then
  bash "$SCRIPT_DIR/anti-simplification.sh" "$FILE_PATH" </dev/null || true
fi

run_architecture_queue_sync

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
