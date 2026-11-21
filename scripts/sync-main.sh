#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR/.." rev-parse --show-toplevel 2>/dev/null)" || {
  echo "sync-main: not inside a Git repository" >&2
  exit 2
}
cd "$REPO_ROOT"

REMOTE=origin
BRANCH=main
COMMIT=0
DRY_RUN=0
MESSAGE=""
CHECK_COMMAND="${FORGE_SYNC_CHECK_COMMAND:-bun run check:main}"
PATHS=()

usage() {
  cat <<'USAGE'
Usage:
  scripts/sync-main.sh
  scripts/sync-main.sh --commit --message "fix: ..." --path <owned-path> [--path <owned-path> ...]
  scripts/sync-main.sh --dry-run

Default mode fetches origin/main, fast-forwards local main when possible,
pushes already-committed main changes with a normal fast-forward, and verifies
that local main equals origin/main. It never stages or commits dirty paths.

Commit mode runs the configured check (default: bun run check:main), stages
only the explicitly named --path values, commits them, then synchronizes main.
Unrelated staged changes are never included. No branches, worktrees, PRs,
rebases, resets, stashes, or force pushes are created or used.
USAGE
}

fail() {
  echo "sync-main: $*" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
  --commit)
    COMMIT=1
    shift
    ;;
  --message)
    [[ -n "${2:-}" ]] || {
      echo "sync-main: --message requires a value" >&2
      exit 2
    }
    MESSAGE="$2"
    shift 2
    ;;
  --check-command)
    [[ -n "${2:-}" ]] || {
      echo "sync-main: --check-command requires a value" >&2
      exit 2
    }
    CHECK_COMMAND="$2"
    shift 2
    ;;
  --path)
    [[ -n "${2:-}" ]] || {
      echo "sync-main: --path requires a value" >&2
      exit 2
    }
    PATHS+=("$2")
    shift 2
    ;;
  --dry-run)
    DRY_RUN=1
    shift
    ;;
  --help | -h)
    usage
    exit 0
    ;;
  *)
    echo "sync-main: unknown argument: $1" >&2
    usage
    exit 2
    ;;
  esac
done

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail "not inside a Git repository"
[[ "$(git branch --show-current)" == "$BRANCH" ]] || fail "must run from the canonical main checkout; current branch is $(git branch --show-current)"
CURRENT_WORKTREE="$(git rev-parse --show-toplevel)"
MAIN_WORKTREE_COUNT=0
MAIN_WORKTREE_PATH=""
while IFS= read -r path; do
  MAIN_WORKTREE_COUNT=$((MAIN_WORKTREE_COUNT + 1))
  MAIN_WORKTREE_PATH="$path"
done < <(git worktree list --porcelain | awk '$1 == "worktree" { path = $2 } $1 == "branch" && $2 == "refs/heads/main" { print path }')
[[ "$MAIN_WORKTREE_COUNT" -eq 1 ]] || fail "expected exactly one worktree on main; found $MAIN_WORKTREE_COUNT"
[[ "$MAIN_WORKTREE_PATH" == "$CURRENT_WORKTREE" ]] || fail "run from the canonical main checkout at $MAIN_WORKTREE_PATH"
git remote get-url "$REMOTE" >/dev/null 2>&1 || fail "remote '$REMOTE' is not configured"

if [[ "$COMMIT" -eq 1 ]]; then
  [[ -n "$MESSAGE" ]] || fail "--commit requires --message"
  [[ "${#PATHS[@]}" -gt 0 ]] || fail "--commit requires one or more explicit --path values"
  git diff --cached --quiet || fail "the Git index already contains staged changes; reconcile them before a path-scoped commit"
  for path in "${PATHS[@]}"; do
    [[ "$path" != /* && "$path" != .. && "$path" != ../* && "$path" != */../* ]] || fail "path must stay inside the repository: $path"
    [[ -e "$path" ]] || git ls-files --error-unmatch -- "$path" >/dev/null 2>&1 || fail "path does not exist: $path"
  done
elif [[ "${#PATHS[@]}" -gt 0 || -n "$MESSAGE" ]]; then
  fail "--path and --message require --commit"
fi

sync_refs() {
  local counts ahead behind
  counts="$(git rev-list --left-right --count "$BRANCH...$REMOTE/$BRANCH")"
  read -r ahead behind <<<"$counts"
  if [[ "$ahead" -gt 0 && "$behind" -gt 0 ]]; then
    fail "local main and origin/main have diverged (ahead=$ahead behind=$behind); preserve both histories and reconcile explicitly"
  fi
  if [[ "$behind" -gt 0 ]]; then
    if [[ "$DRY_RUN" -eq 1 ]]; then
      echo "[sync-main] would fast-forward main by $behind commit(s) from $REMOTE/$BRANCH" >&2
    else
      echo "[sync-main] fast-forwarding main by $behind commit(s) from $REMOTE/$BRANCH" >&2
      git merge --ff-only "$REMOTE/$BRANCH" >&2
    fi
  fi
  printf '%s %s\n' "$ahead" "$behind"
}

if [[ "$DRY_RUN" -eq 1 ]]; then
  remote_sha="$(git ls-remote "$REMOTE" "refs/heads/$BRANCH" | awk 'NR == 1 { print $1 }')"
  [[ -n "$remote_sha" ]] || fail "remote branch $REMOTE/$BRANCH does not exist"
  tracked_sha="$(git rev-parse "$REMOTE/$BRANCH" 2>/dev/null || true)"
  if [[ "$remote_sha" != "$tracked_sha" ]]; then
    echo "[sync-main] remote is at $remote_sha; local tracking ref is ${tracked_sha:-missing}"
    echo "[sync-main] dry-run did not fetch or mutate refs; run without --dry-run for exact reconciliation"
    exit 0
  fi
  read -r ahead behind < <(sync_refs)
  if [[ "$COMMIT" -eq 1 ]]; then
    echo "[sync-main] would run check: $CHECK_COMMAND"
    printf '[sync-main] would commit only:'
    printf ' %q' "${PATHS[@]}"
    printf '\n'
  fi
  if [[ "$behind" -gt 0 ]]; then echo "[sync-main] would fast-forward by $behind commit(s)"; fi
  if [[ "$ahead" -gt 0 ]]; then echo "[sync-main] would validate and push $ahead local commit(s) to $REMOTE/$BRANCH"; fi
  exit 0
fi

echo "[sync-main] fetching $REMOTE/$BRANCH"
git fetch "$REMOTE" "$BRANCH"
read -r ahead behind < <(sync_refs)

# Validate the complete candidate against the remote branch, not only HEAD.
# Without TEST_BASE_REF, source-quality/test selection can miss older pending
# commits; GitHub Actions then rejects changes that were reported PASS locally.
# Respect an explicit caller baseline; otherwise pin the freshly fetched ref.
CHECK_BASE_REF="${TEST_BASE_REF:-$REMOTE/$BRANCH}"
# Pin the candidate before the check. A concurrent Writer may add a successor
# commit, but it must never be published under a check for the earlier HEAD.
VALIDATED_HEAD="$(git rev-parse HEAD)"
if [[ "$COMMIT" -eq 1 ]]; then
  echo "[sync-main] running validation: $CHECK_COMMAND (base=$CHECK_BASE_REF)"
  TEST_BASE_REF="$CHECK_BASE_REF" FORGE_CHECK_SOURCE_QUALITY_MODE=workspace FORGE_CHECK_CANDIDATE_SHA="$VALIDATED_HEAD" bash -lc "$CHECK_COMMAND"
  [[ "$(git rev-parse HEAD)" == "$VALIDATED_HEAD" ]] || fail "HEAD changed during validation; keep successor commits and recheck the new candidate"
  git diff --check -- "${PATHS[@]}"
  git add -- "${PATHS[@]}"
  git diff --cached --check -- "${PATHS[@]}"
  git diff --cached --quiet && fail "the selected paths contain no staged changes"
  echo "[sync-main] committing only the selected paths"
  git commit -m "$MESSAGE"
  VALIDATED_HEAD="$(git rev-parse HEAD)"
elif [[ "$ahead" -gt 0 ]]; then
  echo "[sync-main] validating already-committed changes before publication: $CHECK_COMMAND (base=$CHECK_BASE_REF)"
  TEST_BASE_REF="$CHECK_BASE_REF" FORGE_CHECK_SOURCE_QUALITY_MODE=committed FORGE_CHECK_CANDIDATE_SHA="$VALIDATED_HEAD" bash -lc "$CHECK_COMMAND"
  [[ "$(git rev-parse HEAD)" == "$VALIDATED_HEAD" ]] || fail "HEAD changed during validation; keep successor commits and recheck the new candidate"
fi

# Re-fetch after validation/commit so a concurrent remote update cannot be
# mistaken for a fast-forward push. A divergent result is preserved locally.
echo "[sync-main] refreshing $REMOTE/$BRANCH before publication"
git fetch "$REMOTE" "$BRANCH"
read -r ahead behind < <(sync_refs)
if [[ "$ahead" -gt 0 ]]; then
  [[ "$(git rev-parse HEAD)" == "$VALIDATED_HEAD" ]] || fail "HEAD changed since validation; refusing to push unvalidated successor commits"
  echo "[sync-main] pushing $ahead commit(s) to $REMOTE/$BRANCH (fast-forward only)"
  # Push the exact validated commit object, not a moving local branch ref.
  # Another Writer can advance main after the last HEAD check but before
  # Git resolves push refs; that successor was never included in this Gate.
  if push_output="$(git push "$REMOTE" "$VALIDATED_HEAD:refs/heads/$BRANCH" 2>&1)"; then
    printf '%s\n' "$push_output"
    if grep -qi 'Bypassed rule violations' <<<"$push_output"; then
      echo "[sync-main] WARNING: GitHub accepted the direct push by bypassing a required status check; the local Main gate passed, but remote branch protection still needs review" >&2
    fi
  else
    printf '%s\n' "$push_output" >&2
    exit 1
  fi
fi

git fetch "$REMOTE" "$BRANCH"
LOCAL_SHA="$(git rev-parse "$BRANCH")"
REMOTE_SHA="$(git rev-parse "$REMOTE/$BRANCH")"
[[ "$LOCAL_SHA" == "$REMOTE_SHA" ]] || fail "main synchronization did not converge: local=$LOCAL_SHA remote=$REMOTE_SHA"

echo "[sync-main] main synchronized at $LOCAL_SHA"
if [[ -n "$(git status --porcelain=v1 --untracked-files=all)" ]]; then
  echo "[sync-main] unrelated or unselected working-tree changes remain; they were not staged or committed:"
  git status --short
fi
