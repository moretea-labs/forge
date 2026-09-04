#!/bin/bash
set -euo pipefail

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "[task-sync] Not a git repository; skipping task-sync check."
  exit 0
fi

get_changed_files() {
  if ! git diff --cached --quiet --ignore-submodules --; then
    git diff --cached --name-only --diff-filter=ACMR
    return
  fi

  git diff --name-only --diff-filter=ACMR
  git ls-files --others --exclude-standard
}

current_status_field() {
  local file="$1"
  local label="$2"
  awk -v label="$label" '
    $0 ~ "^> \\*\\*" label "\\*\\*:" {
      sub("^> \\*\\*" label "\\*\\*: *", "")
      gsub(/\r/, "")
      print
      exit
    }
  ' "$file" | xargs
}

current_status_updated_epoch() {
  local value="$1"
  if date -d "$value" '+%s' >/dev/null 2>&1; then
    date -d "$value" '+%s'
    return 0
  fi
  date -j -f '%Y-%m-%dT%H:%M:%S%z' "$value" '+%s' 2>/dev/null
}

validate_current_status_snapshot() {
  local file="tasks/current.md"
  local updated stale_after amount unit multiplier updated_epoch now_epoch

  if [[ ! -f "$file" ]]; then
    echo "[task-sync] Substantive repo changes require a refreshed tasks/current.md projection."
    return 1
  fi
  if ! grep -Fq '<!-- generated-by: forge refresh-current-status v1 -->' "$file"; then
    echo "[task-sync] tasks/current.md is not a Forge-generated current-status projection."
    return 1
  fi

  updated="$(current_status_field "$file" "Updated At" 2>/dev/null || true)"
  stale_after="$(current_status_field "$file" "Stale After" 2>/dev/null || true)"
  if [[ -z "$updated" || -z "$stale_after" ]]; then
    echo "[task-sync] tasks/current.md is missing Updated At or Stale After metadata."
    return 1
  fi
  if [[ ! "$stale_after" =~ ^([0-9]+)([smhd])$ ]]; then
    echo "[task-sync] tasks/current.md has an invalid Stale After freshness contract: $stale_after"
    return 1
  fi
  amount="${BASH_REMATCH[1]}"
  unit="${BASH_REMATCH[2]}"
  case "$unit" in
    s) multiplier=1 ;;
    m) multiplier=60 ;;
    h) multiplier=3600 ;;
    d) multiplier=86400 ;;
  esac

  updated_epoch="$(current_status_updated_epoch "$updated" || true)"
  if [[ ! "$updated_epoch" =~ ^[0-9]+$ ]]; then
    echo "[task-sync] tasks/current.md has an invalid Updated At timestamp: $updated"
    return 1
  fi
  now_epoch="${FORGE_CURRENT_STATUS_NOW_EPOCH:-$(date '+%s')}"
  if [[ ! "$now_epoch" =~ ^[0-9]+$ ]]; then
    echo "[task-sync] Unable to evaluate tasks/current.md freshness."
    return 1
  fi
  if (( now_epoch - updated_epoch >= amount * multiplier )); then
    echo "[task-sync] tasks/current.md is stale; refresh the generated current-status projection."
    return 1
  fi
}

changed_files=()
while IFS= read -r line; do
  [[ -n "$line" ]] && changed_files+=("$line")
done < <(get_changed_files)

if [[ "${#changed_files[@]}" -eq 0 ]]; then
  echo "[task-sync] No changes detected."
  exit 0
fi

has_non_task_change=0
has_task_sync_change=0
has_current_status_change=0

for file in "${changed_files[@]}"; do
  case "$file" in
    tasks/current.md)
      has_task_sync_change=1
      has_current_status_change=1
      ;;
    tasks/*|docs/researches/*)
      has_task_sync_change=1
      ;;
    *)
      has_non_task_change=1
      ;;
  esac
done

if [[ "$has_non_task_change" -eq 0 ]]; then
  if [[ "$has_task_sync_change" -eq 1 ]]; then
    echo "[task-sync] Only task/research sync files changed."
  else
    echo "[task-sync] No substantive repo changes detected."
  fi
  exit 0
fi

if [[ "$has_current_status_change" -ne 1 ]]; then
  echo "[task-sync] Substantive repo changes detected without a refreshed tasks/current.md projection."
  echo "[task-sync] Run scripts/refresh-current-status.sh --write; unrelated task/research updates do not satisfy current-projection freshness."
  exit 1
fi

validate_current_status_snapshot

echo "[task-sync] Repo changes include a fresh generated tasks/current.md projection."
exit 0
