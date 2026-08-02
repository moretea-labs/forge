---
id: "ISS-20260802-C31FEE"
kind: "bug"
status: "cancelled"
updated_at: "2026-08-02T05:47:49.767Z"
source: "repo-harness-controller-v8"
---

# Restore immutable release execution and converge ChatGPT tool surface

Partially completed and then superseded by ISS-20260802-539E7F. T1 permanently fixed and verified immutable release closure/process execution. T2 produced reusable Core facade code and tests, but its live activation path depended on the old slot-local configuration and argv override lifecycle; that cutover is intentionally not completed. The new architecture owns one-config activation and legacy-path deletion. Preserve commits and evidence; do not resume old rollout logic.

## Goals

- Identify and fix the causal path that produced or activated a release without process-runner.js.
- Make release creation, publish, readiness, activation, rollback and command execution fail closed with end-to-end evidence.
- Integrate the existing runtime-observability changes without losing or overwriting user work.
- Restore repository_command_execute and validate checks, Git workflow, rollout and rollback on the exact release.
- Reduce the default ChatGPT-facing surface to the five rh_* facades plus a bounded discovery/escape hatch instead of exposing all atomic tools.

## Non-goals

- Do not push or publish remotely.
- Do not modify unrelated iOS, browser or product work.
- Do not hide execution failures behind cmux configuration or Connector reconnects.
- Do not delete existing dirty work before it is preserved and reviewed.

## Acceptance Criteria

- [ ] A clean immutable candidate contains every declared release entrypoint including non-empty process-runner.js with manifest digest.
- [ ] The exact candidate passes an end-to-end process canary through the same runtime lookup and spawn path used by repository_command_execute.
- [ ] Publish, readiness, activation and rollback reject incomplete releases before traffic switches.
- [ ] The branch is rebased or replayed onto current main without losing existing changes, all focused and declared checks pass, and the exact revision is merged and activated.
- [ ] Post-activation repository_command_execute runs git rev-parse and at least one governed check successfully.
- [ ] Default ChatGPT orchestration uses a materially smaller tool surface; atomic handlers remain available through bounded discovery or an advanced compatibility mode.
- [ ] Temporary branches/worktrees/releases created for this work are cleaned after verification.

## GitHub

- Not published.

## Tasks

### T1 — Close immutable release execution gap

- Status: `done`
- Objective: Preserve and review the existing runtime-observability diff, identify the actual release-build/activation path that omitted process-runner.js, implement causal fixes and release-closure/readiness/rollback/canary coverage, validate on a clean exact revision, merge, activate and prove repository command execution.
- Depends on: none
- Allowed paths: `src/runtime/supervisor/**`, `src/runtime/execution/process-runtime/**`, `src/runtime/gateway/**`, `src/runtime/health/**`, `src/runtime/recovery/**`, `src/runtime/standalone-recovery/**`, `src/cli/**`, `scripts/**`, `tests/runtime/**`, `tests/cli/**`, `tests/test-manifest.v1.json`, `package.json`, `tasks/notes/**`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:mcp-compatibility`, `package:check:controller-v8`, `package:check:ci`
- Execution hint: selected at runtime

### T2 — Physically converge the ChatGPT tool surface

- Status: `superseded`
- Objective: After execution recovery, change the default Connector profile from the current 133-tool static surface to a bounded facade-first surface with discovery/advanced compatibility, retain internal typed handlers, add schema/freshness tests, and reconnect only if the exposed schema actually changes.
- Depends on: `T1`
- Allowed paths: `src/cli/mcp/**`, `src/runtime/gateway/mcp/**`, `src/runtime/tooling/**`, `tests/cli/**`, `tests/runtime/**`, `docs/**`, `package.json`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:mcp-compatibility`, `package:check:controller-v8`, `package:check:ci`
- Execution hint: selected at runtime

### T3 — Bootstrap exact runtime validation

- Status: `cancelled`
- Objective: Validate exact clean main bdf5aa84cc56f9c408b5c2f32d0fa834a11e440e through the formal Worker lane without modifying repository or runtime state. Confirm exact HEAD and cleanliness, run bun run check:type and bun test tests/runtime/runtime-observability.test.ts, then identify the exact supported Supervisor command sequence to stage an immutable candidate from this revision and activate it through blue-green rollout. Do not execute staging, publication, restart, rollout, rollback, Connector reconnect, Git writes, or source edits.
- Depends on: none
- Allowed paths: not defined
- Checks: not defined
- Execution hint: agent / codex

## Related Artifacts

- `T1 verified at d4ff6727040f50ae642869e1805115c00caebe27`
- `Core implementation commits 5351e340 and d38c776b`
- `ISS-20260802-539E7F:T3`
- `ISS-20260802-539E7F:T7`
