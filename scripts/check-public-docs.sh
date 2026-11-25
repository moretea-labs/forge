#!/usr/bin/env bash
# shellcheck disable=SC2016
# Literal Markdown code spans and regexes below intentionally contain backticks.
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
  docs/README.md docs/README.zh-CN.md
  docs/site/build-pages.py
  docs/wiki/Quick-Start.md docs/wiki/Installation.md
  docs/wiki/Connecting-ChatGPT.md docs/wiki/Connecting-ChatGPT.zh-CN.md
  docs/wiki/Execution-Lifecycle.md docs/wiki/Core-Concepts.md
  docs/wiki/Home.md docs/wiki/Architecture.md docs/wiki/Implementation.md docs/wiki/Operations.md
  docs/wiki/Computer-and-Plugins.md docs/wiki/Computer-and-Plugins.zh-CN.md
  docs/wiki/Integrations.md docs/wiki/Runtime-Architecture.md
  docs/wiki/Security-Model.md docs/wiki/Troubleshooting.md docs/wiki/Releases-and-Upgrades.md
)
for path in "${required[@]}"; do
  [[ -f "$path" ]] || {
    echo "[public-docs] missing: $path" >&2
    exit 1
  }
done

if git grep -n -E 'controller_capabilities and project_snapshot|Start repository work with controller_capabilities|20260612-legacy-research-notes|github[.]com/greyson[O]uyang/' -- README*.md docs >/dev/null; then
  echo "[public-docs] stale onboarding, personal repository URL, or removed legacy reference found" >&2
  exit 1
fi

for path in README.md README.zh-CN.md; do
  lines="$(wc -l <"$path" | tr -d ' ')"
  [[ "$lines" -le 150 ]] || {
    echo "[public-docs] primary README is too long: $path ($lines lines)" >&2
    exit 1
  }
  if [[ "$path" == "README.md" ]]; then
    grep -q 'docs/images/forge-banner.svg' "$path" || {
      echo "[public-docs] missing English Forge banner: $path" >&2
      exit 1
    }
  else
    grep -q 'docs/images/forge-banner-cn.svg' "$path" || {
      echo "[public-docs] missing Chinese Forge banner: $path" >&2
      exit 1
    }
  fi
  grep -q 'Node.js 20.10' "$path" || {
    echo "[public-docs] missing Node baseline: $path" >&2
    exit 1
  }
  grep -q 'npm install -g \.' "$path" || {
    echo "[public-docs] missing verified source install: $path" >&2
    exit 1
  }
  grep -q "$INSTALL_SPEC" "$path" || {
    echo "[public-docs] missing package install reference for $PACKAGE_VERSION: $path" >&2
    exit 1
  }
  for link in SUPPORT.md SECURITY.md CONTRIBUTING.md CHANGELOG.md docs/wiki/Home.md; do
    grep -q "$link" "$path" || {
      echo "[public-docs] missing $link link: $path" >&2
      exit 1
    }
  done
  if grep -qE '^```mermaid|Repo Actor|Global Scheduler|Evidence Plane|Controller Home|schema `10`|WorkContract|Process Record|resource claims' "$path"; then
    echo "[public-docs] architecture internals belong in docs/Wiki, not $path" >&2
    exit 1
  fi
done

grep -q 'https://moretea-labs.github.io/forge/Installation.html' README.md || {
  echo "[public-docs] English README missing tutorial link" >&2
  exit 1
}
grep -q 'https://moretea-labs.github.io/forge/Installation.html' README.zh-CN.md || {
  echo "[public-docs] Chinese README missing tutorial link" >&2
  exit 1
}
grep -q "$README_CHANNEL_EN" README.md || {
  echo "[public-docs] English README must state the npm channel for $PACKAGE_VERSION" >&2
  exit 1
}
grep -q "$README_CHANNEL_ZH" README.zh-CN.md || {
  echo "[public-docs] Chinese README must state the npm channel for $PACKAGE_VERSION" >&2
  exit 1
}
grep -q 'See \[README.md\](README.md)' README.en.md || {
  echo "[public-docs] README.en.md must point to the maintained English README" >&2
  exit 1
}

source_install_docs=(
  README.md README.zh-CN.md
  docs/wiki/Quick-Start.md docs/wiki/Installation.md
)
for path in "${source_install_docs[@]}"; do
  grep -q 'bun install --frozen-lockfile' "$path" || {
    echo "[public-docs] source checkout must use the CI-authoritative Bun frozen lock: $path" >&2
    exit 1
  }
  grep -q 'npm install -g \.' "$path" || {
    echo "[public-docs] missing source package install: $path" >&2
    exit 1
  }
done
if git grep -n 'npm ci --ignore-scripts --no-audit --no-fund' -- "${source_install_docs[@]}" >/dev/null; then
  echo "[public-docs] generic npm ci must not be advertised for Forge source checkouts" >&2
  exit 1
fi

for path in docs/wiki/Quick-Start.md docs/wiki/Installation.md; do
  grep -q 'Node.js 20.10' "$path" || {
    echo "[public-docs] missing Node baseline: $path" >&2
    exit 1
  }
  grep -q "$INSTALL_SPEC" "$path" || {
    echo "[public-docs] missing package command for $PACKAGE_VERSION: $path" >&2
    exit 1
  }
done

for token in '@moretea-labs/forge' 'next' 'latest' 'GitHub Release'; do
  grep -q "$token" docs/wiki/Releases-and-Upgrades.md || {
    echo "[public-docs] release page missing: $token" >&2
    exit 1
  }
done
grep -q 'rh_status' docs/wiki/Connecting-ChatGPT.md || {
  echo "[public-docs] connector tutorial missing facade verification" >&2
  exit 1
}

grep -q '@moretea-labs/forge' install.sh || {
  echo "[public-docs] shell installer uses the wrong package identity" >&2
  exit 1
}
grep -q '@moretea-labs/forge' install.ps1 || {
  echo "[public-docs] PowerShell installer uses the wrong package identity" >&2
  exit 1
}
if grep -q 'PACKAGE_NAME="forge"' install.sh || grep -q '\$PackageName = "forge"' install.ps1; then
  echo "[public-docs] installer regressed to the unscoped package" >&2
  exit 1
fi

# Package identity, publish metadata, required package files, and the Forge-only
# bin surface are owned by one canonical checker. Reuse it here instead of an
# inline `node -` stdin program so this gate also works when `node` is provided
# by a Bun-compatible shim that does not interpret `-` as stdin JavaScript.
node scripts/check-package-identity.mjs

# Pages, not a second public tutorial catalog, owns all user-facing links.
PAGES_CHECK_OUTPUT="$(mktemp -d)"
trap 'rm -rf "$PAGES_CHECK_OUTPUT"' EXIT
python3 docs/site/build-pages.py --output "$PAGES_CHECK_OUTPUT"

echo "[public-docs] OK"
