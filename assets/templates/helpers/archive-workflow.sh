#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null)"; then
  cd "$REPO_ROOT"
elif [[ "$SCRIPT_DIR" == */.ai/harness/scripts ]]; then
  cd "$SCRIPT_DIR/../../.."
else
  cd "$SCRIPT_DIR/.."
fi

usage() {
  cat <<'USAGE_EOF'
Usage: scripts/archive-workflow.sh --plan <plan-file> --outcome <Completed|Abandoned|Superseded>

Compatibility name: this helper closes a terminal repo-local workflow. It does
not create repository archive files. The final plan/contract/review/notes must
already be represented by HEAD with no staged or unstaged changes; after that
proof, the helper deletes those lifecycle artifacts and relies on Git history.
USAGE_EOF
}

normalize_slug() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//; s/-{2,}/-/g'
}

is_transient_plan_slug() {
  case "$1" in
    think-plan-[0-9]*|codex-plan-[0-9]*|approved-plan-[0-9]*) return 0 ;;
  esac
  return 1
}

plan_title_slug_from_file() {
  local plan_file="$1"
  local title slug
  [[ -f "$plan_file" ]] || return 1
  title="$(awk '
    /^# Plan:[[:space:]]*/ {
      sub(/^# Plan:[[:space:]]*/, "")
      print
      exit
    }
  ' "$plan_file" | xargs)"
  [[ -n "$title" ]] || return 1
  slug="$(normalize_slug "$title")"
  [[ -n "$slug" ]] || return 1
  printf '%s' "$slug"
}

plan_artifact_stem_from_parts() {
  local plan_file="$1"
  local original_stem="$2"
  local slug="$3"
  local stamp title_slug

  if [[ "$original_stem" =~ ^[0-9]{8}-[0-9]{4}-.+ ]]; then
    stamp="$(printf '%s' "$original_stem" | sed -E 's/^([0-9]{8}-[0-9]{4})-.+$/\1/')"
    if is_transient_plan_slug "$slug"; then
      title_slug="$(plan_title_slug_from_file "$plan_file" || true)"
      if [[ -n "$title_slug" && "$title_slug" != "$slug" ]]; then
        printf '%s-%s' "$stamp" "$title_slug"
        return 0
      fi
    fi
    printf '%s' "$original_stem"
  else
    printf '%s' "$slug"
  fi
}

repo_relative_path() {
  local candidate="$1"
  python3 - "$candidate" <<'PY'
from pathlib import Path
import sys
root = Path.cwd().resolve()
path = Path(sys.argv[1])
if not path.is_absolute():
    path = root / path
try:
    print(path.resolve().relative_to(root).as_posix())
except ValueError:
    raise SystemExit(2)
PY
}

assert_history_safe() {
  local candidate="$1"
  local rel
  [[ -f "$candidate" ]] || return 0
  rel="$(repo_relative_path "$candidate" || true)"
  [[ -n "$rel" ]] || {
    echo "archive-workflow: refusing path outside repository: $candidate" >&2
    return 1
  }
  git ls-files --error-unmatch -- "$rel" >/dev/null 2>&1 || {
    echo "archive-workflow: refusing to delete untracked lifecycle artifact: $rel" >&2
    echo "Persist or deliberately discard the unique content before workflow closeout." >&2
    return 1
  }
  git cat-file -e "HEAD:$rel" 2>/dev/null || {
    echo "archive-workflow: refusing to delete lifecycle artifact not represented by HEAD: $rel" >&2
    return 1
  }
  git diff --quiet -- "$rel" || {
    echo "archive-workflow: refusing to delete lifecycle artifact with unstaged changes: $rel" >&2
    return 1
  }
  git diff --cached --quiet -- "$rel" || {
    echo "archive-workflow: refusing to delete lifecycle artifact with staged changes: $rel" >&2
    return 1
  }
}

plan_file=""
outcome=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --plan)
      [[ -n "${2:-}" ]] || { echo "Error: --plan requires a value" >&2; usage; exit 1; }
      plan_file="$2"
      shift 2
      ;;
    --outcome)
      [[ -n "${2:-}" ]] || { echo "Error: --outcome requires a value" >&2; usage; exit 1; }
      outcome="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

[[ -n "$plan_file" && -n "$outcome" ]] || { echo "--plan and --outcome are required" >&2; usage; exit 1; }
case "$outcome" in
  Completed|Abandoned|Superseded) ;;
  *) echo "Invalid outcome: $outcome" >&2; exit 1 ;;
esac
[[ -f "$plan_file" ]] || { echo "Plan file not found: $plan_file" >&2; exit 1; }

normalized_plan="$(repo_relative_path "$plan_file" || true)"
case "$normalized_plan" in
  plans/*.md) ;;
  *) echo "archive-workflow: plan must be a direct Markdown child of plans/: $plan_file" >&2; exit 1 ;;
esac

plan_base="$(basename "$normalized_plan")"
slug="$(printf '%s' "$plan_base" | sed -E 's/^plan-[0-9]{8}-[0-9]{4}-//; s/\.md$//')"
original_artifact_stem="$(printf '%s' "$plan_base" | sed -E 's/^plan-//; s/\.md$//')"
artifact_stem="$(plan_artifact_stem_from_parts "$normalized_plan" "$original_artifact_stem" "$slug")"

candidates=("$normalized_plan")
for path in \
  "tasks/contracts/${artifact_stem}.contract.md" \
  "tasks/reviews/${artifact_stem}.review.md" \
  "tasks/notes/${artifact_stem}.notes.md" \
  "tasks/contracts/${slug}.contract.md" \
  "tasks/reviews/${slug}.review.md" \
  "tasks/notes/${slug}.notes.md"; do
  [[ -f "$path" ]] && candidates+=("$path")
done

# All-or-nothing preflight. Git history is only a valid archive after the exact
# terminal evidence has been committed; never silently erase unique local work.
for path in "${candidates[@]}"; do
  assert_history_safe "$path"
done

# Avoid deleting the same fallback artifact twice.
declare -A seen=()
for path in "${candidates[@]}"; do
  [[ -n "${seen[$path]:-}" ]] && continue
  seen[$path]=1
  rm -- "$path"
  echo "[WorkflowCloseout] Removed $path"
done

for marker_file in ".ai/harness/active-plan" ".claude/.active-plan"; do
  [[ -f "$marker_file" ]] || continue
  marker_value="$(cat "$marker_file" 2>/dev/null | xargs)"
  if [[ "$marker_value" == "$normalized_plan" || "$marker_value" == "./$normalized_plan" || "$marker_value" == "$plan_file" ]]; then
    rm -f "$marker_file"
    echo "[WorkflowCloseout] Cleared $marker_file"
  fi
done
rm -f ".ai/harness/active-worktree"

plan_key="$(basename "$normalized_plan" .md)"
rm -f ".claude/.plan-state/${plan_key}.todo.md.bak" ".claude/.plan-state/${plan_key}.task-state.json.bak"

if [[ -x "scripts/refresh-current-status.sh" ]]; then
  bash "scripts/refresh-current-status.sh" --clear --write --reason "workflow-closeout" || true
fi

echo "[WorkflowCloseout] Closed $normalized_plan as outcome=$outcome; Git history is the archive."
