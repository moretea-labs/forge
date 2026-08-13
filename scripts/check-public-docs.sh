#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PACKAGE_VERSION="$(node -p "require('./package.json').version")"
if [[ "$PACKAGE_VERSION" == *-rc.* ]]; then
  INSTALL_SPEC='@moretea-labs/forge@next'
  README_CHANNEL_EN='npm `next`'
  README_CHANNEL_ZH='npm 使用 `next`'
else
  INSTALL_SPEC='@moretea-labs/forge'
  README_CHANNEL_EN='npm `latest`'
  README_CHANNEL_ZH='npm `latest`'
fi

required=(
  README.md README.en.md README.zh-CN.md
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

if git grep -n -E 'controller_capabilities and project_snapshot|Start repository work with controller_capabilities|20260612-legacy-research-notes|github[.]com/greyson[O]uyang/' -- README*.md docs ':!docs/architecture/history/**' ':!docs/architecture/snapshots/**' >/dev/null; then
  echo "[public-docs] stale onboarding, personal repository URL, or removed legacy reference found" >&2
  exit 1
fi

for path in README.md README.zh-CN.md; do
  lines="$(wc -l < "$path" | tr -d ' ')"
  [[ "$lines" -le 150 ]] || { echo "[public-docs] primary README is too long: $path ($lines lines)" >&2; exit 1; }
  if [[ "$path" == "README.md" ]]; then
    grep -q 'docs/images/forge-banner.svg' "$path" || { echo "[public-docs] missing English Forge banner: $path" >&2; exit 1; }
  else
    grep -q 'docs/images/forge-banner-cn.svg' "$path" || { echo "[public-docs] missing Chinese Forge banner: $path" >&2; exit 1; }
  fi
  grep -q 'Node.js 20.10' "$path" || { echo "[public-docs] missing Node baseline: $path" >&2; exit 1; }
  grep -q 'npm install -g \.' "$path" || { echo "[public-docs] missing verified source install: $path" >&2; exit 1; }
  grep -q "$INSTALL_SPEC" "$path" || { echo "[public-docs] missing package install reference for $PACKAGE_VERSION: $path" >&2; exit 1; }
  for link in SUPPORT.md SECURITY.md CONTRIBUTING.md CHANGELOG.md docs/wiki/Home.md; do
    grep -q "$link" "$path" || { echo "[public-docs] missing $link link: $path" >&2; exit 1; }
  done
  if grep -qE '^```mermaid|Repo Actor|Global Scheduler|Evidence Plane|Controller Home|schema `10`|WorkContract|Process Record|resource claims' "$path"; then
    echo "[public-docs] architecture internals belong in docs/Wiki, not $path" >&2
    exit 1
  fi
done

grep -q 'docs/tutorials/01-install-and-start.md' README.md || { echo "[public-docs] English README missing tutorial link" >&2; exit 1; }
grep -q 'docs/tutorials/01-install-and-start.zh-CN.md' README.zh-CN.md || { echo "[public-docs] Chinese README missing tutorial link" >&2; exit 1; }
grep -q "$README_CHANNEL_EN" README.md || { echo "[public-docs] English README must state the npm channel for $PACKAGE_VERSION" >&2; exit 1; }
grep -q "$README_CHANNEL_ZH" README.zh-CN.md || { echo "[public-docs] Chinese README must state the npm channel for $PACKAGE_VERSION" >&2; exit 1; }
grep -q 'See \[README.md\](README.md)' README.en.md || { echo "[public-docs] README.en.md must point to the maintained English README" >&2; exit 1; }

for path in docs/tutorials/01-install-and-start.md docs/tutorials/01-install-and-start.zh-CN.md; do
  grep -q 'Node.js 20.10' "$path" || { echo "[public-docs] missing Node baseline: $path" >&2; exit 1; }
  grep -q 'npm install -g \.' "$path" || { echo "[public-docs] missing source install: $path" >&2; exit 1; }
  grep -q "$INSTALL_SPEC" "$path" || { echo "[public-docs] missing package command for $PACKAGE_VERSION: $path" >&2; exit 1; }
done

for path in docs/operations/releasing.md docs/operations/releasing.zh-CN.md; do
  grep -q '@moretea-labs/forge' "$path" || { echo "[public-docs] missing package identity: $path" >&2; exit 1; }
  grep -q 'forge-hook' "$path" || { echo "[public-docs] missing Forge hook identity: $path" >&2; exit 1; }
  if grep -qE '(^|[^A-Za-z0-9_-])(matea|repo-harness)([^A-Za-z0-9_-]|$)' "$path"; then
    echo "[public-docs] forbidden legacy product identity remains: $path" >&2
    exit 1
  fi
  grep -q 'package.json' "$path" || { echo "[public-docs] release version must be derived from package.json: $path" >&2; exit 1; }
  grep -q 'next' "$path" || { echo "[public-docs] missing RC channel: $path" >&2; exit 1; }
  grep -q 'latest' "$path" || { echo "[public-docs] missing stable channel: $path" >&2; exit 1; }
  grep -q 'Bun' "$path" || { echo "[public-docs] missing Bun distribution role: $path" >&2; exit 1; }
  grep -q 'Homebrew' "$path" || { echo "[public-docs] missing Homebrew distribution role: $path" >&2; exit 1; }
done

grep -q 'npm.*primary package registry' docs/operations/releasing.md || { echo "[public-docs] npm primary registry role is unclear" >&2; exit 1; }
grep -q 'GitHub Releases' docs/operations/releasing.md || { echo "[public-docs] GitHub Release role is unclear" >&2; exit 1; }
grep -q 'publishConfig.provenance' docs/versioning.md || { echo "[public-docs] provenance contract is undocumented" >&2; exit 1; }
grep -q 'stable npm/GitHub release' docs/operations/homebrew.md || { echo "[public-docs] Homebrew stable-only gate is unclear" >&2; exit 1; }
grep -q 'WSL2' docs/operations/platform-support.md || { echo "[public-docs] platform matrix missing WSL2" >&2; exit 1; }
grep -q 'Windows 原生' docs/operations/platform-support.zh-CN.md || { echo "[public-docs] Chinese platform matrix missing native Windows scope" >&2; exit 1; }
grep -q 'rh_status' docs/tutorials/02-connect-chatgpt.md || { echo "[public-docs] connector tutorial missing facade verification" >&2; exit 1; }

grep -q '@moretea-labs/forge' install.sh || { echo "[public-docs] shell installer uses the wrong package identity" >&2; exit 1; }
grep -q '@moretea-labs/forge' install.ps1 || { echo "[public-docs] PowerShell installer uses the wrong package identity" >&2; exit 1; }
if grep -q 'PACKAGE_NAME="forge"' install.sh || grep -q '\$PackageName = "forge"' install.ps1; then
  echo "[public-docs] installer regressed to the unscoped package" >&2
  exit 1
fi

# Package identity, publish metadata, required package files, and the Forge-only
# bin surface are owned by one canonical checker. Reuse it here instead of an
# inline `node -` stdin program so this gate also works when `node` is provided
# by a Bun-compatible shim that does not interpret `-` as stdin JavaScript.
node scripts/check-package-identity.mjs

echo "[public-docs] OK"
