#!/usr/bin/env bash
# Install the one Controller-owned physical-iPhone HID Python toolchain.
# Execute only with an authorized ForgeInstance host process:exec grant.
set -euo pipefail

if [[ $# -ne 1 || ! -d "$1" ]]; then
  echo "Usage: $0 <existing-controller-home>" >&2
  exit 2
fi
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "The CoreDevice HID toolchain requires macOS." >&2
  exit 2
fi

repo_root="$(cd "$(dirname "$0")/.." && pwd -P)"
controller_home="$(cd "$1" && pwd -P)"
version="11.24.0"
# The provider source is the sole runtime version authority. Refuse a stale installer.
if ! grep -Fq "export const IOS_HID_TOOLCHAIN_VERSION = '$version';" \
  "$repo_root/src/runtime/plugins/ios/remote-xpc-hid.ts"; then
  echo "Installer version no longer matches the RemoteXPC provider pin." >&2
  exit 2
fi

toolchains="$controller_home/toolchains"
mkdir -p "$toolchains"
target="$toolchains/pymobiledevice3-$version"
lock="$toolchains/.pymobiledevice3-$version-install.lock"
if ! mkdir "$lock" 2>/dev/null; then
  echo "The pinned HID toolchain is already being installed; no parallel writer." >&2
  exit 1
fi

created=false
completed=false
cleanup() {
  if [[ "$created" == true && "$completed" != true ]]; then
    rm -rf -- "$target"
  fi
  rmdir "$lock" 2>/dev/null || true
}
trap cleanup EXIT

verify() {
  "$1" -c "from importlib.metadata import version; from pymobiledevice3.remote.remote_service_discovery import RemoteServiceDiscoveryService; from pymobiledevice3.remote.core_device.pasteboard_service import PasteboardService; from pymobiledevice3.remote.core_device.hid_service import UniversalHIDServiceService, touch_session; actual=version('pymobiledevice3'); assert actual == '$version', (actual, '$version'); print('pymobiledevice3 ' + actual + ' verified')"
}

if [[ -e "$target" ]]; then
  verify "$target/bin/python"
  completed=true
  exit 0
fi

# A newly created target is owned by this invocation. Never alter an old toolchain.
created=true
python3 -m venv "$target"
"$target/bin/python" -m pip install --disable-pip-version-check --no-input "pymobiledevice3==$version"
verify "$target/bin/python"
completed=true
printf 'Installed Controller-owned HID toolchain: %s\n' "$target"
