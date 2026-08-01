---
id: "ISS-20260730-A1EA53"
kind: "feature"
status: "in_progress"
updated_at: "2026-07-31T00:40:14.794Z"
source: "repo-harness-controller-v8"
---

# Harden execution evidence and trustworthy completion semantics

Result Goal 1 of ISS-20260730-AE1BCC for the next reliability release line. The RC6 gate was satisfied at exact released revision 2a48486b7b8c3395d05e4f30201e968ee88f9779; T1 is ready to audit current WorkContract, Evidence Plane, finalize, merge, cleanup, and recovery behavior. The audit must preserve work_2705c12349124ed2b9b94950a427c31a as a real stale-finalization and receipt-recovery fixture before implementation begins.

## Goals

- Introduce explicit WorkKind, DispatchState, and EvidenceState semantics with backward-compatible migration.
- Bind validation and completion to the exact source revision and current repository state.
- Produce a machine-readable Completion Receipt covering mutation, checks, commit, merge, cleanup, no-change outcomes, and remaining risks.
- Make interrupted-session recovery idempotent and evidence-driven.

## Non-goals

- Do not create an autonomous planning brain or a parallel execution state model.
- Do not treat agent prose as sufficient completion evidence.
- Do not block legitimate completed_no_change outcomes when they are proven.
- Do not begin runtime modification before ISS-20260729-BF2F89 reaches a clean terminal and merged baseline.

## Acceptance Criteria

- [ ] Legacy WorkContract records remain readable and migrate deterministically.
- [ ] A changed result cannot finalize without current-revision mutation, check, commit/integration, and cleanup evidence required by its contract.
- [ ] A no-change result has a distinct, auditable completion path that proves the objective was already satisfied.
- [ ] Stale or contradictory evidence prevents final completion and produces actionable recovery state.
- [ ] A new session can resume a Work by stable ID without depending on chat history.
- [ ] Focused and regression tests cover success, no-change, interruption, retry, stale evidence, failed check, failed merge, and cleanup recovery.

## GitHub

- Not published.

## Tasks

### T1 — Audit current Work completion state and freeze the evidence contract

- Status: `verified`
- Objective: After RC6 is merged, map current WorkContract, ExecutionJob, Evidence Plane, finalize, merge, cleanup, and recovery behavior; record the minimal compatible data-model and migration contract before implementation.
- Depends on: none
- Allowed paths: `docs/**`, `src/runtime/control-plane/facade/**`, `src/runtime/workflow/**`, `tests/**`
- Checks: `typecheck`
- Execution hint: selected at runtime

### T2 — Add explicit work, dispatch, and evidence state semantics with migration

- Status: `verified`
- Objective: Implement WorkKind, DispatchState, EvidenceState, versioned persistence, and deterministic backward-compatible reads for existing Work records.
- Depends on: `T1`
- Allowed paths: `src/runtime/control-plane/**`, `src/runtime/workflow/**`, `src/runtime/persistence/**`, `tests/**`
- Checks: `typecheck`, `test`
- Execution hint: selected at runtime
- Evidence: schema-v2 WorkKind, DispatchState, EvidenceState, and CompletionOutcome axes are implemented with in-memory schema-v1 normalization, guarded v2 writes, and fail-closed outcome/transition validation. Focused state/lifecycle suites and typecheck passed on 2026-08-01.

### T3 — Bind verification and Completion Receipts to the exact revision

- Status: `planned`
- Objective: Record exact-revision check evidence and emit a Completion Receipt that traces objective, acceptance criteria, mutation/no-change proof, checks, commit, integration, cleanup, and residual risk.
- Depends on: `T2`
- Allowed paths: `src/runtime/control-plane/**`, `src/runtime/evidence/**`, `src/runtime/workflow/**`, `tests/**`
- Checks: `typecheck`, `test`
- Execution hint: selected at runtime

### T4 — Gate finalize for changed and no-change outcomes

- Status: `planned`
- Objective: Update finalize so changed work and completed_no_change use distinct evidence gates; record failed commit, merge, or cleanup as resumable non-terminal stages.
- Depends on: `T3`
- Allowed paths: `src/runtime/control-plane/**`, `src/runtime/workflow/**`, `src/runtime/git/**`, `tests/**`
- Checks: `typecheck`, `test`
- Execution hint: selected at runtime

### T5 — Harden cross-session recovery and continuation handoff

- Status: `planned`
- Objective: Ensure work_get, work_inspect, status digests, continuation prompts, and repair paths expose enough bounded evidence for a new session to continue safely.
- Depends on: `T4`
- Allowed paths: `src/runtime/control-plane/**`, `src/runtime/gateway/**`, `src/cli/**`, `tests/**`, `docs/**`
- Checks: `typecheck`, `test`
- Execution hint: selected at runtime

### T6 — Run execution-evidence regression and failure-injection coverage

- Status: `planned`
- Objective: Validate success, no-change, interruption, retry, stale evidence, contradictory evidence, failed checks, failed merge, cleanup recovery, and legacy migration across focused and full checks.
- Depends on: `T5`
- Allowed paths: `tests/**`, `scripts/**`, `docs/**`
- Checks: `typecheck`, `test`, `ci`
- Execution hint: selected at runtime

## Related Artifacts

- `ISS-20260730-AE1BCC`
- `ISS-20260729-BF2F89 (mandatory gate)`
- `docs/architecture/RELIABILITY-PROGRAM.md`
