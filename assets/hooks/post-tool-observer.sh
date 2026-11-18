#!/bin/bash
# Post-Tool Observer — PostToolUse (all tools)
# Single pass per tool call: JSONL trace logging plus lightweight advisories.
# Replaces the former split observers so the always-route costs one dispatch,
# one stdin parse, and one library load instead of two.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/hook-input.sh"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/lib/session-state.sh"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/lib/workflow-state.sh"

mkdir -p .claude

TRACE_FILE="$(workflow_trace_file)"
SESSION_ID_FILE=".claude/.session-id"

# --- Batch field extraction: one jq call instead of one per field ---
# Seeding HOOK_SESSION_ID before session_state_resolve_key avoids a second jq
# call inside hook_get_session_id. HOOK_STDIN_JSON was already read by
# hook-input.sh (hook_read_stdin_once at the bottom of that file).
event_type=""
tool_name=""
file_path=""
exit_code=""
duration_ms=""
run_id=""
session_source=""
_session_id_raw=""

if [[ -n "${HOOK_STDIN_JSON:-}" ]] && command -v jq >/dev/null 2>&1; then
  _jq_batch="$(printf '%s' "$HOOK_STDIN_JSON" | jq -r '
    (.hook_event_name // "PostToolUse"),
    (.tool_name // .hook_event_name // ""),
    (.file_path // .tool_input.file_path // .trigger_file_path // .parent_file_path // ""),
    ((.tool_response.exit_code // .exit_code // 0) | tostring),
    ((.duration_ms // .tool_response.duration_ms // 0) | tostring),
    (.session_id // ""),
    (.run_id // .tool_input.run_id // ""),
    (.source // "")
  ' 2>/dev/null)" || _jq_batch=""
  if [[ -n "$_jq_batch" ]]; then
    HOOK_STDIN_JSON_VALID="1"
    export HOOK_STDIN_JSON_VALID
    {
      IFS= read -r event_type || true
      IFS= read -r tool_name || true
      IFS= read -r file_path || true
      IFS= read -r exit_code || true
      IFS= read -r duration_ms || true
      IFS= read -r _session_id_raw || true
      IFS= read -r run_id || true
      IFS= read -r session_source || true
    } <<< "$_jq_batch"
    [[ -n "$_session_id_raw" ]] && { HOOK_SESSION_ID="$_session_id_raw"; export HOOK_SESSION_ID; }
    [[ -n "$run_id" ]] && { HOOK_RUN_ID="$run_id"; export HOOK_RUN_ID; }
    file_path="$(hook_normalize_file_path "$file_path")"
  fi
fi

SESSION_KEY="$(session_state_resolve_key "$SESSION_ID_FILE" "${1:-}")"

# --- Trace logging ---

# Fallbacks for empty fields (non-JSON stdin or failed parse)
[[ -z "$event_type" ]]     && event_type="$(hook_json_get '.hook_event_name' 'PostToolUse')"
[[ -z "$tool_name" ]]      && tool_name="$(hook_get_tool_name "${1:-}")"
[[ -z "$file_path" ]]      && file_path="$(hook_get_file_path "${1:-}")"
[[ -z "$exit_code" ]]      && exit_code="$(hook_get_exit_code "${1:-}")"
[[ -z "$duration_ms" ]]    && duration_ms="$(hook_get_duration_ms "${1:-}")"
[[ -z "$run_id" ]]         && run_id="$(hook_get_run_id "${1:-}")"
[[ -z "$session_source" ]] && session_source="$(hook_get_session_source "${1:-}")"

agent_name="${CLAUDE_AGENT_NAME:-${CODEX_AGENT_NAME:-${HOOK_AGENT_NAME:-unknown}}}"
session_source="${session_source:-${CODEX_SESSION_SOURCE:-}}"
host="unknown"

tool_name="${tool_name:-unknown}"
file_path="${file_path:-}"
exit_code="${exit_code:-0}"
duration_ms="${duration_ms:-0}"
run_id="${run_id:-unknown}"
session_source="${session_source:-unknown}"


# An event source is explicit evidence. Inherited host variables are only a
# fallback for payloads that omit it, such as local compatibility shims.
if [[ "$session_source" =~ [Cc]odex ]]; then
  host="codex"
elif [[ "$session_source" =~ [Cc]laude ]]; then
  host="claude"
elif [[ -n "${CODEX_SESSION_ID:-${CODEX_AGENT_NAME:-}}" ]]; then
  host="codex"
elif [[ -n "${CLAUDE_SESSION_ID:-${CLAUDE_AGENT_NAME:-}}" ]]; then
  host="claude"
fi

# Rotate trace log when it exceeds MAX_TRACE_LINES.
# Skip the O(N) line count only while the log is too small to exceed MAX_TRACE_LINES.
MAX_TRACE_LINES=10000
KEEP_TRACE_LINES=5000
if [[ -f "$TRACE_FILE" ]]; then
  if ! _fsize="$(stat -f '%z' "$TRACE_FILE" 2>/dev/null)"; then
    _fsize="$(stat -c '%s' "$TRACE_FILE" 2>/dev/null)" || _fsize=""
  fi
  if [[ ! "$_fsize" =~ ^[0-9]+$ || "$_fsize" -gt "$MAX_TRACE_LINES" ]]; then
    line_count="$(wc -l < "$TRACE_FILE" | tr -d ' ')"
    if [[ "$line_count" -gt "$MAX_TRACE_LINES" ]]; then
      tmp_trace="$(mktemp)"
      tail -n "$KEEP_TRACE_LINES" "$TRACE_FILE" > "$tmp_trace"
      mv "$tmp_trace" "$TRACE_FILE"
    fi
  fi
fi

# The trace file is the single tool-trace record; handoff "Commands Run"
# reads it directly instead of a duplicate events.jsonl append per call.
printf '{"ts":"%s","event_type":"%s","tool_name":"%s","file_path":"%s","exit_code":%s,"duration_ms":%s,"session_key":"%s","run_id":"%s","host":"%s","agent_name":"%s","session_source":"%s"}\n' \
  "$(hook_json_escape "$(date '+%Y-%m-%dT%H:%M:%S%z')")" \
  "$(hook_json_escape "$event_type")" \
  "$(hook_json_escape "$tool_name")" \
  "$(hook_json_escape "$file_path")" \
  "$exit_code" \
  "$duration_ms" \
  "$(hook_json_escape "$SESSION_KEY")" \
  "$(hook_json_escape "$run_id")" \
  "$(hook_json_escape "$host")" \
  "$(hook_json_escape "$agent_name")" \
  "$(hook_json_escape "$session_source")" \
  >> "$TRACE_FILE"

# --- Codex plan-change advisory ---

emit_codex_plan_change_guard() {
  local changed_plan

  if [[ "$tool_name" != "apply_patch" ]]; then
    return 0
  fi

  changed_plan="$(has_changes_glob '^plans/plan-.*\.md$' || true)"
  if [[ -n "$changed_plan" ]]; then
    echo "[AnnotationGuard] ${changed_plan} has annotations. Process all notes and revise. Do not implement yet."
  fi
}

emit_codex_plan_change_guard
