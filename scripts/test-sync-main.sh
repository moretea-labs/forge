#!/usr/bin/env bash
set -euo pipefail

# GitHub Actions sets TEST_BASE_REF to the real repository's commit. This
# fixture creates unrelated temporary Git histories; their check base must
# come from each fixture's own origin/main, not the outer CI environment.
unset TEST_BASE_REF
# Reproduce the environment GitHub Actions injects. A local bare fixture must
# never inherit the outer repository identity or attempt real GitHub API calls.
export GITHUB_REPOSITORY=moretea-labs/forge

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
BARE="$TMP/remote.git"
WORK="$TMP/work"
OTHER="$TMP/other"

fail() {
  echo "test-sync-main: $*" >&2
  exit 1
}
expect_failure() {
  local label="$1" expected="$2"
  shift 2
  if "$@" >"$TMP/failure.out" 2>&1; then
    cat "$TMP/failure.out" >&2
    fail "expected failure: $label"
  fi
  grep -Fq "$expected" "$TMP/failure.out" || {
    cat "$TMP/failure.out" >&2
    fail "failure did not report expected reason for $label: $expected"
  }
}

git init --bare "$BARE" >/dev/null
git clone "$BARE" "$WORK" >/dev/null 2>&1
cd "$WORK"
git switch -c main >/dev/null
git config user.name "Forge Sync Test"
git config user.email "forge-sync-test@example.invalid"
mkdir -p scripts
cp "$ROOT/scripts/sync-main.sh" scripts/sync-main.sh
chmod +x scripts/sync-main.sh
printf 'base\n' >owned.txt
printf 'untouched\n' >unrelated.txt
git add owned.txt unrelated.txt scripts/sync-main.sh
git commit -m 'test: initialize sync fixture' >/dev/null
git push -u origin main >/dev/null 2>&1
# A freshly initialized bare repository may still advertise master as HEAD
# even though this fixture publishes main. GitHub runners do not necessarily
# configure init.defaultBranch=main; make clone behavior deterministic.
git --git-dir="$BARE" symbolic-ref HEAD refs/heads/main

# Exact-path commit: an unrelated dirty file must remain outside the commit.
printf 'committed\n' >owned.txt
printf 'uncommitted\n' >unrelated.txt
printf 'new source\n' >new-source.ts
bash scripts/sync-main.sh --commit --message 'test: path-scoped main sync' --check-command 'test "$TEST_BASE_REF" = origin/main && test "$FORGE_CHECK_SOURCE_QUALITY_MODE" = workspace' --path owned.txt --path new-source.ts >/dev/null
REMOTE_OWNED="$(git --git-dir="$BARE" show main:owned.txt)"
REMOTE_NEW="$(git --git-dir="$BARE" show main:new-source.ts)"
[[ "$REMOTE_OWNED" == committed ]] || fail "selected tracked path was not committed"
[[ "$REMOTE_NEW" == 'new source' ]] || fail "selected untracked source file was not committed"
[[ "$(git --git-dir="$BARE" show main:unrelated.txt)" == untouched ]] || fail "unselected dirty path leaked into commit"
git diff --quiet -- unrelated.txt && fail "unselected dirty path was unexpectedly discarded"

# A failed validation must not create a commit or stage the selected file.
BEFORE="$(git rev-parse HEAD)"
printf 'rejected\n' >owned.txt
expect_failure 'validation failure' 'running validation' bash scripts/sync-main.sh --commit --message 'test: must not commit' --check-command false --path owned.txt
[[ "$(git rev-parse HEAD)" == "$BEFORE" ]] || fail "validation failure changed HEAD"
git diff --quiet -- owned.txt && fail "validation failure discarded the working change"
git diff --cached --quiet || fail "validation failure left staged changes"

# Two pending commits must be checked against the remote baseline. Checking
# HEAD alone would miss the first commit (the actual remote CI regression).
printf 'first source\n' >pending-first.ts
git add pending-first.ts
git commit -m 'test: first pending source commit' >/dev/null
printf 'second source\n' >pending-second.ts
git add pending-second.ts
git commit -m 'test: second pending source commit' >/dev/null
bash scripts/sync-main.sh --check-command 'test "$TEST_BASE_REF" = origin/main && test "$FORGE_CHECK_SOURCE_QUALITY_MODE" = committed && test "$FORGE_CHECK_CANDIDATE_SHA" = "$(git rev-parse HEAD)" && git diff --name-only "$TEST_BASE_REF"...HEAD | grep -Fxq pending-first.ts && git diff --name-only "$TEST_BASE_REF"...HEAD | grep -Fxq pending-second.ts' >/dev/null
[[ "$(git rev-parse main)" == "$(git rev-parse origin/main)" ]] || fail "multi-commit candidate did not synchronize"

# A second Writer must not sneak an unchecked successor commit into a validated push.
printf 'new candidate\n' >pending-third.ts
git add pending-third.ts
git commit -m 'test: candidate before concurrent writer' >/dev/null
REMOTE_BEFORE_CONCURRENT="$(git --git-dir="$BARE" rev-parse main)"
expect_failure 'concurrent HEAD successor' 'HEAD changed during validation' bash scripts/sync-main.sh --check-command 'git commit --allow-empty -qm "test: concurrent writer successor"'
[[ "$(git --git-dir="$BARE" rev-parse main)" == "$REMOTE_BEFORE_CONCURRENT" ]] || fail "unvalidated successor reached remote"
bash scripts/sync-main.sh --check-command 'test "$FORGE_CHECK_SOURCE_QUALITY_MODE" = committed' >/dev/null

# A Writer racing *inside* git push must not publish a successor that was
# created after the last HEAD identity check. The wrapper injects precisely
# at the push invocation, later than script-level validation checks.
printf 'push race candidate\n' >pending-push-race.ts
git add pending-push-race.ts
git commit -m 'test: validated before push race' >/dev/null
VALIDATED_BEFORE_PUSH="$(git rev-parse HEAD)"
mkdir -p "$TMP/git-wrapper"
cat >"$TMP/git-wrapper/git" <<'GIT_WRAPPER'
#!/usr/bin/env bash
set -euo pipefail
contains_arg() {
  local expected="$1"
  shift
  local arg
  for arg in "$@"; do
    [[ "$arg" == "$expected" ]] && return 0
  done
  return 1
}
is_main_ref_update() {
  local arg
  for arg in "$@"; do
    [[ "$arg" == *"refs/heads/main" ]] && return 0
  done
  return 1
}
if contains_arg fetch "$@" && contains_arg http.version=HTTP/2 "$@" && \
  [[ "${FORGE_TEST_HTTP2_FETCH_FAILURE:-}" == 1 ]] && \
  [[ ! -e "${FORGE_TEST_HTTP2_FETCH_MARKER:-/dev/null}" ]]; then
  printf '%s\\n' "$*" >"$FORGE_TEST_HTTP2_FETCH_MARKER"
  echo 'fatal: unable to access remote: HTTP/2 framing layer' >&2
  exit 1
fi
if contains_arg fetch "$@" && contains_arg http.version=HTTP/1.1 "$@"; then
  printf '%s\\n' "$*" >"${FORGE_TEST_HTTP1_FETCH_MARKER:?missing HTTP/1.1 fetch marker}"
fi
if contains_arg push "$@" && is_main_ref_update "$@" && [[ "${FORGE_TEST_PUSH_RACE:-}" == 1 ]] && \
  [[ ! -e "${FORGE_TEST_PUSH_RACE_MARKER:-/dev/null}" ]]; then
  printf '%s\n' "$*" >"$FORGE_TEST_PUSH_RACE_MARKER"
  "$FORGE_TEST_REAL_GIT" -c user.name='Concurrent Writer' -c user.email=writer@example.invalid \
    commit --allow-empty -qm 'test: successor created inside git push'
fi
if contains_arg push "$@" && is_main_ref_update "$@" && contains_arg http.version=HTTP/2 "$@" && \
  [[ "${FORGE_TEST_HTTP2_PUSH_FAILURE:-}" == 1 ]] && \
  [[ ! -e "${FORGE_TEST_HTTP2_PUSH_MARKER:-/dev/null}" ]]; then
  printf '%s\n' "$*" >"$FORGE_TEST_HTTP2_PUSH_MARKER"
  echo 'fatal: unable to access remote: HTTP/2 framing layer' >&2
  exit 1
fi
if contains_arg push "$@" && is_main_ref_update "$@" && contains_arg http.version=HTTP/1.1 "$@"; then
  printf '%s\n' "$*" >"${FORGE_TEST_HTTP1_PUSH_MARKER:?missing HTTP/1.1 marker}"
fi
exec "$FORGE_TEST_REAL_GIT" "$@"
GIT_WRAPPER
chmod +x "$TMP/git-wrapper/git"
expect_failure 'racing Writer at push dispatch' 'main synchronization did not converge' \
  env PATH="$TMP/git-wrapper:$PATH" FORGE_TEST_PUSH_RACE=1 \
  FORGE_TEST_PUSH_RACE_MARKER="$TMP/push-race-marker" \
  FORGE_TEST_REAL_GIT="$(command -v git)" \
  bash scripts/sync-main.sh --check-command "test \"\$FORGE_CHECK_SOURCE_QUALITY_MODE\" = committed"
[[ -f "$TMP/push-race-marker" ]] || fail "push-race fixture did not inject a successor"
[[ "$(git --git-dir="$BARE" rev-parse main)" == "$VALIDATED_BEFORE_PUSH" ]] ||
  fail "unvalidated successor was pushed after the final HEAD check"
[[ "$(git rev-parse HEAD)" != "$VALIDATED_BEFORE_PUSH" ]] ||
  fail "push-race fixture did not advance local HEAD"
# The next invocation validates that successor before allowing publication.
bash scripts/sync-main.sh --check-command 'test "$FORGE_CHECK_SOURCE_QUALITY_MODE" = committed' >/dev/null

# A transient HTTP/2 framing failure gets one safe HTTP/1.1 retry. The fixture
# fails before updating the remote, then records the explicit fallback command.
printf 'http2 fallback candidate\n' >pending-http2-fallback.ts
git add pending-http2-fallback.ts
git commit -m 'test: retry framing failure over HTTP/1.1' >/dev/null
rm -f "$TMP/http2-push-marker" "$TMP/http1-push-marker"
# shellcheck disable=SC2016
env PATH="$TMP/git-wrapper:$PATH" FORGE_TEST_HTTP2_PUSH_FAILURE=1 \
  FORGE_TEST_HTTP2_PUSH_MARKER="$TMP/http2-push-marker" \
  FORGE_TEST_HTTP1_PUSH_MARKER="$TMP/http1-push-marker" \
  FORGE_TEST_REAL_GIT="$(command -v git)" \
  bash scripts/sync-main.sh --check-command 'test "$FORGE_CHECK_SOURCE_QUALITY_MODE" = committed' >/dev/null
[[ -f "$TMP/http2-push-marker" ]] || fail "HTTP/2 failure was not injected"
[[ -f "$TMP/http1-push-marker" ]] || fail "HTTP/1.1 fallback was not attempted"
[[ "$(git rev-parse HEAD)" == "$(git --git-dir="$BARE" rev-parse main)" ]] ||
  fail "HTTP/1.1 fallback did not publish the exact validated candidate"

# The exact candidate must receive a real GitHub Actions workflow_dispatch
# check on its temporary tag before the protected main ref can move.
grep -Fq '  workflow_dispatch:' "$ROOT/.github/workflows/ci.yml" ||
  fail "CI workflow must expose workflow_dispatch for pre-push Main gate validation"
printf 'workflow candidate\n' >pending-workflow.ts
git add pending-workflow.ts
git commit -m 'test: validate main candidate through GitHub Actions before push' >/dev/null
cat >"$TMP/fake-gh" <<'GH_WRAPPER'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$FORGE_TEST_GH_MARKER"
case "$1" in
  workflow)
    [[ "$2" == run ]] || exit 2
    ref=""
    while [[ $# -gt 0 ]]; do
      if [[ "$1" == "--ref" ]]; then
        shift
        ref="$1"
      fi
      shift
    done
    [[ "$ref" == "$FORGE_TEST_GH_CANDIDATE_TAG" ]] || {
      echo "workflow dispatched for unexpected ref: $ref" >&2
      exit 2
    }
    sha="$(git --git-dir="$FORGE_TEST_BARE_GIT_DIR" rev-parse "refs/tags/$ref")"
    [[ "$sha" == "$FORGE_TEST_GH_CANDIDATE_SHA" ]] || exit 2
    remote_sha="$(git --git-dir="$FORGE_TEST_BARE_GIT_DIR" rev-parse main)"
    [[ "$remote_sha" == "$FORGE_TEST_REMOTE_MAIN_BEFORE_GATE" ]] || {
      echo "main moved before GitHub Actions validation completed" >&2
      exit 2
    }
    run_count="$(cat "$FORGE_TEST_GH_RUN_COUNT_FILE" 2>/dev/null || printf '0')"
    printf '%s\n' "$((run_count + 1))" >"$FORGE_TEST_GH_RUN_COUNT_FILE"
    printf 'dispatched %s %s\n' "$ref" "$sha" >>"$FORGE_TEST_GH_DISPATCH_MARKER"
    printf 'Created workflow_dispatch for %s\n' "$ref"
    ;;
  api)
    endpoint="$2"
    case "$endpoint" in
      *actions/workflows/ci.yml/runs*)
        run_count="$(cat "$FORGE_TEST_GH_RUN_COUNT_FILE" 2>/dev/null || printf '0')"
        if [[ "$run_count" -eq 0 ]]; then
          printf '{"workflow_runs":[]}\n'
          exit 0
        fi
        poll_count="$(cat "$FORGE_TEST_GH_POLL_COUNT_FILE" 2>/dev/null || printf '0')"
        poll_count=$((poll_count + 1))
        printf '%s\n' "$poll_count" >"$FORGE_TEST_GH_POLL_COUNT_FILE"
        run_status=completed
        run_conclusion="$FORGE_TEST_GH_CONCLUSION"
        if [[ "$FORGE_TEST_GH_PENDING_FIRST" == 1 && "$poll_count" -eq 1 ]]; then
          run_status=in_progress
          run_conclusion=""
        fi
        suite_id=$((1000 + run_count))
        if [[ -n "$run_conclusion" ]]; then
          conclusion_json="\"$run_conclusion\""
        else
          conclusion_json=null
        fi
        printf '{"workflow_runs":[{"id":%s,"run_number":%s,"head_sha":"%s","head_branch":"%s","event":"workflow_dispatch","status":"%s","conclusion":%s,"check_suite_id":%s}]}\n' \
          "$run_count" "$run_count" "$FORGE_TEST_GH_CANDIDATE_SHA" "$FORGE_TEST_GH_CANDIDATE_TAG" "$run_status" "$conclusion_json" "$suite_id"
        ;;
      *check-suites/*/check-runs*)
        suite_id="$(printf '%s' "$endpoint" | sed -E 's#.*check-suites/([0-9]+)/check-runs.*#\1#')"
        run_number=$((suite_id - 1000))
        [[ "$run_number" -gt 0 ]] || exit 2
        printf '{"check_runs":[{"name":"Main gate","status":"completed","conclusion":"%s","app":{"id":%s,"slug":"github-actions"}}]}\n' \
          "$FORGE_TEST_GH_CONCLUSION" "$FORGE_TEST_GH_APP_ID"
        ;;
      *statuses*)
        echo "custom commit statuses are forbidden" >&2
        exit 2
        ;;
      *)
        echo "unexpected GitHub API path: $endpoint" >&2
        exit 2
        ;;
    esac
    ;;
  *)
    echo "unexpected GitHub CLI command: $*" >&2
    exit 2
    ;;
esac
GH_WRAPPER
chmod +x "$TMP/fake-gh"
GATE_SUCCESS_SHA="$(git rev-parse HEAD)"
GATE_SUCCESS_TAG="forge-validation/$GATE_SUCCESS_SHA"
GATE_SUCCESS_REMOTE_BASE="$(git --git-dir="$BARE" rev-parse main)"
rm -f "$TMP/github-actions-marker" "$TMP/github-actions-dispatches" "$TMP/github-actions-run-count" "$TMP/github-actions-poll-count"
# shellcheck disable=SC2016
env FORGE_GH_BIN="$TMP/fake-gh" \
  FORGE_GITHUB_REPOSITORY=moretea-labs/forge \
  FORGE_MAIN_GATE_CHECK_NAME='Fake gate' \
  FORGE_MAIN_GATE_APP_ID=99999 \
  FORGE_MAIN_GATE_TIMEOUT_SECONDS=5 \
  FORGE_MAIN_GATE_POLL_SECONDS=0 \
  FORGE_TEST_BARE_GIT_DIR="$BARE" \
  FORGE_TEST_GH_CANDIDATE_SHA="$GATE_SUCCESS_SHA" \
  FORGE_TEST_GH_CANDIDATE_TAG="$GATE_SUCCESS_TAG" \
  FORGE_TEST_REMOTE_MAIN_BEFORE_GATE="$GATE_SUCCESS_REMOTE_BASE" \
  FORGE_TEST_GH_CONCLUSION=success \
  FORGE_TEST_GH_APP_ID=15368 \
  FORGE_TEST_GH_PENDING_FIRST=1 \
  FORGE_TEST_GH_MARKER="$TMP/github-actions-marker" \
  FORGE_TEST_GH_DISPATCH_MARKER="$TMP/github-actions-dispatches" \
  FORGE_TEST_GH_RUN_COUNT_FILE="$TMP/github-actions-run-count" \
  FORGE_TEST_GH_POLL_COUNT_FILE="$TMP/github-actions-poll-count" \
  bash scripts/sync-main.sh --check-command 'test "$FORGE_CHECK_SOURCE_QUALITY_MODE" = committed' >/dev/null
[[ "$(git --git-dir="$BARE" rev-parse main)" == "$(git rev-parse HEAD)" ]] ||
  fail "candidate was pushed without first completing GitHub Actions Main gate"
[[ "$(cat "$TMP/github-actions-poll-count")" -ge 2 ]] ||
  fail "sync-main did not wait for the in-progress GitHub Actions run"
grep -Fq "workflow run ci.yml --repo moretea-labs/forge --ref $GATE_SUCCESS_TAG" "$TMP/github-actions-marker" ||
  fail "exact candidate tag was not dispatched to the CI workflow"
grep -Fq 'check-suites/' "$TMP/github-actions-marker" ||
  fail "GitHub Actions check suite was not read back"
if grep -Fq '/statuses/' "$TMP/github-actions-marker"; then
  fail "sync-main attempted to publish a synthetic commit status"
fi
if git --git-dir="$BARE" show-ref --verify --quiet "refs/tags/$GATE_SUCCESS_TAG"; then
  fail "temporary validation tag remained after successful main publication"
fi

# A failed GitHub Actions run blocks main and preserves its exact validation tag.
printf 'workflow failure candidate\n' >pending-workflow-failure.ts
git add pending-workflow-failure.ts
git commit -m 'test: block main publication when GitHub Actions fails' >/dev/null
FAILED_GATE_SHA="$(git rev-parse HEAD)"
FAILED_GATE_TAG="forge-validation/$FAILED_GATE_SHA"
REMOTE_BEFORE_GATE_FAILURE="$(git --git-dir="$BARE" rev-parse main)"
rm -f "$TMP/github-actions-failure-run-count" "$TMP/github-actions-failure-poll-count"
# shellcheck disable=SC2016
expect_failure 'failed GitHub Actions Main gate' 'conclusion=failure' \
  env FORGE_GH_BIN="$TMP/fake-gh" \
  FORGE_GITHUB_REPOSITORY=moretea-labs/forge \
  FORGE_MAIN_GATE_CHECK_NAME='Main gate' \
  FORGE_MAIN_GATE_APP_ID=15368 \
  FORGE_MAIN_GATE_TIMEOUT_SECONDS=5 \
  FORGE_MAIN_GATE_POLL_SECONDS=0 \
  FORGE_TEST_BARE_GIT_DIR="$BARE" \
  FORGE_TEST_GH_CANDIDATE_SHA="$FAILED_GATE_SHA" \
  FORGE_TEST_GH_CANDIDATE_TAG="$FAILED_GATE_TAG" \
  FORGE_TEST_REMOTE_MAIN_BEFORE_GATE="$REMOTE_BEFORE_GATE_FAILURE" \
  FORGE_TEST_GH_CONCLUSION=failure \
  FORGE_TEST_GH_APP_ID=15368 \
  FORGE_TEST_GH_PENDING_FIRST=0 \
  FORGE_TEST_GH_MARKER="$TMP/github-actions-failure-marker" \
  FORGE_TEST_GH_DISPATCH_MARKER="$TMP/github-actions-failure-dispatches" \
  FORGE_TEST_GH_RUN_COUNT_FILE="$TMP/github-actions-failure-run-count" \
  FORGE_TEST_GH_POLL_COUNT_FILE="$TMP/github-actions-failure-poll-count" \
  bash scripts/sync-main.sh --check-command 'test "$FORGE_CHECK_SOURCE_QUALITY_MODE" = committed'
[[ "$(git --git-dir="$BARE" rev-parse main)" == "$REMOTE_BEFORE_GATE_FAILURE" ]] ||
  fail "main moved despite a failed GitHub Actions Main gate"
[[ "$(git --git-dir="$BARE" rev-parse "refs/tags/$FAILED_GATE_TAG")" == "$FAILED_GATE_SHA" ]] ||
  fail "failed GitHub Actions run did not preserve its validation tag"

# A successful workflow run from the wrong GitHub App is not a required check.
WRONG_APP_SHA="$FAILED_GATE_SHA"
WRONG_APP_TAG="$FAILED_GATE_TAG"
REMOTE_BEFORE_WRONG_APP="$REMOTE_BEFORE_GATE_FAILURE"
rm -f "$TMP/github-actions-wrong-app-run-count" "$TMP/github-actions-wrong-app-poll-count"
# shellcheck disable=SC2016
expect_failure 'wrong GitHub App identity' 'from GitHub Actions app 15368' \
  env FORGE_GH_BIN="$TMP/fake-gh" \
  FORGE_GITHUB_REPOSITORY=moretea-labs/forge \
  FORGE_MAIN_GATE_CHECK_NAME='Main gate' \
  FORGE_MAIN_GATE_APP_ID=15368 \
  FORGE_MAIN_GATE_TIMEOUT_SECONDS=5 \
  FORGE_MAIN_GATE_POLL_SECONDS=0 \
  FORGE_TEST_BARE_GIT_DIR="$BARE" \
  FORGE_TEST_GH_CANDIDATE_SHA="$WRONG_APP_SHA" \
  FORGE_TEST_GH_CANDIDATE_TAG="$WRONG_APP_TAG" \
  FORGE_TEST_REMOTE_MAIN_BEFORE_GATE="$REMOTE_BEFORE_WRONG_APP" \
  FORGE_TEST_GH_CONCLUSION=success \
  FORGE_TEST_GH_APP_ID=99999 \
  FORGE_TEST_GH_PENDING_FIRST=0 \
  FORGE_TEST_GH_MARKER="$TMP/github-actions-wrong-app-marker" \
  FORGE_TEST_GH_DISPATCH_MARKER="$TMP/github-actions-wrong-app-dispatches" \
  FORGE_TEST_GH_RUN_COUNT_FILE="$TMP/github-actions-wrong-app-run-count" \
  FORGE_TEST_GH_POLL_COUNT_FILE="$TMP/github-actions-wrong-app-poll-count" \
  bash scripts/sync-main.sh --check-command 'test "$FORGE_CHECK_SOURCE_QUALITY_MODE" = committed'
[[ "$(git --git-dir="$BARE" rev-parse main)" == "$REMOTE_BEFORE_WRONG_APP" ]] ||
  fail "main moved despite a Main gate check from the wrong GitHub App"
[[ "$(git --git-dir="$BARE" rev-parse "refs/tags/$WRONG_APP_TAG")" == "$WRONG_APP_SHA" ]] ||
  fail "wrong-App Main gate failure did not preserve its validation tag"

# Retrying a previously failed candidate dispatches a fresh run and publishes
# only after the new run has succeeded under the required GitHub Actions app.
rm -f "$TMP/github-actions-failure-poll-count"
# shellcheck disable=SC2016
env FORGE_GH_BIN="$TMP/fake-gh" \
  FORGE_GITHUB_REPOSITORY=moretea-labs/forge \
  FORGE_MAIN_GATE_CHECK_NAME='Main gate' \
  FORGE_MAIN_GATE_APP_ID=15368 \
  FORGE_MAIN_GATE_TIMEOUT_SECONDS=5 \
  FORGE_MAIN_GATE_POLL_SECONDS=0 \
  FORGE_TEST_BARE_GIT_DIR="$BARE" \
  FORGE_TEST_GH_CANDIDATE_SHA="$FAILED_GATE_SHA" \
  FORGE_TEST_GH_CANDIDATE_TAG="$FAILED_GATE_TAG" \
  FORGE_TEST_REMOTE_MAIN_BEFORE_GATE="$REMOTE_BEFORE_GATE_FAILURE" \
  FORGE_TEST_GH_CONCLUSION=success \
  FORGE_TEST_GH_APP_ID=15368 \
  FORGE_TEST_GH_PENDING_FIRST=0 \
  FORGE_TEST_GH_MARKER="$TMP/github-actions-retry-marker" \
  FORGE_TEST_GH_DISPATCH_MARKER="$TMP/github-actions-retry-dispatches" \
  FORGE_TEST_GH_RUN_COUNT_FILE="$TMP/github-actions-failure-run-count" \
  FORGE_TEST_GH_POLL_COUNT_FILE="$TMP/github-actions-failure-poll-count" \
  bash scripts/sync-main.sh --check-command 'test "$FORGE_CHECK_SOURCE_QUALITY_MODE" = committed' >/dev/null
[[ "$(git --git-dir="$BARE" rev-parse main)" == "$FAILED_GATE_SHA" ]] ||
  fail "successful retry did not publish the previously failed candidate"
if git --git-dir="$BARE" show-ref --verify --quiet "refs/tags/$FAILED_GATE_TAG"; then
  fail "temporary validation tag remained after successful retry"
fi
[[ "$(cat "$TMP/github-actions-failure-run-count")" -eq 2 ]] ||
  fail "retry did not dispatch a fresh GitHub Actions workflow run"

# A remote-only fast-forward is synchronized without touching unrelated dirt.
git clone "$BARE" "$OTHER" >/dev/null 2>&1
cd "$OTHER"
git config user.name "Forge Sync Test"
git config user.email "forge-sync-test@example.invalid"
printf 'remote advance\n' >remote.txt
git add remote.txt
git commit -m 'test: remote advance' >/dev/null
git push origin main >/dev/null 2>&1
cd "$WORK"
printf 'local scratch\n' >scratch.txt
rm -f "$TMP/http2-fetch-marker" "$TMP/http1-fetch-marker"
# shellcheck disable=SC2016
env PATH="$TMP/git-wrapper:$PATH" FORGE_GIT_HTTP_PROXY=http://127.0.0.1:17890 \
  FORGE_TEST_HTTP2_FETCH_FAILURE=1 \
  FORGE_TEST_HTTP2_FETCH_MARKER="$TMP/http2-fetch-marker" \
  FORGE_TEST_HTTP1_FETCH_MARKER="$TMP/http1-fetch-marker" \
  FORGE_TEST_REAL_GIT="$(command -v git)" \
  bash scripts/sync-main.sh >/dev/null
[[ -f "$TMP/http2-fetch-marker" ]] || fail "HTTP/2 fetch failure was not injected"
[[ -f "$TMP/http1-fetch-marker" ]] || fail "HTTP/1.1 fetch fallback was not attempted"
grep -Fq 'http.proxy=http://127.0.0.1:17890' "$TMP/http1-fetch-marker" ||
  fail "Git fetch did not receive the configured HTTP proxy"
[[ "$(git rev-parse HEAD)" == "$(git rev-parse origin/main)" ]] || fail "remote-only update was not fast-forwarded"
[[ -f scratch.txt ]] || fail "fast-forward discarded unrelated local dirt"

# The canonical main checkout may be a linked worktree, provided it is the
# only worktree attached to main.
BARE_CLONE="$TMP/canonical.git"
LINKED_MAIN="$TMP/linked-main"
git clone --bare "$BARE" "$BARE_CLONE" >/dev/null 2>&1
git --git-dir="$BARE_CLONE" config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'
git --git-dir="$BARE_CLONE" fetch origin refs/heads/main:refs/remotes/origin/main >/dev/null 2>&1
git --git-dir="$BARE_CLONE" worktree add "$LINKED_MAIN" main >/dev/null 2>&1
mkdir -p "$LINKED_MAIN/scripts"
cp "$ROOT/scripts/sync-main.sh" "$LINKED_MAIN/scripts/sync-main.sh"
chmod +x "$LINKED_MAIN/scripts/sync-main.sh"
(cd "$LINKED_MAIN" && bash scripts/sync-main.sh --dry-run >/dev/null)

# Legacy sync Merge Commits are flattened by rebase. Dirty Writer changes
# block reconciliation without stash/reset; after the Writer finishes, the
# same candidate is rebased linearly and both sides' content is preserved.
git restore -- unrelated.txt owned.txt
rm -f scratch.txt
printf 'writer-owned dirty\n' >writer-unrelated.txt
printf 'local commit\n' >local-only.txt
git add local-only.txt
git commit -m 'test: local divergent commit' >/dev/null
cd "$OTHER"
printf 'remote divergent\n' >remote-only.txt
git add remote-only.txt
git commit -m 'test: remote divergent commit' >/dev/null
git push origin main >/dev/null 2>&1
cd "$WORK"
git fetch origin refs/heads/main:refs/remotes/origin/main >/dev/null 2>&1
git merge --no-edit --no-ff origin/main >/dev/null
LOCAL_MERGED_HEAD="$(git rev-parse HEAD)"
REMOTE_BEFORE_REBASE="$(git --git-dir="$BARE" rev-parse main)"
expect_failure 'dirty divergent Writer' 'checkout is dirty' bash scripts/sync-main.sh --check-command true
[[ "$(git rev-parse HEAD)" == "$LOCAL_MERGED_HEAD" ]] || fail "dirty divergence rewrote local main"
[[ "$(git rev-parse origin/main)" == "$REMOTE_BEFORE_REBASE" ]] || fail "dirty divergence changed the remote tracking ref"
[[ "$(cat writer-unrelated.txt)" == 'writer-owned dirty' ]] || fail "dirty Writer changes were lost during rejected reconciliation"
rm -f writer-unrelated.txt
bash scripts/sync-main.sh --check-command true >/dev/null
[[ "$(git rev-parse HEAD)" == "$(git rev-parse origin/main)" ]] || fail "divergent histories did not converge"
[[ -z "$(git rev-list --merges origin/main..main)" ]] || fail "linear reconciliation left a merge commit"
[[ "$(git show main:local-only.txt)" == 'local commit' ]] || fail "local divergent commit was lost"
[[ "$(git show main:remote-only.txt)" == 'remote divergent' ]] || fail "remote divergent commit was lost"

# Conflicting histories remain untouched and are reported for manual resolution.
printf 'local conflict\n' >conflict.txt
git add conflict.txt
git commit -m 'test: local conflicting commit' >/dev/null
LOCAL_BEFORE="$(git rev-parse HEAD)"
cd "$OTHER"
git fetch origin refs/heads/main:refs/remotes/origin/main >/dev/null 2>&1
git merge --ff-only origin/main >/dev/null
printf 'remote conflict\n' >conflict.txt
git add conflict.txt
git commit -m 'test: remote conflicting commit' >/dev/null
git push origin main >/dev/null 2>&1
REMOTE_BEFORE="$(git --git-dir="$BARE" rev-parse main)"
cd "$WORK"
expect_failure 'conflicting divergence' 'rebase conflicted' bash scripts/sync-main.sh
[[ "$(git rev-parse HEAD)" == "$LOCAL_BEFORE" ]] || fail "conflicting divergence rewrote local main"
[[ "$(git rev-parse origin/main)" == "$REMOTE_BEFORE" ]] || fail "conflicting divergence changed the remote tracking ref"

# Non-main source branches and pre-staged indexes are rejected.
git switch -c forbidden-feature >/dev/null
expect_failure 'non-main branch' 'must run from the canonical main checkout' bash scripts/sync-main.sh

git switch main >/dev/null
printf 'staged elsewhere\n' >unrelated.txt
git add unrelated.txt
expect_failure 'pre-staged index' 'index already contains staged changes' bash scripts/sync-main.sh --commit --message 'test: no staged leakage' --check-command true --path owned.txt

# Legacy task worktree and PR delivery entry points must fail closed.
expect_failure 'legacy worktree start' 'branch/worktree creation is disabled' bash "$ROOT/scripts/contract-worktree.sh" start
expect_failure 'legacy worktree finish' 'branch-based finish/merge is disabled' bash "$ROOT/scripts/contract-worktree.sh" finish
expect_failure 'legacy PR delivery' 'PR-based delivery is disabled' bash "$ROOT/scripts/ship-worktrees.sh" --ready
expect_failure 'legacy branch merge delivery' 'branch-based delivery is disabled' bash "$ROOT/scripts/ship-worktrees.sh" --local-merge

printf '[test-sync-main] PASS\n'
