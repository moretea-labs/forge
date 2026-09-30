#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
install_dir="${FORGE_V3_CLIENT_HOME:-$HOME/.local/share/forge-v3-client}"
port="4318"
launch=0

while (($#)); do
  case "$1" in
    --install-dir) install_dir="$2"; shift 2 ;;
    --port) port="$2"; shift 2 ;;
    --launch) launch=1; shift ;;
    *) echo "usage: $0 [--install-dir PATH] [--port PORT] [--launch]" >&2; exit 2 ;;
  esac
done

if [[ ! -f "$repo_root/apps/desktop/dist/index.html" ]]; then
  (cd "$repo_root" && bun run build:v3-client)
fi

mkdir -p "$install_dir"
rm -rf "$install_dir/assets"
cp "$repo_root/apps/desktop/dist/index.html" "$install_dir/index.html"
cp -R "$repo_root/apps/desktop/dist/assets" "$install_dir/assets"
printf 'Forge V3 client installed at %s\n' "$install_dir"

if ((launch)); then
  cd "$install_dir"
  printf 'Forge V3 client running at http://127.0.0.1:%s/\n' "$port"
  exec python3 -m http.server "$port" --bind 127.0.0.1
fi
