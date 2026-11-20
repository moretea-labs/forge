#!/usr/bin/env bash
set -euo pipefail

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

# Exact-path commit: an unrelated dirty file must remain outside the commit.
printf 'committed\n' >owned.txt
printf 'uncommitted\n' >unrelated.txt
printf 'new source\n' >new-source.ts
bash scripts/sync-main.sh --commit --message 'test: path-scoped main sync' --check-command true --path owned.txt --path new-source.ts >/dev/null
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
bash scripts/sync-main.sh >/dev/null
[[ "$(git rev-parse HEAD)" == "$(git rev-parse origin/main)" ]] || fail "remote-only update was not fast-forwarded"
[[ -f scratch.txt ]] || fail "fast-forward discarded unrelated local dirt"

# The canonical main checkout may be a linked worktree, provided it is the
# only worktree attached to main.
BARE_CLONE="$TMP/canonical.git"
LINKED_MAIN="$TMP/linked-main"
git clone --bare "$BARE" "$BARE_CLONE" >/dev/null 2>&1
git --git-dir="$BARE_CLONE" config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'
git --git-dir="$BARE_CLONE" fetch origin main >/dev/null 2>&1
git --git-dir="$BARE_CLONE" worktree add "$LINKED_MAIN" main >/dev/null 2>&1
mkdir -p "$LINKED_MAIN/scripts"
cp "$ROOT/scripts/sync-main.sh" "$LINKED_MAIN/scripts/sync-main.sh"
chmod +x "$LINKED_MAIN/scripts/sync-main.sh"
(cd "$LINKED_MAIN" && bash scripts/sync-main.sh --dry-run >/dev/null)

# Divergent histories are refused without rewriting either side.
printf 'local commit\n' >local-only.txt
git add local-only.txt
git commit -m 'test: local divergent commit' >/dev/null
LOCAL_BEFORE="$(git rev-parse HEAD)"
cd "$OTHER"
printf 'remote divergent\n' >remote-only.txt
git add remote-only.txt
git commit -m 'test: remote divergent commit' >/dev/null
git push origin main >/dev/null 2>&1
cd "$WORK"
expect_failure 'diverged main' 'have diverged' bash scripts/sync-main.sh
[[ "$(git rev-parse HEAD)" == "$LOCAL_BEFORE" ]] || fail "divergence handling rewrote local main"

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
