---
id: "ISS-20260731-7BB554"
kind: "governance"
status: "planned"
updated_at: "2026-07-31T07:50:38.267Z"
source: "repo-harness-controller-v8"
---

# Rebaseline reliability work and govern staged parallel execution

Freeze all non-P0 development until trusted execution is independently verified, then rebaseline every active Issue and Task against the current Controller, Git, execution-identity, receipt and storage architecture. Delivery priority is strict: first eliminate wrong-repository execution, stale ownership, receipt loss and unexplained runtime state; second establish evidence-based bounded parallelism through explicit code and global resource claims; only after those gates pass may Browser, Apple, iOS, V2, tool-surface, storage and performance optimizations resume. Existing ready status is not authorization to execute, and outdated contracts must be revised, merged, superseded or cancelled before dispatch.

## Goals

- Make execution stability and trustworthy completion the non-negotiable first priority.
- Keep all non-P0 write work frozen until a current-revision P0 exit gate passes.
- Re-read and classify every active Issue, Task, Work, Run and Edit Session after P0 instead of continuing from stale plans.
- Establish deterministic concurrency admission using repository, checkout, path, subsystem and global resource claims.
- Prove parallel execution incrementally before increasing writer count.
- Rebuild downstream delivery waves so architecture changes do not cause duplicated or obsolete work.
- Keep validation targeted and prevent release, Browser, Apple, iOS, V2, storage and performance work from bypassing stability and concurrency gates.

## Non-goals

- Do not immediately migrate all control-plane state to SQLite or make SQLite authoritative.
- Do not immediately externalize every legacy worktree before execution identity is proven.
- Do not resume Browser, Apple, iOS, V2, RC6 publication, tool-surface convergence or bug-reduction implementation during the P0 freeze.
- Do not globally delete or rollback dirty sessions, leases, WorkContracts, branches or artifacts without proven ownership and disposition.
- Do not create a semantic AI conflict scheduler before deterministic path and resource claims are sufficient.
- Do not use full package:test or release gates by default when focused evidence is adequate.
- Do not treat Controller readiness alone as proof that P0 implementation and receipts are complete.

## Acceptance Criteria

- [ ] The coordination Issue records a freeze where only ISS-20260731-B66A97 P0 work may mutate core execution paths until its exit gate passes.
- [ ] The P0 exit gate is independently verified on the current revision, including mandatory execution identity, no spawn bypass, WorkHandle authority, fail-closed route drift, exact-revision check receipts and explainable Process/Lease state.
- [ ] Every active Issue and Task is classified as continue, revise, merge, partially implemented, supersede, cancel, blocked, read-only-ready, isolated-write-ready or exclusive-core-mutation.
- [ ] Dependencies and delivery waves are updated from current source and Controller facts; no task is dispatched merely because it is declared ready.
- [ ] Concurrency admission includes code-path claims and shared resources such as build cache, Browser, device, simulator, ports, Supervisor/release and remote mutation surfaces.
- [ ] Parallelism is reopened through a bounded pilot: read-only parallelism, then one writer plus readers, then at most two proven-independent writers; failure rolls back the allowed level.
- [ ] Downstream optimization work resumes only after stability and concurrency gates pass, using refreshed contracts and targeted checks.
- [ ] No push, tag, release, npm publish or irreversible remote action is performed by this coordination Issue.

## GitHub

- Not published.

## Tasks

### T1 — Enforce the non-P0 freeze and define the stability exit gate

- Status: `ready`
- Objective: Record the temporary execution policy: only ISS-20260731-B66A97 P0 mutations may proceed; all other development, remote release actions and live Browser/Apple/iOS mutations remain frozen. Inventory active dirty Edit Sessions without deleting them, distinguish parked from authoritative sessions, and freeze a concise P0 exit gate covering immutable execution identity, WorkHandle authority, guarded spawn, exact-revision verification receipts, process/lease diagnosis, proven-orphan reconciliation and explainable Git/runtime state.
- Depends on: none
- Allowed paths: `docs/architecture/RELIABILITY-PROGRAM.md`, `docs/runbooks/RELIABILITY-SESSION-PROTOCOL.md`, `docs/operations/**`, `tasks/issues/**`
- Checks: not defined
- Execution hint: selected at runtime

### T2 — Independently verify trusted execution recovery

- Status: `planned`
- Objective: After ISS-20260731-B66A97 reports completion, re-read the exact Git revision, T1/T4 Edit Sessions, diffs, focused tests, Process/Lease state and persisted check/task receipts. Verify executionIdentity is mandatory at the bottom spawn boundary, every caller supplies it, wrong repo/checkout/cwd/top-level/common-dir/branch/HEAD/lifecycle fails closed, WorkHandle is authoritative, no silent fallback exists, and all current leases/processes have explainable ownership. Reject verbal completion or stale evidence.
- Depends on: `T1`
- Allowed paths: `tasks/issues/**`, `docs/operations/**`
- Checks: not defined
- Execution hint: selected at runtime

### T3 — Rebaseline the complete active portfolio

- Status: `planned`
- Objective: Audit all active Issues, Tasks, WorkContracts, Runs, Edit Sessions and integration-blocked evidence against the post-P0 source tree. Classify each item as continue unchanged, revise contract, merge, partially implemented, supersede, cancel, architecture-blocked, read-only-ready, isolated-write-ready or exclusive-core-mutation. Identify plans invalidated by route, receipt, storage, Browser or runtime refactors, and update dependencies before any dispatch.
- Depends on: `T2`
- Allowed paths: `tasks/issues/**`, `docs/architecture/**`, `docs/operations/**`, `docs/researches/**`, `plans/**`
- Checks: not defined
- Execution hint: selected at runtime

### T4 — Define deterministic concurrency admission and delivery waves

- Status: `planned`
- Objective: Design the minimum enforceable concurrency model after the portfolio rebaseline. Admission must consider repository, checkout, declared and actual paths, subsystem, mutation class and shared resources including build cache, Browser/User Chrome, simulator, physical device, ports, Supervisor/release, GitHub, App Store Connect and package publication. Define levels from exclusive recovery through read-only parallelism, one writer plus readers, and two proven-independent writers. Rebuild delivery waves with stability first, concurrency second, then storage placement and other optimizations.
- Depends on: `T3`
- Allowed paths: `docs/architecture/**`, `docs/operations/**`, `tasks/issues/**`
- Checks: not defined
- Execution hint: selected at runtime

### T5 — Run a bounded parallelism pilot and decide the safe level

- Status: `planned`
- Objective: Execute staged pilots only after the admission contract is implemented or enforceable: first two read-only tasks; then one isolated writer plus readers; then two different-repository writers with no shared resources; finally, only if proven, two same-repository writers with disjoint actual paths and no shared registry/router/schema/cache or external resource. Measure checkout drift, dirty overlap, stale evidence, lease ownership, check startup, commit scope, integration and cleanup. Roll back the concurrency level on any unexplained failure.
- Depends on: `T4`
- Allowed paths: `tests/**`, `scripts/**`, `docs/researches/**`, `docs/operations/**`, `tasks/issues/**`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:controller-v8`
- Execution hint: selected at runtime

### T6 — Reopen downstream work in controlled priority waves

- Status: `planned`
- Objective: Using the post-P0 portfolio and pilot evidence, update each remaining Issue contract and reopen work one wave at a time. Stability defects and completion semantics remain first; safe concurrency infrastructure is second; only then resume storage shadow design, worktree placement, Browser, Apple, iOS, V2, tool-surface, bug-reduction and performance work. Use targeted checks, merge and clean completed branches/worktrees promptly, and reassess the concurrency level after each wave.
- Depends on: `T5`
- Allowed paths: `tasks/issues/**`, `docs/architecture/**`, `docs/operations/**`, `plans/**`
- Checks: not defined
- Execution hint: selected at runtime

## Related Artifacts

- `ISS-20260730-AE1BCC`
- `ISS-20260731-B66A97`
- `ISS-20260730-A1EA53`
- `ISS-20260731-CCF3E3`
- `ISS-20260730-B55445`
- `ISS-20260730-84CE88`
- `ISS-20260730-CCF211`
- `ISS-20260731-6A7BB5`
- `ISS-20260729-BF2F89`
- `ISS-20260726-69DA83`
- `ISS-20260720-66E25D`
- `ISS-20260720-E8E871`
- `ISS-20260719-F77E4C`
- `ISS-20260716-34A906`
- `docs/architecture/RELIABILITY-PROGRAM.md`
- `docs/runbooks/RELIABILITY-SESSION-PROTOCOL.md`
