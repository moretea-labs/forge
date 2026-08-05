#!/usr/bin/env bash

repo_harness_default_controller_home() {
  local repo_root="${1:?repo root is required}"
  printf '%s\n' "$repo_root/_ops/controller-home"
}

repo_harness_use_local_controller_home() {
  local repo_root="${1:?repo root is required}"
  if [[ -z "${REPO_HARNESS_CONTROLLER_HOME:-}" ]]; then
    export REPO_HARNESS_CONTROLLER_HOME
    REPO_HARNESS_CONTROLLER_HOME="$(repo_harness_default_controller_home "$repo_root")"
  fi
  mkdir -p "$REPO_HARNESS_CONTROLLER_HOME"
}

repo_harness_prepare_runtime_path() {
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

repo_harness_resolve_bun() {
  local candidate

  if [[ -n "${REPO_HARNESS_BUN_BIN:-}" && -x "$REPO_HARNESS_BUN_BIN" ]]; then
    printf '%s\n' "$REPO_HARNESS_BUN_BIN"
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

# A byte-for-byte executable copy of scripts/controller-runtime.sh named
# activate-source-baseline.command enters the audited source-baseline path here.
# Keeping the dispatch in this sourced library preserves the executable mode of
# the copied shell script; normal controller-runtime.sh invocations are unchanged.
if [[ "$(basename "$0")" == "activate-source-baseline.command" ]]; then
  repo_harness_use_local_controller_home "${ROOT:?repo root is required}"
  repo_harness_prepare_runtime_path
  _repo_harness_source_bun="$(repo_harness_resolve_bun || true)"
  if [[ -z "$_repo_harness_source_bun" ]]; then
    echo "Bun is required to activate the source Runtime baseline." >&2
    exit 127
  fi
  exec "$_repo_harness_source_bun" "$ROOT/scripts/activate-source-baseline.ts" request --repo "$ROOT"
fi
