---
id: "ISS-20260731-B66A97"
kind: "bug"
status: "in_progress"
updated_at: "2026-07-31T06:28:10.888Z"
source: "repo-harness-controller-v8"
---

# Enforce checkout route integrity and fail-closed execution identity

Fix the core trusted-execution defect where an explicitly selected checkout can lose identity across MCP, Work, Local Bridge, Process Runtime, resume, or recovery layers and execute against another checkout. Make WorkHandle authoritative for Work-bound execution, preserve immutable resolved execution identity through all layers, add a final pre-spawn route guard, stop new managed worktrees from being nested inside registered source repositories, and bind leases/evidence to checkout identity.

## Goals

- Make WorkHandle the sole execution identity authority for work_id-bound operations.
- Preserve repoId and checkoutId after initial selection instead of deleting and re-resolving them.
- Add a unified fail-closed ExecutionIdentityGuard immediately before process spawn and equivalent mutation entrypoints.
- Persist and cross-check repository, checkout, worktree path, branch, HEAD, Git top-level, and Git common directory identity.
- Move allocation of new managed worktrees to stable controller storage outside every registered source repository while preserving legacy worktree recovery.
- Bind Process Runtime resource claims and leases to repoId, checkoutId, and workId.
- Cover nested repositories, session/registry drift, restart/resume, symlinks, duplicate names, missing checkouts, stale leases, and adversarial identity mismatches.

## Non-goals

- Do not move or delete currently active legacy worktrees in place.
- Do not modify unrelated Browser, Apple, RC6, Teassis, Supervisor drill, or business repository work.
- Do not use Session or Repository active checkout as fallback for an existing WorkHandle.
- Do not weaken Git, approval, authorization, or lease safety checks.

## Acceptance Criteria

- [ ] Explicit checkout identity survives MCP scoping and every downstream invocation without re-resolution drift.
- [ ] All Work-bound process launches derive repositoryId, checkoutId, worktreePath, branch, and expectedHead from WorkHandle.
- [ ] Any mismatch between registered checkout, WorkHandle, resolved cwd, Git top-level, branch, HEAD, or common Git directory fails before process spawn with a structured route error and no fallback.
- [ ] New managed worktrees are created outside all registered repository roots; legacy nested worktrees remain readable and cleanable only after exact identity checks.
- [ ] Readonly and mutation resource claims are correctly classified and checkout-scoped; terminal/cancelled processes release leases.
- [ ] Property-based and destructive tests prove wrong identities never reach process launch.
- [ ] Fix is merged to main, activated in the runtime release, and verified through the connected Controller/Gateway with recorded source, merge, release, slot, and instance revisions.

## GitHub

- Not published.

## Tasks

### T1 — Implement immutable execution identity and pre-spawn guard

- Status: `verifying`
- Objective: Introduce an immutable resolved execution identity, stop deleting/re-resolving checkout identity, make WorkHandle authoritative for Work operations, add exact realpath/Git top-level/common-dir/branch/HEAD/lifecycle validation before every relevant process spawn, and migrate legacy WorkContract identity only through unique exact WorkHandle matches.
- Depends on: none
- Allowed paths: `src/runtime/gateway/mcp/**`, `src/runtime/control-plane/execution/**`, `src/runtime/control-plane/facade/**`, `src/runtime/execution/process-runtime/**`, `src/cli/mcp/**`, `src/cli/repositories/**`, `src/cli/local-bridge/**`, `tests/runtime/**`, `tests/cli/**`, `docs/architecture/current/**`, `docs/operations/**`, `tasks/issues/**`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:controller-v8`
- Execution hint: selected at runtime

### T2 — Externalize new managed worktrees and checkout-scope leases

- Status: `planned`
- Objective: Allocate all new managed worktrees in stable controller-owned storage outside registered repository roots, preserve exact compatibility for active legacy nested worktrees, and make Process Runtime resource claims and lease reconciliation include repositoryId, checkoutId, and workId with correct readonly/mutation semantics.
- Depends on: `T1`
- Allowed paths: `src/runtime/control-plane/**`, `src/runtime/execution/**`, `src/runtime/resources/**`, `src/cli/repositories/**`, `src/cli/controller/**`, `tests/runtime/**`, `tests/cli/**`, `docs/architecture/current/**`, `docs/operations/**`, `tasks/issues/**`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:controller-v8`
- Execution hint: selected at runtime

### T3 — Prove route integrity under drift, restart, and adversarial faults

- Status: `planned`
- Objective: Add nested repository/worktree, Session drift, Registry drift, reconnect/restart/resume, missing checkout, branch/HEAD drift, symlink/path alias, duplicate branch, property-based, stale lease, and destructive no-wrong-spawn tests; then merge, activate, and verify the exact runtime release and connector identity.
- Depends on: `T2`
- Allowed paths: `tests/**`, `scripts/**`, `docs/researches/**`, `docs/operations/**`, `tasks/issues/**`, `src/runtime/**`, `src/cli/**`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:controller-v8`, `package:test`
- Execution hint: selected at runtime

### T4 — Propagate Process check completion into Edit Session and Task receipts

- Status: `ready`
- Objective: Replace the broken verification handoff where verify_edit_session retires Local Jobs but Process Runtime results cannot update Edit Session checkResults or Task completion evidence. Introduce one authoritative check completion receipt/event consumed idempotently by Edit Session verification, Work validation and Task completion, preserving exact checkout/work/revision identity and success/failure semantics.
- Depends on: none
- Allowed paths: `src/runtime/execution/process-runtime/**`, `src/runtime/evidence/**`, `src/runtime/control-plane/**`, `src/runtime/gateway/mcp/**`, `src/cli/editing/**`, `src/cli/controller/**`, `src/cli/local-bridge/**`, `tests/runtime/**`, `tests/cli/**`, `docs/architecture/current/**`, `docs/operations/**`, `tasks/issues/**`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:controller-v8`
- Execution hint: selected at runtime

## Related Artifacts

- `ISS-20260731-CCF3E3`
- `ISS-20260715-9E34AD`
- `src/cli/mcp/multi-repository.ts`
- `src/runtime/gateway/mcp/execution-tools.ts`
- `src/runtime/control-plane/execution/validation.ts`
- `src/runtime/execution/process-runtime/command-facade.ts`
- `src/cli/repositories/registry.ts`
