#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CHANNEL="${1:-latest}"
NPM_RELEASE_REGISTRY="${NPM_RELEASE_REGISTRY:-https://registry.npmjs.org/}"
if [[ "$CHANNEL" != "latest" && "$CHANNEL" != "next" ]]; then
  echo "usage: $0 latest|next" >&2
  exit 2
fi

node scripts/check-release-version.mjs --channel "$CHANNEL" --require-tag
bash scripts/check-npm-release.sh
TARBALL_PATH="$(cat .ai/harness/artifacts/release/latest-tarball.txt)"
if [[ ! -f "$TARBALL_PATH" ]]; then
  echo "[release] reusable tarball missing: $TARBALL_PATH" >&2
  exit 1
fi
echo "[release] publish registry: ${NPM_RELEASE_REGISTRY}"
if [[ "${NPM_RELEASE_BOOTSTRAP:-0}" == "1" ]]; then
  echo "[release] bootstrap publication: disabling provenance for this one-time local publish"
  npm publish "$TARBALL_PATH" --tag "$CHANNEL" --access public --registry "$NPM_RELEASE_REGISTRY" --provenance=false
else
  npm publish "$TARBALL_PATH" --tag "$CHANNEL" --access public --registry "$NPM_RELEASE_REGISTRY"
fi
