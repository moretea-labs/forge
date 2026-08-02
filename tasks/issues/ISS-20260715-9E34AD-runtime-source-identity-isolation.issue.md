---
id: "ISS-20260715-9E34AD"
kind: "bug"
status: "cancelled"
updated_at: "2026-08-02T05:46:55.626Z"
source: "repo-harness-controller-v8"
---

# Isolate Controller Runtime Source Identity from execution repositories

Superseded by ISS-20260802-539E7F:T2-T3. The original false-drift fix and tests remain valid historical evidence, but the target architecture removes mutable runtime-source identity from installed execution entirely by using self-contained immutable releases. No new implementation should extend runtime-source fallback, source/worktree coupling, or generation logic from this Issue.

## Goals

- Keep Runtime Source Identity controller-scoped and package/source-derived.
- Share one drift evaluation path across MCP, CLI, and Local Bridge.
- Preserve true runtime dirty/commit/root drift protection and fail-closed missing snapshots.

## Non-goals

- Do not change business project execution logic.
- Do not require runtime root to equal execution root.
- Do not delete genuine runtime dirty checks.

## Acceptance Criteria

- [ ] Execution repository selection does not set RUNTIME_SOURCE_SNAPSHOT_STALE.
- [ ] Session/repository switch does not rotate runtime generation.
- [ ] True runtime source change still blocks mutating readiness.
- [ ] Missing snapshot returns structured fail-closed error.
- [ ] Targeted isolation tests and typecheck pass.

## GitHub

- Not published.

## Tasks

### T1 — Runtime Source isolation fix

- Status: `integration_blocked`
- Objective: Introduce unique runtime source resolver; stop comparing execution repository roots; pin daemon/keepalive startup source; add targeted tests and architecture invariant.
- Depends on: none
- Allowed paths: `src/runtime/control-plane/**`, `src/runtime/gateway/mcp/**`, `src/cli/controller/**`, `src/cli/mcp/**`, `src/cli/local-bridge/**`, `tests/runtime/**`, `tests/cli/**`, `docs/**`, `tasks/**`
- Checks: `bun test tests/runtime/runtime-source-isolation.test.ts`, `bun run check:type`
- Execution hint: selected at runtime

## Related Artifacts

- `ISS-20260802-539E7F:T2`
- `ISS-20260802-539E7F:T3`
- `historical evidence: runtime-source-isolation fix and tests`
