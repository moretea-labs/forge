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
STATUS_PENDING_PATH="$(git rev-parse --git-path forge-main-gate-status-pending)"
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

github_repository() {
  local repository remote_url
  repository="$(printenv FORGE_GITHUB_REPOSITORY || true)"
  if [[ -z "$repository" ]]; then repository="$(printenv GITHUB_REPOSITORY || true)"; fi
  if [[ -z "$repository" ]]; then
    remote_url="$(git remote get-url "$REMOTE")"
    case "$remote_url" in
    https://github.com/* | git@github.com:* | ssh://git@github.com/*)
      repository="$(printf '%s' "$remote_url" | sed -E 's#^https://github.com/|^git@github.com:|^ssh://git@github.com/##; s#\.git$##')"
      ;;
    *)
      printf ''
      return 0
      ;;
    esac
  fi
  [[ "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] ||
    fail "invalid GitHub repository identity for required Main gate status: $repository"
  printf '%s' "$repository"
}

github_status_context() {
  local status_context
  status_context="$(printenv FORGE_MAIN_GATE_STATUS_CONTEXT || true)"
  [[ -n "$status_context" ]] || status_context="Main gate"
  printf '%s' "$status_context"
}

github_cli() {
  local gh_bin
  gh_bin="$(printenv FORGE_GH_BIN || command -v gh || true)"
  if [[ -z "$gh_bin" && -x /opt/homebrew/bin/gh ]]; then gh_bin=/opt/homebrew/bin/gh; fi
  printf '%s' "$gh_bin"
}

main_gate_status_is_success() {
  local sha="$1" repository status_context gh_bin readback_response
  repository="$(github_repository)"
  [[ -n "$repository" ]] || return 0
  status_context="$(github_status_context)"
  gh_bin="$(github_cli)"
  [[ -n "$gh_bin" && -x "$gh_bin" ]] || return 1
  if ! readback_response="$("$gh_bin" api "repos/$repository/commits/$sha/status" 2>/dev/null)"; then
    return 1
  fi
  node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{const x=JSON.parse(s);process.exit(Array.isArray(x.statuses)&&x.statuses.some(v=>v.context===process.argv[1]&&v.state==="success")?0:1)}catch{process.exit(1)}})' \
    "$status_context" <<<"$readback_response"
}

publish_required_main_gate_status() {
  local sha="$1" repository status_context gh_bin post_response readback_response
  repository="$(github_repository)"
  [[ -n "$repository" ]] || return 0
  status_context="$(github_status_context)"
  gh_bin="$(github_cli)"
  [[ -n "$gh_bin" && -x "$gh_bin" ]] || {
    printf '%s\n' "$sha" >"$STATUS_PENDING_PATH"
    fail "GitHub CLI is unavailable; refusing to bypass the required '$status_context' status check"
  }
  if main_gate_status_is_success "$sha"; then
    if [[ -f "$STATUS_PENDING_PATH" ]] && [[ "$(cat "$STATUS_PENDING_PATH")" == "$sha" ]]; then
      rm -f "$STATUS_PENDING_PATH"
    fi
    echo "[sync-main] GitHub required status '$status_context' is already confirmed for $sha"
    return 0
  fi

  if ! post_response="$("$gh_bin" api "repos/$repository/statuses/$sha" \
    -f state=success \
    -f "context=$status_context" \
    -f "description=Forge Main gate passed for $sha" 2>&1)"; then
    if grep -Fq "No commit found for SHA: $sha" <<<"$post_response"; then
      printf '%s\n' "$sha" >"$STATUS_PENDING_PATH"
      echo "[sync-main] GitHub has not indexed $sha yet; deferring Main gate status until after push" >&2
      return 2
    fi
    printf '%s\n' "$sha" >"$STATUS_PENDING_PATH"
    fail "could not publish required GitHub status '$status_context' for $sha: $post_response"
  fi

  if ! node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{const x=JSON.parse(s);process.exit(x.state==="success"&&x.context===process.argv[1]?0:1)}catch{process.exit(1)}})' \
    "$status_context" <<<"$post_response"; then
    printf '%s\n' "$sha" >"$STATUS_PENDING_PATH"
    fail "GitHub did not confirm success for required status '$status_context' on $sha"
  fi

  if ! readback_response="$("$gh_bin" api "repos/$repository/commits/$sha/status" 2>&1)"; then
    printf '%s\n' "$sha" >"$STATUS_PENDING_PATH"
    fail "could not read back required GitHub status '$status_context' for $sha: $readback_response"
  fi
  if ! node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{const x=JSON.parse(s);process.exit(Array.isArray(x.statuses)&&x.statuses.some(v=>v.context===process.argv[1]&&v.state==="success")?0:1)}catch{process.exit(1)}})' \
    "$status_context" <<<"$readback_response"; then
    printf '%s\n' "$sha" >"$STATUS_PENDING_PATH"
    fail "GitHub readback did not contain a successful '$status_context' status for $sha"
  fi

  if [[ -f "$STATUS_PENDING_PATH" ]] && [[ "$(cat "$STATUS_PENDING_PATH")" == "$sha" ]]; then
    rm -f "$STATUS_PENDING_PATH"
  fi
  echo "[sync-main] GitHub required status '$status_context' confirmed for $sha"
}

retry_pending_main_gate_status() {
  local pending_sha remote_sha status_result
  [[ -f "$STATUS_PENDING_PATH" ]] || return 0
  pending_sha="$(cat "$STATUS_PENDING_PATH")"
  [[ "$pending_sha" =~ ^[0-9a-f]{40,64}$ ]] || fail "pending Main gate status contains an invalid commit SHA"
  remote_sha="$(git rev-parse "$REMOTE/$BRANCH")"
  if git merge-base --is-ancestor "$pending_sha" "$remote_sha"; then
    if ! main_gate_status_is_success "$pending_sha"; then
      if publish_required_main_gate_status "$pending_sha"; then
        :
      else
        status_result=$?
        [[ "$status_result" -eq 2 ]] && fail "origin/main contains $pending_sha but GitHub still cannot resolve its Main gate status"
        exit "$status_result"
      fi
    fi
    rm -f "$STATUS_PENDING_PATH"
    delete_validation_ref "$pending_sha"
  elif git merge-base --is-ancestor "$pending_sha" HEAD; then
    ensure_validation_ref "$pending_sha"
    if ! main_gate_status_is_success "$pending_sha"; then
      if publish_required_main_gate_status "$pending_sha"; then
        :
      else
        status_result=$?
        [[ "$status_result" -eq 2 ]] && fail "GitHub still cannot resolve $pending_sha after its temporary validation ref was published"
        exit "$status_result"
      fi
    fi
    rm -f "$STATUS_PENDING_PATH"
  else
    fail "pending Main gate status belongs to $pending_sha, which is not reachable from local or remote main"
  fi
}

git_http_proxy() {
  local proxy port
  proxy="$(printenv FORGE_GIT_HTTP_PROXY || true)"
  if [[ -z "$proxy" ]]; then proxy="$(git config --get http.proxy || true)"; fi
  if [[ -n "$proxy" ]]; then
    printf '%s' "$proxy"
    return 0
  fi

  # Prefer the active local mihomo HTTP listener when Git has no proxy config.
  # The port is overridable; no global Git configuration is mutated.
  port="$(printenv FORGE_GIT_HTTP_PROXY_PORT || true)"
  [[ -n "$port" ]] || port=17890
  if command -v nc >/dev/null 2>&1 && nc -z -w 1 127.0.0.1 "$port" >/dev/null 2>&1; then
    printf 'http://127.0.0.1:%s' "$port"
  fi
}

run_bounded_git_http() {
  local timeout_seconds="$1" proxy="$2"
  shift 2
  if [[ -n "$proxy" ]]; then
    run_bounded_git "$timeout_seconds" git -c "http.proxy=$proxy" "$@"
  else
    run_bounded_git "$timeout_seconds" git "$@"
  fi
}

run_bounded_git() {
  local timeout_seconds="$1"
  shift
  # Git/libcurl has no portable hard timeout command on macOS. alarm survives
  # exec and bounds a stalled HTTP request without depending on coreutils.
  perl -e 'my $seconds = shift; alarm $seconds; exec @ARGV or die "exec failed: $!"' \
    "$timeout_seconds" "$@"
}

validation_ref_for_sha() {
  printf 'refs/tags/forge-validation/%s' "$1"
}

read_remote_validation_ref() {
  local ref="$1" proxy output
  proxy="$(git_http_proxy)"
  if ! output="$(GIT_TERMINAL_PROMPT=0 run_bounded_git_http 10 "$proxy" \
    -c http.version=HTTP/1.1 ls-remote "$REMOTE" "$ref" 2>&1)"; then
    fail "could not read temporary validation ref $ref: $output"
  fi
  awk 'NR == 1 { print $1 }' <<<"$output"
}

push_validation_refspec() {
  local refspec="$1" ref="$2" expected_sha="$3" expected_present="$4"
  local proxy output remote_output actual
  proxy="$(git_http_proxy)"

  if ! output="$(GIT_TERMINAL_PROMPT=0 run_bounded_git_http 30 "$proxy" \
    -c http.version=HTTP/2 -c http.lowSpeedLimit=512 -c http.lowSpeedTime=20 \
    push "$REMOTE" "$refspec" 2>&1)"; then
    if grep -Eqi 'HTTP/2|framing|stream|curl 92|timed out|operation too slow|alarm clock|signal 14' <<<"$output"; then
      remote_output="$(GIT_TERMINAL_PROMPT=0 run_bounded_git_http 10 "$proxy" \
        -c http.version=HTTP/1.1 ls-remote "$REMOTE" "$ref" 2>&1)" ||
        fail "temporary validation ref readback failed after HTTP/2 push error: $remote_output"
      actual="$(awk 'NR == 1 { print $1 }' <<<"$remote_output")"
      if [[ "$expected_present" == "1" && "$actual" == "$expected_sha" ]] ||
        [[ "$expected_present" == "0" && -z "$actual" ]]; then
        return 0
      fi
      if ! output="$(GIT_TERMINAL_PROMPT=0 run_bounded_git_http 30 "$proxy" \
        -c http.version=HTTP/1.1 -c http.lowSpeedLimit=512 -c http.lowSpeedTime=20 \
        push "$REMOTE" "$refspec" 2>&1)"; then
        remote_output="$(GIT_TERMINAL_PROMPT=0 run_bounded_git_http 10 "$proxy" \
          -c http.version=HTTP/1.1 ls-remote "$REMOTE" "$ref" 2>&1)" ||
          fail "temporary validation ref readback failed after HTTP/1.1 retry: $remote_output"
        actual="$(awk 'NR == 1 { print $1 }' <<<"$remote_output")"
        if [[ "$expected_present" == "1" && "$actual" == "$expected_sha" ]] ||
          [[ "$expected_present" == "0" && -z "$actual" ]]; then
          return 0
        fi
        fail "temporary validation ref update failed over HTTP/2 and HTTP/1.1: $output"
      fi
    else
      fail "temporary validation ref update failed: $output"
    fi
  fi

  remote_output="$(GIT_TERMINAL_PROMPT=0 run_bounded_git_http 10 "$proxy" \
    -c http.version=HTTP/1.1 ls-remote "$REMOTE" "$ref" 2>&1)" ||
    fail "temporary validation ref readback failed: $remote_output"
  actual="$(awk 'NR == 1 { print $1 }' <<<"$remote_output")"
  if [[ "$expected_present" == "1" ]]; then
    [[ "$actual" == "$expected_sha" ]] || fail "temporary validation ref $ref did not resolve to $expected_sha"
  else
    [[ -z "$actual" ]] || fail "temporary validation ref $ref was not deleted"
  fi
}

ensure_validation_ref() {
  local sha="$1" ref existing
  ref="$(validation_ref_for_sha "$sha")"
  existing="$(read_remote_validation_ref "$ref")"
  if [[ "$existing" == "$sha" ]]; then
    return 0
  fi
  [[ -z "$existing" ]] || fail "temporary validation ref $ref already points to unexpected commit $existing"
  echo "[sync-main] publishing temporary validation tag for exact commit $sha" >&2
  push_validation_refspec "$sha:$ref" "$ref" "$sha" 1
  [[ "$(git rev-parse HEAD)" == "$sha" ]] || {
    delete_validation_ref "$sha"
    fail "HEAD changed while publishing temporary validation ref; no main push was attempted"
  }
}

delete_validation_ref() {
  local sha="$1" ref existing
  ref="$(validation_ref_for_sha "$sha")"
  existing="$(read_remote_validation_ref "$ref")"
  [[ -n "$existing" ]] || return 0
  [[ "$existing" == "$sha" ]] || fail "refusing to delete temporary validation ref $ref pointing to $existing"
  echo "[sync-main] deleting temporary validation tag for $sha" >&2
  push_validation_refspec ":$ref" "$ref" "" 0
}

cleanup_validation_refs() {
  local proxy remote_output sha ref
  proxy="$(git_http_proxy)"
  if ! remote_output="$(GIT_TERMINAL_PROMPT=0 run_bounded_git_http 15 "$proxy" \
    -c http.version=HTTP/1.1 ls-remote "$REMOTE" 'refs/tags/forge-validation/*' 2>&1)"; then
    fail "could not inspect temporary validation refs: $remote_output"
  fi
  while read -r sha ref; do
    [[ -n "$sha" && "$ref" == refs/tags/forge-validation/* ]] || continue
    if git merge-base --is-ancestor "$sha" "$REMOTE/$BRANCH"; then
      delete_validation_ref "$sha"
    fi
  done <<<"$remote_output"
}

fetch_remote_main() {
  local refspec output remote_sha tracking_sha proxy
  refspec="refs/heads/$BRANCH:refs/remotes/$REMOTE/$BRANCH"
  proxy="$(git_http_proxy)"

  if [[ -n "$proxy" ]]; then
    echo "[sync-main] using configured/local HTTP proxy for Git transport" >&2
  else
    echo "[sync-main] no local Git HTTP proxy detected; using bounded direct transport" >&2
  fi
  echo "[sync-main] fetching $REMOTE/$BRANCH over HTTP/2 (20s bound)" >&2
  if output="$(GIT_TERMINAL_PROMPT=0 run_bounded_git_http 20 "$proxy" \
    -c http.version=HTTP/2 -c http.lowSpeedLimit=512 -c http.lowSpeedTime=15 \
    fetch --no-tags "$REMOTE" "$refspec" 2>&1)"; then
    [[ -z "$output" ]] || printf '%s\\n' "$output" >&2
    return 0
  fi

  echo "[sync-main] HTTP/2 fetch failed or timed out; checking remote SHA before fallback" >&2
  if remote_sha="$(GIT_TERMINAL_PROMPT=0 run_bounded_git_http 10 "$proxy" \
    -c http.version=HTTP/1.1 -c http.lowSpeedLimit=512 -c http.lowSpeedTime=8 \
    ls-remote "$REMOTE" "refs/heads/$BRANCH" 2>/dev/null | awk 'NR == 1 { print $1 }')"; then
    tracking_sha="$(git rev-parse -q --verify "refs/remotes/$REMOTE/$BRANCH" 2>/dev/null || true)"
    if [[ -n "$remote_sha" && "$remote_sha" == "$tracking_sha" ]]; then
      echo "[sync-main] remote already matches origin/main; no duplicate fetch needed" >&2
      return 0
    fi
  fi

  echo "[sync-main] retrying remote fetch once with HTTP/1.1 (20s bound)" >&2
  if output="$(GIT_TERMINAL_PROMPT=0 run_bounded_git_http 20 "$proxy" \
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
cleanup_validation_refs
retry_pending_main_gate_status

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
  if publish_required_main_gate_status "$VALIDATED_HEAD"; then
    :
  else
    status_result=$?
    [[ "$status_result" -eq 2 ]] || exit "$status_result"
    ensure_validation_ref "$VALIDATED_HEAD"
    if publish_required_main_gate_status "$VALIDATED_HEAD"; then
      :
    else
      status_result=$?
      [[ "$status_result" -eq 2 ]] && fail "GitHub still cannot resolve $VALIDATED_HEAD after the temporary validation tag was published"
      exit "$status_result"
    fi
  fi
  echo "[sync-main] pushing $ahead linear commit(s) to $REMOTE/$BRANCH (fast-forward only)"
  # Push the exact validated commit object, not a moving local branch ref.
  # Another Writer can advance main after the last HEAD check but before
  # Git resolves push refs; that successor was never included in this Gate.
  PUSH_REF="$VALIDATED_HEAD:refs/heads/$BRANCH"
  PUSH_PROXY="$(git_http_proxy)"
  if push_output="$(GIT_TERMINAL_PROMPT=0 run_bounded_git_http 30 "$PUSH_PROXY" \
    -c http.version=HTTP/2 -c http.lowSpeedLimit=512 -c http.lowSpeedTime=20 \
    push "$REMOTE" "$PUSH_REF" 2>&1)"; then
    printf '%s\n' "$push_output"
  elif grep -Eqi 'HTTP/2|framing|stream|curl 92|timed out|operation too slow|alarm clock|signal 14' <<<"$push_output"; then
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
      if push_output="$(GIT_TERMINAL_PROMPT=0 run_bounded_git_http 30 "$PUSH_PROXY" \
        -c http.version=HTTP/1.1 -c http.lowSpeedLimit=512 -c http.lowSpeedTime=20 \
        push "$REMOTE" "$PUSH_REF" 2>&1)"; then
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
if [[ "$LOCAL_SHA" != "$REMOTE_SHA" ]]; then
  if git merge-base --is-ancestor "$VALIDATED_HEAD" "$REMOTE/$BRANCH"; then
    delete_validation_ref "$VALIDATED_HEAD"
  fi
  fail "main synchronization did not converge: local=$LOCAL_SHA remote=$REMOTE_SHA"
fi
cleanup_validation_refs
retry_pending_main_gate_status

echo "[sync-main] main synchronized at $LOCAL_SHA"
if [[ -n "$(git status --porcelain=v1 --untracked-files=all)" ]]; then
  echo "[sync-main] unrelated or unselected working-tree changes remain; they were not staged or committed:"
  git status --short
fi
