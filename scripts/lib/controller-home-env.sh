#!/usr/bin/env bash

forge_default_controller_home() {
  local repo_root="${1:?repo root is required}"
  printf '%s\n' "$repo_root/_ops/controller-home"
}

forge_use_local_controller_home() {
  local repo_root="${1:?repo root is required}"
  if [[ -z "${FORGE_CONTROLLER_HOME:-}" ]]; then
    export FORGE_CONTROLLER_HOME
    FORGE_CONTROLLER_HOME="$(forge_default_controller_home "$repo_root")"
  fi
  mkdir -p "$FORGE_CONTROLLER_HOME"
}

forge_prepare_runtime_path() {
  local merged="${PATH:-}"
  local candidate

  for candidate in \
    "${HOME:-}/.bun/bin" \
    "${HOME:-}/.volta/bin" \
    "${NVM_BIN:-}" \
    "${HOME:-}/.local/share/mise/shims" \
    "${HOME:-}/.asdf/shims" \
    "${HOME:-}/.local/bin" \
    "/opt/homebrew/bin" \
    "/usr/local/bin" \
    "/usr/bin" \
    "/bin" \
    "/usr/sbin" \
    "/sbin"; do
    [[ -n "$candidate" && -d "$candidate" ]] || continue
    case ":${merged}:" in
      *":${candidate}:"*) ;;
      *) merged="${merged:+${merged}:}${candidate}" ;;
    esac
  done

  export PATH="$merged"
}

forge_resolve_bun() {
  local candidate

  if [[ -n "${FORGE_BUN_BIN:-}" && -x "$FORGE_BUN_BIN" ]]; then
    printf '%s\n' "$FORGE_BUN_BIN"
    return 0
  fi

  if command -v bun >/dev/null 2>&1; then
    command -v bun
    return 0
  fi

  for candidate in \
    "${HOME:-}/.bun/bin/bun" \
    "/opt/homebrew/bin/bun" \
    "/usr/local/bin/bun"; do
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  return 1
}

