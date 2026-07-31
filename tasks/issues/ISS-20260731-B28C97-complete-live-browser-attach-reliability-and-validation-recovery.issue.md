---
id: "ISS-20260731-B28C97"
kind: "bug"
status: "done"
updated_at: "2026-07-31T02:03:28.448Z"
source: "repo-harness-controller-v8"
---

# Complete live Browser Attach reliability and validation recovery

Finish the incomplete Browser Attach work by repairing the Node CDP bridge early-exit failure and the Work validation lifecycle inconsistency, then prove live Chrome attach, existing-tab reuse, login-state reuse, restart recovery, stale endpoint handling, and safe disconnect semantics on the exact integrated runtime.

## Goals

- Repair PLUGIN_BROWSER_NODE_EXITED with bounded redacted diagnostics
- Repair validation state convergence where running checks are marked failed and Work remains stuck validating
- Complete focused, type, runtime architecture, controller-v8, and live Chrome CDP tests
- Integrate to main and clean temporary branch/worktree

## Non-goals

- Do not weaken loopback-only CDP endpoint validation
- Do not expose cookies, storage, credentials, or page bodies in diagnostics
- Do not close the user's attached browser
- Do not switch the whole Controller runtime from Bun to Node

## Acceptance Criteria

- [ ] Node bridge returns a valid response before exit and emits bounded redacted phase diagnostics on failure
- [ ] work_validate does not mark a still-running check failed and terminal Work can be resumed by work_id
- [ ] Existing Chrome tab is discovered and reused without duplicate creation
- [ ] Attached Chrome remains running after plugin disconnect
- [ ] Session metadata survives Gateway/plugin restart and rebinds deterministically
- [ ] Stale endpoint behavior is proven for both managed fallback and fail-closed
- [ ] All declared checks pass on the exact merged commit
- [ ] Managed worktree and temporary branch are removed after integration

## GitHub

- Not published.

## Tasks

### T1 — Repair Browser Node CDP bridge and live attach proof

- Status: `done`
- Objective: Inspect the exact merged browser Node bridge implementation and release layout, reproduce PLUGIN_BROWSER_NODE_EXITED, fix the first causal bootstrap/import/protocol/packaging defect, add bounded redacted phase diagnostics and focused regressions, then prove live loopback Chrome attach, existing-tab reuse, login-state reuse, disconnect safety, restart rebind, and stale endpoint fallback/fail-closed behavior.
- Depends on: none
- Allowed paths: `src/runtime/plugins/**`, `tests/runtime/browser-plugin.test.ts`, `scripts/**`, `docs/operations/controller-browser-plugin.md`, `docs/architecture/current/human-interaction-plane.md`, `package.json`, `tasks/issues/**`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:controller-v8`
- Execution hint: agent / codex

### T2 — Repair Work validation lifecycle convergence

- Status: `done`
- Objective: Reproduce and fix the Controller defect where work_validate marks finalization failed while a check process is still running, leaves Work stuck validating, and may make the Work unavailable through work_wait/work_get. Preserve durable idempotency and do not fabricate successful validation. Add focused lifecycle/recovery tests.
- Depends on: none
- Allowed paths: `src/runtime/control-plane/**`, `src/runtime/execution/**`, `src/runtime/gateway/mcp/**`, `src/cli/mcp/**`, `tests/runtime/**`, `tests/cli/**`, `docs/architecture/current/**`, `tasks/issues/**`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:controller-v8`
- Execution hint: agent / codex

## Related Artifacts

- None.
