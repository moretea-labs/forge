#!/usr/bin/env bash
# Release-only checks. Main/type/focused evidence is owned by check:main.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "[release-readiness] version, identity, and notices"
node scripts/check-release-version.mjs
node scripts/check-package-identity.mjs
node scripts/check-third-party-notices.mjs

echo "[release-readiness] focused release contracts"
bun scripts/test-governance.ts affected \
  tests/release/release-version.test.ts \
  tests/release/package-release.test.ts \
  tests/skill-version.test.ts

echo "[release-readiness] public/package surfaces"
bash scripts/check-public-docs.sh
node scripts/check-platform-support.mjs
bash scripts/check-open-source-tracked-surface.sh
bun run check:public-export

ARTIFACT_DIR="${FORGE_RELEASE_ARTIFACT_DIR:-$ROOT/.ai/harness/artifacts/release}"
mkdir -p "$ARTIFACT_DIR"
PACK_JSON="$ARTIFACT_DIR/pack.json"
echo "[release-readiness] create one reusable tarball"
npm pack --json --pack-destination "$ARTIFACT_DIR" >"$PACK_JSON"
TARBALL="$(bun - "$PACK_JSON" <<'JS_EOF'
const [, , path] = process.argv;
const value = await Bun.file(path).json();
const entry = Array.isArray(value) ? value[0] : value;
if (!entry?.filename) throw new Error('npm pack did not report a filename');
console.log(entry.filename);
JS_EOF
)"
TARBALL_PATH="$ARTIFACT_DIR/$TARBALL"
printf '%s\n' "$TARBALL_PATH" >"$ARTIFACT_DIR/latest-tarball.txt"

echo "[release-readiness] smoke the same tarball"
bash scripts/check-tarball-install-smoke.sh "$TARBALL_PATH"
echo "[release-readiness] OK: $TARBALL_PATH"
