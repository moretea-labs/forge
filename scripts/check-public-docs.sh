#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

required=(
  README.md README.en.md README.zh-CN.md README.es.md README.fr.md README.ja.md
  CHANGELOG.md CONTRIBUTING.md SECURITY.md SUPPORT.md CODE_OF_CONDUCT.md
  .github/PULL_REQUEST_TEMPLATE.md
  .github/ISSUE_TEMPLATE/config.yml
  .github/ISSUE_TEMPLATE/bug_report.yml
  .github/ISSUE_TEMPLATE/feature_request.yml
  .github/ISSUE_TEMPLATE/documentation.yml
  .github/ISSUE_TEMPLATE/support.yml
  .github/workflows/release.yml
  docs/README.md
  docs/tutorials/README.md docs/tutorials/README.zh-CN.md
  docs/tutorials/01-install-and-start.md docs/tutorials/01-install-and-start.zh-CN.md
  docs/tutorials/02-connect-chatgpt.md docs/tutorials/02-connect-chatgpt.zh-CN.md
  docs/tutorials/03-first-repository-task.md docs/tutorials/03-first-repository-task.zh-CN.md
  docs/operations/releasing.md docs/operations/releasing.zh-CN.md
  docs/operations/github-repository.md docs/operations/homebrew.md
  docs/operations/platform-support.md docs/operations/platform-support.zh-CN.md
  docs/operations/features.md docs/operations/features.zh-CN.md
  docs/operations/troubleshooting.md docs/operations/troubleshooting.zh-CN.md
  docs/wiki/Home.md docs/wiki/Architecture.md docs/wiki/Operations.md
)
for path in "${required[@]}"; do
  [[ -f "$path" ]] || { echo "[public-docs] missing: $path" >&2; exit 1; }
done

if git grep -n -E 'controller_capabilities and project_snapshot|Start repository work with controller_capabilities|20260612-legacy-research-notes|github.com/greysonOuyang/' -- README*.md docs ':!docs/architecture/history/**' ':!docs/architecture/snapshots/**' >/dev/null; then
  echo "[public-docs] stale onboarding, personal repository URL, or removed legacy reference found" >&2
  exit 1
fi

for path in README.md README.zh-CN.md; do
  lines="$(wc -l < "$path" | tr -d ' ')"
  [[ "$lines" -le 150 ]] || { echo "[public-docs] primary README is too long: $path ($lines lines)" >&2; exit 1; }
  grep -q 'docs/images/repo-harness-banner.svg' "$path" || { echo "[public-docs] missing project banner: $path" >&2; exit 1; }
  grep -q 'Node.js 20.10' "$path" || { echo "[public-docs] missing Node baseline: $path" >&2; exit 1; }
  grep -q 'npm install -g \.' "$path" || { echo "[public-docs] missing verified source install: $path" >&2; exit 1; }
  grep -q '@moretea-labs/repo-harness-controller@next' "$path" || { echo "[public-docs] missing upcoming RC install reference: $path" >&2; exit 1; }
  for link in SUPPORT.md SECURITY.md CONTRIBUTING.md CHANGELOG.md docs/wiki/Home.md; do
    grep -q "$link" "$path" || { echo "[public-docs] missing $link link: $path" >&2; exit 1; }
  done
  if grep -qE '^```mermaid|Repo Actor|Global Scheduler|Evidence Plane|Controller Home|controller-chatgpt-bridge-v8|schema `10`|WorkContract|Process Record|resource claims' "$path"; then
    echo "[public-docs] architecture internals belong in docs/Wiki, not $path" >&2
    exit 1
  fi
done

grep -q 'docs/tutorials/01-install-and-start.md' README.md || { echo "[public-docs] English README missing tutorial link" >&2; exit 1; }
grep -q 'docs/tutorials/01-install-and-start.zh-CN.md' README.zh-CN.md || { echo "[public-docs] Chinese README missing tutorial link" >&2; exit 1; }
grep -q 'not public yet' README.md || { echo "[public-docs] English README must state npm availability honestly" >&2; exit 1; }
grep -q '尚未公开' README.zh-CN.md || { echo "[public-docs] Chinese README must state npm availability honestly" >&2; exit 1; }
grep -q 'maintained English README is \[README.md\]' README.en.md || { echo "[public-docs] README.en.md must remain a compatibility pointer" >&2; exit 1; }
grep -q 'no se mantiene' README.es.md || { echo "[public-docs] Spanish translation must be marked unmaintained" >&2; exit 1; }
grep -q 'n’est pas maintenue' README.fr.md || { echo "[public-docs] French translation must be marked unmaintained" >&2; exit 1; }
grep -q '保守されていません' README.ja.md || { echo "[public-docs] Japanese translation must be marked unmaintained" >&2; exit 1; }

for path in docs/tutorials/01-install-and-start.md docs/tutorials/01-install-and-start.zh-CN.md; do
  grep -q 'Node.js 20.10' "$path" || { echo "[public-docs] missing Node baseline: $path" >&2; exit 1; }
  grep -q 'npm install -g \.' "$path" || { echo "[public-docs] missing source install: $path" >&2; exit 1; }
  grep -q '@moretea-labs/repo-harness-controller@next' "$path" || { echo "[public-docs] missing upcoming package command: $path" >&2; exit 1; }
done

for path in docs/operations/releasing.md docs/operations/releasing.zh-CN.md; do
  grep -q '@moretea-labs/repo-harness-controller' "$path" || { echo "[public-docs] missing package identity: $path" >&2; exit 1; }
  grep -q 'repo-harness-hook' "$path" || { echo "[public-docs] missing CLI identity note: $path" >&2; exit 1; }
  grep -q 'v1.4.0-rc.6' "$path" || { echo "[public-docs] missing next release baseline: $path" >&2; exit 1; }
  grep -q 'Bun' "$path" || { echo "[public-docs] missing Bun distribution role: $path" >&2; exit 1; }
  grep -q 'Homebrew' "$path" || { echo "[public-docs] missing Homebrew distribution role: $path" >&2; exit 1; }
done

grep -q 'npm.*primary package registry' docs/operations/releasing.md || { echo "[public-docs] npm primary registry role is unclear" >&2; exit 1; }
grep -q 'GitHub Releases' docs/operations/releasing.md || { echo "[public-docs] GitHub Release role is unclear" >&2; exit 1; }
grep -q 'publishConfig.provenance' docs/versioning.md || { echo "[public-docs] provenance contract is undocumented" >&2; exit 1; }
grep -q 'after the first stable release' docs/operations/homebrew.md || { echo "[public-docs] Homebrew stable-only gate is unclear" >&2; exit 1; }
grep -q 'WSL2' docs/operations/platform-support.md || { echo "[public-docs] platform matrix missing WSL2" >&2; exit 1; }
grep -q 'Windows 原生' docs/operations/platform-support.zh-CN.md || { echo "[public-docs] Chinese platform matrix missing native Windows scope" >&2; exit 1; }
grep -q 'rh_status' docs/tutorials/02-connect-chatgpt.md || { echo "[public-docs] connector tutorial missing facade verification" >&2; exit 1; }

grep -q '@moretea-labs/repo-harness-controller' install.sh || { echo "[public-docs] shell installer uses the wrong package identity" >&2; exit 1; }
grep -q '@moretea-labs/repo-harness-controller' install.ps1 || { echo "[public-docs] PowerShell installer uses the wrong package identity" >&2; exit 1; }
if grep -q 'PACKAGE_NAME="repo-harness"' install.sh || grep -q '\$PackageName = "repo-harness"' install.ps1; then
  echo "[public-docs] installer regressed to the unscoped package" >&2
  exit 1
fi

node - <<'NODE'
const p = require("./package.json");
const files = new Set(p.files || []);
for (const required of [
  "LICENSE", "CHANGELOG.md", "CONTRIBUTING.md", "SECURITY.md", "SUPPORT.md",
  "CODE_OF_CONDUCT.md", "NOTICE", "THIRD_PARTY_NOTICES.md", "README.md",
  "README.en.md", "README.zh-CN.md", "docs/README.md", "docs/tutorials/",
  "docs/operations/", "docs/wiki/",
]) {
  if (!files.has(required)) throw new Error(`package files missing ${required}`);
}
for (const forbidden of ["ARCHITECTURE_MIGRATION_REPORT.md", "OPTIMIZATION_REPORT.md"]) {
  if (files.has(forbidden)) throw new Error(`internal report must not be packed: ${forbidden}`);
}
if (p.publishConfig?.access !== "public" || p.publishConfig?.provenance !== true) {
  throw new Error("publishConfig must enable public access and provenance");
}
if (p.publishConfig?.tag !== undefined) throw new Error("publishConfig.tag must be omitted");
if (!String(p.repository?.url || "").includes("moretea-labs/repo-harness-controller-runtime")) {
  throw new Error("package repository metadata is not canonical");
}
NODE

echo "[public-docs] OK"
