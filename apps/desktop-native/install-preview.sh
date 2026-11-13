#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-install}"
case "$MODE" in
  install) ;;
  --build-only) ;;
  *) printf 'Usage: %s [--build-only]\n' "$0" >&2; exit 2 ;;
esac

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$ROOT"
SOURCE_REVISION="$(git rev-parse HEAD)"

if [[ "$MODE" == "--build-only" ]]; then
  if [[ -n "$(git status --porcelain)" ]]; then
    echo "Forge preview build-only requires a clean source checkout" >&2
    exit 1
  fi
  APP="$ROOT/apps/desktop-native/.build/review/Forge-preview-$SOURCE_REVISION.app"
  if [[ -e "$APP" ]]; then
    echo "Forge preview candidate already exists: $APP" >&2
    exit 1
  fi
else
  APP="$HOME/Applications/Forge.app"
fi

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/Forge-native-preview.XXXXXX")"
TMP="$TMP_ROOT/Forge.app"
trap 'rm -rf "$TMP_ROOT"' EXIT

swift test --package-path apps/desktop-native
swift build -c release --package-path apps/desktop-native
cargo build --release --manifest-path apps/desktop/src-tauri/Cargo.toml

mkdir -p "$TMP/Contents/MacOS" "$TMP/Contents/Resources"

cp apps/desktop-native/.build/out/Products/Release/ForgeNative "$TMP/Contents/MacOS/Forge"
cp apps/desktop/src-tauri/target/release/forge-desktop "$TMP/Contents/MacOS/forge-desktop"
cp apps/desktop/src-tauri/icons/icon.icns "$TMP/Contents/Resources/icon.icns"
cp apps/desktop/src-tauri/resources/forge-local-tool.mjs "$TMP/Contents/Resources/forge-local-tool.mjs"

cat > "$TMP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>zh_CN</string>
  <key>CFBundleDisplayName</key><string>Forge</string>
  <key>CFBundleExecutable</key><string>Forge</string>
  <key>CFBundleIconFile</key><string>icon.icns</string>
  <key>CFBundleIdentifier</key><string>com.moretea.forge.desktop</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>Forge</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>0.1.0</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSMicrophoneUsageDescription</key><string>用于将语音转写到 Forge Agent 消息草稿，不会自动发送。</string>
  <key>NSSpeechRecognitionUsageDescription</key><string>用于将语音转写到 Forge Agent 消息草稿，发送前可编辑。</string>
</dict>
</plist>
PLIST

# Embed provenance before signing so it is covered by the bundle signature.
plutil -insert ForgeSourceRevision -string "$SOURCE_REVISION" "$TMP/Contents/Info.plist"
EMBEDDED_SOURCE_REVISION="$(plutil -extract ForgeSourceRevision raw "$TMP/Contents/Info.plist")"
if [ "$EMBEDDED_SOURCE_REVISION" != "$SOURCE_REVISION" ]; then
  echo "Forge preview source revision metadata mismatch" >&2
  exit 1
fi

chmod +x "$TMP/Contents/MacOS/Forge" "$TMP/Contents/MacOS/forge-desktop"

# A stable signing identity is required for persistent macOS Keychain trusted-app
# ACLs. Prefer an explicit override, then a locally installed Developer ID
# Application identity. Fall back to ad-hoc only for machines without one;
# managed credentials then fail closed after a binary identity change instead of
# showing an interactive Keychain Allow prompt.
SIGN_IDENTITY="${FORGE_CODESIGN_IDENTITY:-}"
if [ -z "$SIGN_IDENTITY" ]; then
  SIGN_IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null     | sed -n 's/^[[:space:]]*[0-9][0-9]*) [0-9A-F]* "\(Developer ID Application:[^"]*\)".*/\1/p'     | head -1)"
fi
if [ -n "$SIGN_IDENTITY" ]; then
# Local-only preview: retain the stable Developer ID signing identity while
  # avoiding Apple online timestamp availability as an installation dependency.
  # Distribution / release packaging is a separate process with its own gates.
  codesign --force --timestamp=none --sign "$SIGN_IDENTITY" "$TMP/Contents/MacOS/Forge"
  codesign --force --timestamp=none --sign "$SIGN_IDENTITY" "$TMP/Contents/MacOS/forge-desktop"
  codesign --force --timestamp=none --sign "$SIGN_IDENTITY" "$TMP"
  echo "Forge local preview signed with stable identity (no online timestamp): $SIGN_IDENTITY"
else
  codesign --force --deep --sign - "$TMP"
  echo "Forge preview warning: no stable code-signing identity; managed Keychain credentials may require re-import after rebuild" >&2
fi
codesign --verify --deep --strict "$TMP"

if [[ "$MODE" == "--build-only" ]]; then
  if [[ "$(git rev-parse HEAD)" != "$SOURCE_REVISION" ]] || [[ -n "$(git status --porcelain)" ]]; then
    echo "Forge preview source changed during build; refusing to publish candidate" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$APP")"
  if [[ -e "$APP" ]]; then
    echo "Forge preview candidate appeared during build; refusing to overwrite: $APP" >&2
    exit 1
  fi
  mv "$TMP" "$APP"
  echo "Forge preview candidate built revision=$SOURCE_REVISION path=$APP"
  exit 0
fi

# Only retire client previews. Forge Runtime and Forge Desktop Operator are separate products.
pkill -f "^$APP/Contents/MacOS/Forge$" 2>/dev/null || true
pkill -f "^$APP/Contents/MacOS/forge-desktop$" 2>/dev/null || true
pkill -f "ForgeCSSStartupProbe\.app/Contents/MacOS/forge-desktop" 2>/dev/null || true
pkill -f "ForgeBootstrapProbe\.app/Contents/MacOS/forge-desktop" 2>/dev/null || true

rm -rf "$APP"
mkdir -p "$HOME/Applications"
mv "$TMP" "$APP"

rm -rf apps/desktop/src-tauri/target/release/bundle/macos/ForgeCSSStartupProbe.app
rm -rf apps/desktop/src-tauri/target/release/bundle/macos/ForgeBootstrapProbe.app

open "$APP"

# The installer is the canonical preview activation path. Verify that the old
# product process was retired and exactly one newly launched product exists.
PREVIEW_PIDS=""
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  PREVIEW_PIDS="$(pgrep -f "^$APP/Contents/MacOS/Forge$" 2>/dev/null || true)"
  PREVIEW_COUNT="$(printf '%s\n' "$PREVIEW_PIDS" | sed '/^$/d' | wc -l | tr -d ' ')"
  if [ "$PREVIEW_COUNT" = "1" ]; then
    echo "Forge preview installed revision=$SOURCE_REVISION pid=$PREVIEW_PIDS"
    exit 0
  fi
  sleep 0.25
done

echo "Forge preview activation failed: expected exactly one product process, found ${PREVIEW_COUNT:-0}" >&2
exit 1
