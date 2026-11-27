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

# A launchd interval and a manual invocation must never mutate the same Git
# refs concurrently. The lock lives in this checkout's Git metadata, not the
# working tree, and is always released on normal exit/signals.
LOCK_DIR="$(git rev-parse --git-path forge-sync-main.lock)"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  LOCK_PID="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
  if [[ "$LOCK_PID" =~ ^[0-9]+$ ]] && kill -0 "$LOCK_PID" 2>/dev/null; then
    fail "another sync-main process is active (pid=$LOCK_PID); the next interval will retry"
  fi
  [[ -n "$LOCK_PID" ]] || fail "sync-main lock is being initialized; the next interval will retry"
  rm -f "$LOCK_DIR/pid"
  rmdir "$LOCK_DIR" 2>/dev/null || fail "stale sync-main lock changed during recovery; retry next interval"
  mkdir "$LOCK_DIR" 2>/dev/null || fail "another sync-main process acquired the lock; retry next interval"
fi
printf '%s\n' "$$" >"$LOCK_DIR/pid"
trap 'rm -f "$LOCK_DIR/pid"; rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

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

publish_required_main_gate_status() {
local sha="$1" repository remote_url status_context gh_bin post_response readback_response

repository="$(printenv FORGE_GITHUB_REPOSITORY || true)"
if [[ -z "$repository" ]]; then repository="$(printenv GITHUB_REPOSITORY || true)"; fi
if [[ -z "$repository" ]]; then
  remote_url="$(git remote get-url "$REMOTE")"
  case "$remote_url" in
    https://github.com/*|git@github.com:*|ssh://git@github.com/*)
      repository="$(printf '%s' "$remote_url" | sed -E 's#^https://github.com/|^git@github.com:|^ssh://git@github.com/##; s#\.git$##')"
      ;;
    *) return 0 ;;
  esac
fi

[[ "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] ||
  fail "invalid GitHub repository identity for required Main gate status: $repository"

status_context="$(printenv FORGE_MAIN_GATE_STATUS_CONTEXT || true)"
[[ -n "$status_context" ]] || status_context="Main gate"

gh_bin="$(printenv FORGE_GH_BIN || command -v gh || true)"
if [[ -z "$gh_bin" && -x /opt/homebrew/bin/gh ]]; then gh_bin=/opt/homebrew/bin/gh; fi
[[ -n "$gh_bin" && -x "$gh_bin" ]] ||
  fail "GitHub CLI is unavailable; refusing to bypass the required '$status_context' status check"

if ! post_response="$("$gh_bin" api "repos/$repository/statuses/$sha" \
  -f state=success \
  -f "context=$status_context" \
  -f "description=Forge Main gate passed for $sha" 2>&1)"; then
  fail "could not publish required GitHub status '$status_context' for $sha: $post_response"
fi

if ! node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{const x=JSON.parse(s);process.exit(x.state==="success"&&x.context===process.argv[1]?0:1)}catch{process.exit(1)}})' \
  "$status_context" <<<"$post_response"; then
  fail "GitHub did not confirm success for required status '$status_context' on $sha"
fi

if ! readback_response="$("$gh_bin" api "repos/$repository/commits/$sha/status" 2>&1)"; then
  fail "could not read back required GitHub status '$status_context' for $sha: $readback_response"
fi
if ! node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{const x=JSON.parse(s);process.exit(Array.isArray(x.statuses)&&x.statuses.some(v=>v.context===process.argv[1]&&v.state==="success")?0:1)}catch{process.exit(1)}})' \
  "$status_context" <<<"$readback_response"; then
  fail "GitHub readback did not contain a successful '$status_context' status for $sha"
fi

echo "[sync-main] GitHub required status '$status_context' confirmed for $sha"
}

run_bounded_git() {
  local timeout_seconds="$1"
  shift
  # Git/libcurl has no portable hard timeout command on macOS. alarm survives
  # exec and bounds a stalled HTTP request without depending on coreutils.
  perl -e 'my $seconds = shift; alarm $seconds; exec @ARGV or die "exec failed: $!"' \
    "$timeout_seconds" "$@"
}

fetch_remote_main() {
  local refspec output remote_sha tracking_sha
  refspec="refs/heads/$BRANCH:refs/remotes/$REMOTE/$BRANCH"

  # Bound the first attempt; a stuck fetch must not hold the sync lease for
  # minutes. The explicit destination refspec advances the ref sync_refs reads.
  echo "[sync-main] fetching $REMOTE/$BRANCH over HTTP/2 (20s bound)" >&2
  if output="$(GIT_TERMINAL_PROMPT=0 run_bounded_git 20 git \
    -c http.version=HTTP/2 -c http.lowSpeedLimit=512 -c http.lowSpeedTime=15 \
    fetch --no-tags "$REMOTE" "$refspec" 2>&1)"; then
    [[ -z "$output" ]] || printf '%s\\n' "$output" >&2
    return 0
  fi

  echo "[sync-main] HTTP/2 fetch failed or timed out; checking remote SHA before fallback" >&2
  if remote_sha="$(GIT_TERMINAL_PROMPT=0 run_bounded_git 10 git \
    -c http.version=HTTP/1.1 -c http.lowSpeedLimit=512 -c http.lowSpeedTime=8 \
    ls-remote "$REMOTE" "refs/heads/$BRANCH" 2>/dev/null | awk 'NR == 1 { print $1 }')"; then
    tracking_sha="$(git rev-parse -q --verify "refs/remotes/$REMOTE/$BRANCH" 2>/dev/null || true)"
    if [[ -n "$remote_sha" && "$remote_sha" == "$tracking_sha" ]]; then
      echo "[sync-main] remote already matches origin/main; no duplicate fetch needed" >&2
      return 0
    fi
  fi

  echo "[sync-main] retrying remote fetch once with HTTP/1.1 (20s bound)" >&2
  if output="$(GIT_TERMINAL_PROMPT=0 run_bounded_git 20 git \
    -c http.version=HTTP/1.1 -c http.lowSpeedLimit=512 -c http.lowSpeedTime=15 \
    fetch --no-tags "$REMOTE" "$refspec" 2>&1)"; then
    [[ -z "$output" ]] || printf '%s\\n' "$output" >&2
    echo "[sync-main] HTTP/1.1 fetch fallback succeeded" >&2
    return 0
  fi

  fail "remote fetch failed or timed out over HTTP/2 and HTTP/1.1; no stale origin/main snapshot will be used: $output"
}

reconcile_divergence() {
  local counts ahead behind merge_count dirty_status rebase_output
  counts="$(git rev-list --left-right --count "$BRANCH...$REMOTE/$BRANCH")"
  read -r ahead behind <<<"$counts"

  # Rebase only when histories diverge, or an older sync left an unpublished
  # merge commit behind. Never create a new merge commit.
  if [[ "$ahead" -gt 0 && "$behind" -eq 0 ]]; then
    merge_count="$(git rev-list --count --merges "$REMOTE/$BRANCH..$BRANCH")"
    [[ "$merge_count" -gt 0 ]] || return 0
  elif [[ "$ahead" -gt 0 && "$behind" -gt 0 ]]; then
    :
  else
    return 0
  fi

  dirty_status="$(git status --porcelain=v1 --untracked-files=all)"
  [[ -z "$dirty_status" ]] ||
    fail "local main and origin/main require linear reconciliation (ahead=$ahead behind=$behind), but the checkout is dirty; preserve Writer changes and retry after the Writer finishes: $(git status --short)"


if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "[sync-main] would linearize $ahead local and $behind remote commit(s) with rebase; no merge commit will be created" >&2
    return 0
  fi

  echo "[sync-main] linearizing $ahead local and $behind remote commit(s) onto $REMOTE/$BRANCH" >&2
  if ! rebase_output="$(git -c rebase.autoStash=false rebase --no-rebase-merges "$REMOTE/$BRANCH" 2>&1)"; then
    git rebase --abort >/dev/null 2>&1 || true
    fail "linear rebase conflicted; rebase was aborted and the original checkout was preserved: $rebase_output"
  fi

  if [[ -n "$(git rev-list --merges "$REMOTE/$BRANCH..$BRANCH")" ]]; then
    fail "linear reconciliation left unpublished merge commits; refusing publication"
  fi
}

sync_refs() {
  local counts ahead behind
  counts="$(git rev-list --left-right --count "$BRANCH...$REMOTE/$BRANCH")"
  read -r ahead behind <<<"$counts"
  if [[ "$ahead" -gt 0 && "$behind" -gt 0 ]]; then
    fail "local main and origin/main remain divergent (ahead=$ahead behind=$behind) after reconciliation"
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
  reconcile_divergence
  if [[ "$DRY_RUN" -eq 1 ]]; then
    read -r ahead behind <<<"$(git rev-list --left-right --count "$BRANCH...$REMOTE/$BRANCH")"
    [[ "$ahead" -gt 0 && "$behind" -gt 0 ]] || read -r ahead behind < <(sync_refs)
    echo "[sync-main] dry-run complete (ahead=$ahead behind=$behind)"
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
fetch_remote_main
reconcile_divergence
read -r ahead behind < <(sync_refs)

# Validate the complete candidate against the remote branch, not only HEAD.
# If the remote moves during validation, reconcile and validate the new linear
# candidate again. The bounded loop prevents remote churn from running forever.
CHECK_BASE_REF="${TEST_BASE_REF:-$REMOTE/$BRANCH}"
MAX_REVALIDATIONS=3
REVALIDATION=0
COMMITTED=0
VALIDATED_HEAD=""

while true; do
  read -r ahead behind < <(sync_refs)
  VALIDATED_HEAD="$(git rev-parse HEAD)"

  if [[ "$COMMIT" -eq 1 && "$COMMITTED" -eq 0 ]]; then
    echo "[sync-main] running validation: $CHECK_COMMAND (base=$CHECK_BASE_REF)"
    TEST_BASE_REF="$CHECK_BASE_REF" FORGE_CHECK_SOURCE_QUALITY_MODE=workspace FORGE_CHECK_CANDIDATE_SHA="$VALIDATED_HEAD" bash -lc "$CHECK_COMMAND"
    [[ "$(git rev-parse HEAD)" == "$VALIDATED_HEAD" ]] || fail "HEAD changed during validation; keep successor commits and retry"
    git diff --check -- "${PATHS[@]}"
    git add -- "${PATHS[@]}"
    git diff --cached --check -- "${PATHS[@]}"
    git diff --cached --quiet && fail "the selected paths contain no staged changes"
    echo "[sync-main] committing only the selected paths"
    git commit -m "$MESSAGE"
    COMMITTED=1
    VALIDATED_HEAD="$(git rev-parse HEAD)"
  elif [[ "$ahead" -gt 0 ]]; then
    echo "[sync-main] validating already-committed changes before publication: $CHECK_COMMAND (base=$CHECK_BASE_REF)"
    TEST_BASE_REF="$CHECK_BASE_REF" FORGE_CHECK_SOURCE_QUALITY_MODE=committed FORGE_CHECK_CANDIDATE_SHA="$VALIDATED_HEAD" bash -lc "$CHECK_COMMAND"
    [[ "$(git rev-parse HEAD)" == "$VALIDATED_HEAD" ]] || fail "HEAD changed during validation; keep successor commits and retry"
  fi

  echo "[sync-main] refreshing $REMOTE/$BRANCH before publication"
  fetch_remote_main
  reconcile_divergence
  read -r ahead behind < <(sync_refs)
  CURRENT_HEAD="$(git rev-parse HEAD)"
  if [[ "$CURRENT_HEAD" == "$VALIDATED_HEAD" ]]; then
    break
  fi

  REVALIDATION=$((REVALIDATION + 1))
  [[ "$REVALIDATION" -lt "$MAX_REVALIDATIONS" ]] ||
    fail "main changed during validation $REVALIDATION times; the latest candidate is preserved and the next interval will retry"
  echo "[sync-main] candidate changed during validation; revalidating merged HEAD $CURRENT_HEAD (attempt $((REVALIDATION + 1))/$MAX_REVALIDATIONS)"
done

if [[ "$ahead" -gt 0 ]]; then
  [[ "$(git rev-parse HEAD)" == "$VALIDATED_HEAD" ]] || fail "HEAD changed since validation; refusing to push unvalidated successor commits"
  [[ -z "$(git rev-list --merges "$REMOTE/$BRANCH..$VALIDATED_HEAD")" ]] ||
    fail "validated candidate contains unpublished merge commits; refusing to bypass the linear-history rule"
  publish_required_main_gate_status "$VALIDATED_HEAD"
  echo "[sync-main] pushing $ahead linear commit(s) to $REMOTE/$BRANCH (fast-forward only)"
  # Push the exact validated commit object, not a moving local branch ref.
  # Another Writer can advance main after the last HEAD check but before
  # Git resolves push refs; that successor was never included in this Gate.
  PUSH_REF="$VALIDATED_HEAD:refs/heads/$BRANCH"
  if push_output="$(git push "$REMOTE" "$PUSH_REF" 2>&1)"; then
    printf '%s\n' "$push_output"
  elif grep -Eqi 'HTTP/2 framing layer|HTTP/2 stream .*not closed cleanly|curl 92|stream error: INTERNAL_ERROR' <<<"$push_output"; then
    echo "[sync-main] HTTP/2 transport failed during push; checking remote state before one HTTP/1.1 retry" >&2
    printf '%s\n' "$push_output" >&2
    # A transport error can happen after the server accepted the ref update.
    # Never blindly replay a push: first read back the exact remote branch.
    if ! fetch_remote_main >&2; then
      fail "HTTP/2 push outcome is unknown and remote readback failed; no retry was attempted"
    fi
    REMOTE_AFTER_HTTP2="$(git rev-parse "$REMOTE/$BRANCH")"
    if [[ "$REMOTE_AFTER_HTTP2" == "$VALIDATED_HEAD" ]]; then
      echo "[sync-main] remote already contains the validated commit; treating the interrupted HTTP/2 response as successful" >&2
    else
      if ! git merge-base --is-ancestor "$REMOTE/$BRANCH" "$VALIDATED_HEAD"; then
        fail "HTTP/2 push failed and remote advanced outside the validated candidate; refusing HTTP/1.1 retry"
      fi
      echo "[sync-main] retrying the same validated ref update once with HTTP/1.1" >&2
      if push_output="$(git -c http.version=HTTP/1.1 push "$REMOTE" "$PUSH_REF" 2>&1)"; then
        printf '%s\n' "$push_output"
      else
        printf '%s\n' "$push_output" >&2
        # Resolve an ambiguous retry result without issuing another push.
        if ! fetch_remote_main >&2; then
          fail "HTTP/1.1 retry failed and remote readback failed; publication outcome remains unknown"
        fi
        REMOTE_AFTER_HTTP1="$(git rev-parse "$REMOTE/$BRANCH")"
        [[ "$REMOTE_AFTER_HTTP1" == "$VALIDATED_HEAD" ]] ||
          fail "HTTP/1.1 retry failed; remote remains at $REMOTE_AFTER_HTTP1 and no further retry was attempted"
        echo "[sync-main] remote readback confirms the validated commit despite the HTTP/1.1 response error" >&2
      fi
    fi
  else
    printf '%s\n' "$push_output" >&2
    exit 1
  fi
  if grep -qi 'Bypassed rule violations' <<<"$push_output"; then
    fail "GitHub accepted the push by bypassing a required branch rule; publication is not considered clean and the ruleset must be corrected"
  fi
fi

fetch_remote_main
LOCAL_SHA="$(git rev-parse "$BRANCH")"
REMOTE_SHA="$(git rev-parse "$REMOTE/$BRANCH")"
[[ "$LOCAL_SHA" == "$REMOTE_SHA" ]] || fail "main synchronization did not converge: local=$LOCAL_SHA remote=$REMOTE_SHA"

echo "[sync-main] main synchronized at $LOCAL_SHA"
if [[ -n "$(git status --porcelain=v1 --untracked-files=all)" ]]; then
  echo "[sync-main] unrelated or unselected working-tree changes remain; they were not staged or committed:"
  git status --short
fi
