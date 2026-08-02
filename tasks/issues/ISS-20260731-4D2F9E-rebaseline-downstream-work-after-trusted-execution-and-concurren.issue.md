---
id: "ISS-20260731-4D2F9E"
kind: "governance"
status: "cancelled"
updated_at: "2026-08-02T05:47:04.685Z"
source: "repo-harness-controller-v8"
---

# Rebaseline downstream work after trusted execution and concurrency gates

Duplicate governance plan superseded by ISS-20260731-7BB554 and now by the concrete runtime architecture authority ISS-20260802-539E7F. No implementation or portfolio rebaseline should be dispatched from this Issue. Its useful freeze/rebaseline/concurrency intent is preserved in the surviving governance line.

## Goals

- Keep a single P0 write lane until trusted execution and receipt propagation are proven.
- Make stability the top priority: no wrong-checkout spawn, no silent fallback, no stale evidence reuse, no unexplained active leases.
- Make safe execution concurrency the second priority: resource claims, path ownership, base-revision invalidation, and bounded pilot before reopening parallel development.
- Defer other optimizations such as SQLite authority migration, broad worktree relocation, Browser/Apple/iOS product work, V2 cutover, and release tasks until stability and concurrency gates pass.
- After P0 completes, re-read Controller and Git facts and reclassify all active Issues and Tasks before dispatching anything.
- Avoid wasted work by revising, merging, superseding, or cancelling stale Contracts that became outdated due to P0 execution architecture changes.

## Non-goals

- Do not resume Browser, Apple, iOS, V2, release, or tool-surface development before the P0 exit gate passes.
- Do not make SQLite the authoritative Control Plane store in this Issue.
- Do not perform broad runtime cleanup or delete unknown ownership artifacts.
- Do not use full test, CI, release-readiness, push, tag, release, or npm publish as part of this coordination Issue.
- Do not restore broad parallel development immediately after P0; use staged concurrency gates instead.
- Do not rely on prompt-only discipline as the safety boundary; require Controller evidence.

## Acceptance Criteria

- [ ] A program-wide freeze policy exists and names the only allowed P0 write lane.
- [ ] P0 exit gate is explicit and must be evidence-checked before any downstream work resumes.
- [ ] All active Issues and ready Tasks are reclassified after P0 using current Controller and Git facts.
- [ ] Remaining work is reorganized into waves: stability, safe concurrency, runtime placement/storage cleanup, then product/integration optimization.
- [ ] Safe parallelism admission rules are defined using resource claims, not just repository names.
- [ ] A bounded concurrency pilot is required before more than one write task is allowed.
- [ ] Downstream tasks are reopened only in controlled waves and only after Contract revalidation.
- [ ] No stale ready task is dispatched solely because it was ready before P0.

## GitHub

- Not published.

## Tasks

### T1 — Record recovery freeze and priority gates

- Status: `ready`
- Objective: Document and enforce the temporary execution freeze: stability first, safe concurrency second, all other optimization later. Name ISS-20260731-B66A97 as the only active P0 write lane until its exit gate is proven.
- Depends on: none
- Allowed paths: `tasks/issues/**`, `docs/operations/**`, `docs/architecture/current/**`
- Checks: not defined
- Execution hint: selected at runtime

### T2 — Verify trusted execution exit gate

- Status: `planned`
- Objective: After ISS-20260731-B66A97 reports completion, independently verify the P0 exit gate from Controller, Git, edit sessions, process receipts, leases, and focused check evidence before reopening any downstream work.
- Depends on: `T1`
- Allowed paths: `tasks/issues/**`, `docs/operations/**`
- Checks: not defined
- Execution hint: selected at runtime

### T3 — Rebaseline active Issue portfolio

- Status: `planned`
- Objective: Re-read every active Issue, ready Task, dirty edit session, active Work/Run, Git status, Process, and Lease after P0 and classify downstream work as continue, revise, merge, partially implemented, superseded, cancelled, blocked, read-only, isolated write, or exclusive core mutation.
- Depends on: `T2`
- Allowed paths: `tasks/issues/**`, `docs/operations/**`, `docs/architecture/current/**`
- Checks: not defined
- Execution hint: selected at runtime

### T4 — Rebuild execution waves and dependencies

- Status: `planned`
- Objective: Convert the rebaselined portfolio into ordered waves: Wave 0 stability, Wave 1 safe concurrency admission, Wave 2 runtime placement/storage cleanup, Wave 3 Control Plane store shadowing, Wave 4 product/integration work.
- Depends on: `T3`
- Allowed paths: `tasks/issues/**`, `docs/operations/**`, `docs/architecture/current/**`
- Checks: not defined
- Execution hint: selected at runtime

### T5 — Define bounded parallelism admission

- Status: `planned`
- Objective: Define deterministic concurrency admission using path claims and global resource claims, including repository, checkout, paths, subsystem, build cache, browser session, device, simulator, port, Supervisor/release, and remote mutation resources.
- Depends on: `T4`
- Allowed paths: `tasks/issues/**`, `docs/architecture/current/**`, `docs/operations/**`
- Checks: not defined
- Execution hint: selected at runtime

### T6 — Run bounded concurrency pilot

- Status: `planned`
- Objective: After the admission rules exist, run a staged pilot: read-only parallelism, one writer plus readers, two different-repository writers without shared resources, then two same-repository isolated writers only if claims prove independence.
- Depends on: `T5`
- Allowed paths: `tasks/issues/**`, `docs/operations/**`
- Checks: not defined
- Execution hint: selected at runtime

### T7 — Reopen downstream work in controlled waves

- Status: `planned`
- Objective: Resume downstream Issues only after the stability and concurrency gates pass, one wave at a time, with each Contract updated from current facts.
- Depends on: `T6`
- Allowed paths: `tasks/issues/**`, `docs/operations/**`, `docs/architecture/current/**`
- Checks: not defined
- Execution hint: selected at runtime

## Related Artifacts

- `ISS-20260731-7BB554`
- `ISS-20260802-539E7F`
- `duplicate-of: staged reliability rebaseline`
