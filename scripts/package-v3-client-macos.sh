#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
signing_identity="${FORGE_MACOS_SIGNING_IDENTITY:-}"
if [[ -z "$signing_identity" ]]; then
  echo 'FORGE_MACOS_SIGNING_IDENTITY is required for a signed macOS package.' >&2
  exit 2
fi

tauri_dir="$repo_root/apps/desktop/src-tauri"
bundle_root="$tauri_dir/target/release/bundle"
app_path="$bundle_root/macos/Forge V3.app"
dmg_path="$bundle_root/dmg/Forge V3_0.1.0_aarch64.dmg"

(cd "$tauri_dir" && bunx --bun @tauri-apps/cli@2.12.0 build --bundles app)
codesign --force --deep --options runtime --timestamp --sign "$signing_identity" "$app_path"
codesign --verify --deep --strict --verbose=2 "$app_path"

mkdir -p "$(dirname "$dmg_path")"
if [[ -e "$dmg_path" ]]; then
  echo "Refusing to overwrite existing package: $dmg_path" >&2
  exit 3
fi

staging_dir="$(mktemp -d /tmp/forge-v3-macos.XXXXXX)"
trap 'rm -rf -- "$staging_dir"' EXIT
cp -R "$app_path" "$staging_dir/"
hdiutil create -srcfolder "$staging_dir" -volname 'Forge V3' -format UDZO "$dmg_path"
hdiutil verify "$dmg_path"
printf 'Signed macOS package created at %s\n' "$dmg_path"
