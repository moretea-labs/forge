#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
APP="$HOME/Applications/Forge.app"
TMP="/tmp/Forge-native-preview.app"

cd "$ROOT"

swift test --package-path apps/desktop-native
swift build -c release --package-path apps/desktop-native
cargo build --release --manifest-path apps/desktop/src-tauri/Cargo.toml

rm -rf "$TMP"
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
</dict>
</plist>
PLIST

chmod +x "$TMP/Contents/MacOS/Forge" "$TMP/Contents/MacOS/forge-desktop"
codesign --force --deep --sign - "$TMP"
codesign --verify --deep --strict "$TMP"

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
