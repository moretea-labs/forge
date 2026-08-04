---
id: "ISS-20260803-810BB4"
kind: "bug"
status: "done"
updated_at: "2026-08-03T06:08:17.359Z"
source: "repo-harness-controller-v8"
---

# Prevent duplicate cross-session Recovery mutations

CONFIRMED P1 cross-session Recovery concurrency defect resolved and live-verified. Source single-flight/idempotency fix is commit 35eca0d with receipt REC-direct_edit-1c31274c8a26fbb8. Immutable Recovery publication/handoff is commits b2d86636 and 66bd0318; first candidate activation failed on compiled role detection and automatically restored exact legacy-4ddc87c3a0e076f4f4f87bdc, then the corrected exact 66bd0318 activation succeeded. Live Recovery Gateway PID 78615 and Watchdog PID 78836 match launchd/runtime identity and manifest; Primary remains exact healthy e5887ad at Supervisor PID 52634. A healthy restart request returned noOp=true, the identical request returned reused=true, a later different request was bounded, and Supervisor PID did not transition. T3 receipt REC-direct_edit-ef9fa06da062b0af; scoped no-change live-proof receipt REC-direct_edit-57e9c979c2c811e3. No remote push, tag, publish, or remote ref mutation occurred.

## Goals

- Make all mutating standalone Recovery actions share one controller-home global single-flight owner across sessions and processes.
- Persist request-id receipts so retries return the original bounded result instead of replaying effects.
- Make Supervisor restart a no-op once the local Supervisor/Gateway/Ingress managed runtime is healthy, regardless of external MCP session-close probe noise.
- Fence stale lock reclamation by live owner and instance identity; an old owner must never delete a replacement lock.

## Non-goals

- Do not redesign Supervisor operation ownership.
- Do not add a session-local mutex or depend on ChatGPT session identity.
- Do not weaken rollout, rollback, known-good, restart-budget, or authorization gates.
- Do not activate, restart, rollback, push, tag, or publish as part of the source commit.

## Acceptance Criteria

- [ ] Two concurrent Recovery callers produce at most one mutating execution; the other receives a bounded in-progress/reused outcome.
- [ ] Repeating the same request_id after completion returns the persisted result without another restart.
- [ ] A different request_id after the first recovery restored a healthy local runtime returns no-op and does not restart.
- [ ] A live lock owner is never reclaimed merely because the lock is old, and final cleanup removes only the caller's own instanceId.
- [ ] Focused standalone Recovery tests and typecheck pass; changes are committed by exact paths only.

## GitHub

- Not published.

## Tasks

### T1 — Fence standalone Recovery mutations across sessions

- Status: `done`
- Objective: Implement controller-home-global Recovery single-flight ownership, durable request receipts, healthy-state no-op for Stable Supervisor restart, identity-safe stale lock reclamation, and focused concurrency/idempotency regression coverage. Reuse the existing Supervisor operation authority for Gateway/rollback requests; do not create a parallel scheduler.
- Depends on: none
- Allowed paths: `src/runtime/standalone-recovery/core.ts`, `tests/runtime/standalone-recovery.test.ts`, `docs/architecture/current/runtime-architecture-simplification.md`, `docs/architecture/current/stable-external-runtime-supervisor.md`
- Checks: not defined
- Execution hint: agent / codex

### T2 — Activate and prove cross-session Recovery single-flight

- Status: `superseded`
- Objective: After the authoritative runtime workspace becomes exact-clean, activate a release containing commit 35eca0d563b1a6d560cae4fe0a044e84a22a001a through the formal Stable Supervisor flow. Independently verify Supervisor/Daemon/Gateway/Ingress/MCP release coherence, then exercise only safe no-op/idempotency probes proving same-request reuse, different-request healthy no-op, and bounded in-progress reporting without causing another restart wave.
- Depends on: `T1`
- Allowed paths: not defined
- Checks: not defined
- Execution hint: agent / codex

### T3 — Add immutable Recovery release handoff

- Status: `done`
- Objective: Replace the unsafe flat standalone-Recovery binary update path with staged immutable Recovery releases, atomic current/previous activation, identity-bearing manifests, and one bounded launchd handoff with verified rollback. Keep the existing Recovery Gateway and Watchdog as the only Recovery lifecycle owners; do not create another scheduler. After source integration, activate the exact release and unblock T2 for safe single-flight probes.
- Depends on: none
- Allowed paths: `scripts/install-standalone-recovery.ts`, `scripts/load-standalone-recovery.sh`, `src/runtime/standalone-recovery/**`, `tests/runtime/standalone-recovery.test.ts`, `tests/runtime/stable-supervisor-hardening.test.ts`, `docs/operations/standalone-disaster-recovery.md`, `docs/architecture/current/runtime-architecture-simplification.md`
- Checks: not defined
- Execution hint: agent / codex

### T4 — Reconcile live Recovery activation proof

- Status: `done`
- Objective: Record and accept the already-completed Primary and immutable Recovery activation evidence without performing another restart, rollout, rollback, or source mutation. Bind the proof to the explicit Controller Home runtime-state scope and a no-change delivery receipt.
- Depends on: `T1`, `T3`
- Allowed paths: `_ops/controller-home/recovery/**`, `_ops/controller-home/supervisor/**`
- Checks: not defined
- Execution hint: agent / codex

## Related Artifacts

- `35eca0d563b1a6d560cae4fe0a044e84a22a001a`
- `b2d866361991237a7096be19c0488014e40eaa04`
- `66bd03183593f2006f8cfde4648018a10fa09ed6`
- `e5887ad58686844496e336840efa703cd3ab9c80`
- `REC-direct_edit-1c31274c8a26fbb8`
- `REC-direct_edit-ef9fa06da062b0af`
- `REC-direct_edit-57e9c979c2c811e3`
