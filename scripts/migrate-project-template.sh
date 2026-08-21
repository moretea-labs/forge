#!/bin/bash
# Delegate workflow migrations to the canonical upstream forge.
#
# Generated projects keep installed workflow runtime state under .ai/. The
# template source lives in AGENTIC_DEV_ROOT, AGENTIC_DEV_SKILL_ROOT, or
# ~/Projects/forge. Retired legacy install paths are not
# searched.

set -euo pipefail

resolve_agentic_dev_root() {
  if [[ -n "${AGENTIC_DEV_ROOT:-}" ]]; then
    printf '%s\n' "$AGENTIC_DEV_ROOT"
    return 0
  fi

  if [[ -n "${AGENTIC_DEV_SKILL_ROOT:-}" ]]; then
    printf '%s\n' "$AGENTIC_DEV_SKILL_ROOT"
    return 0
  fi

  if [[ -n "${HOME:-}" ]]; then
    local roots=(
      "$HOME/Projects/forge"
      "$HOME/.codex/skills/forge"
      "$HOME/.claude/skills/forge"
      "$HOME/.agents/skills/forge"
    )

    local root
    for root in "${roots[@]}"; do
      if [[ -d "$root" ]]; then
        printf '%s\n' "$root"
        return 0
      fi
    done

    printf '%s\n' "${roots[0]}"
    return 0
  fi

  printf '%s\n' ".forge/skills/forge"
}

UPSTREAM_ROOT="$(resolve_agentic_dev_root)"
UPSTREAM_SCRIPT="$UPSTREAM_ROOT/scripts/migrate-project-template.sh"

if [[ ! -f "$UPSTREAM_SCRIPT" ]]; then
  echo "[migrate] Upstream forge migration script not found: $UPSTREAM_SCRIPT" >&2
  echo "[migrate] Set AGENTIC_DEV_ROOT or AGENTIC_DEV_SKILL_ROOT to the skill root." >&2
  exit 1
fi

exec bash "$UPSTREAM_SCRIPT" "$@"
