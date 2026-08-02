---
id: "ISS-20260730-AE1BCC"
kind: "governance"
status: "cancelled"
updated_at: "2026-08-02T06:21:49.963Z"
source: "repo-harness-controller-v8"
---

# 归档旧的 Repo Harness 可靠性治理计划

已被新的用户需求式治理和运行时架构方案取代。原 Program Charter、跨会话协议和历史 snapshot 对账证据继续保留，但不再作为活跃需求或执行入口；不再通过新的元治理 Issue 嵌套管理其他 Issue。

## Goals

- Persist one canonical program charter, dependency graph, invariants, acceptance gates, and cross-session continuation protocol.
- Make stable, fail-closed execution and trustworthy completion evidence the highest priority.
- After stability is proven, establish evidence-based bounded concurrency before any broader optimization work resumes.
- Link and govern all result and coordination Issues without duplicating active P0 work or trusting stale projections.
- Ensure every future implementation Task is rebaselined from current source and Controller facts, resumable from stable IDs, and uses targeted verification, scoped integration and cleanup.
- Preserve the complete final scope, including Apple release orchestration and full Advanced/Full tool callability, but execute it only after stability and concurrency gates.

## Non-goals

- Do not introduce a second control plane or revive deprecated Campaign automation as the source of truth.
- Do not reinterpret Core tool-surface reduction as a permission restriction or removal of underlying capabilities.
- Do not launch broad parallel implementation merely because Tasks are declared ready.
- Do not resume other optimizations before ISS-20260731-B66A97 is independently accepted and ISS-20260731-7BB554 has rebaselined the active portfolio.
- Do not make SQLite authoritative, migrate every worktree, or build a semantic conflict scheduler as part of the immediate P0 recovery.

## Acceptance Criteria

- [ ] A repository-tracked Program Charter records total goals, result goals, dependencies, non-goals, invariants, parallelism policy and final acceptance criteria.
- [ ] The Program and session protocol reference ISS-20260731-7BB554 as the post-P0 portfolio rebaseline and staged concurrency governor.
- [ ] Stable execution and completion evidence pass a current-revision P0 exit gate before any downstream development is reopened.
- [ ] Every active Issue and Task is reclassified after P0; stale, duplicate or refactor-invalidated work is revised, merged, superseded or cancelled before dispatch.
- [ ] Concurrency is reopened incrementally through read-only, one-writer-plus-readers and proven-independent-writers pilots, with rollback on unexplained failures.
- [ ] Only after stability and concurrency gates pass may Browser, Apple, iOS, V2, tool-surface, storage, bug-reduction and performance work resume.
- [ ] The charter explicitly states Core is an architecture/exposure optimization only; Advanced and Full retain all stable callable tools and category-level E2E coverage.
- [ ] The charter retains the complete Apple target: credential/profile/context resolution, Xcode capabilities, signing, archive/export/upload, processing, assets, TestFlight, metadata and release orchestration.

## GitHub

- Not published.

## Tasks

### T1 — Publish the reliability program charter and cross-session protocol

- Status: `verified`
- Objective: Create canonical repository documentation that preserves the full program scope, issue dependency map, invariants, acceptance gates, and executable cross-session continuation procedure. This task is documentation/governance only.
- Depends on: none
- Allowed paths: `docs/architecture/RELIABILITY-PROGRAM.md`, `docs/runbooks/RELIABILITY-SESSION-PROTOCOL.md`
- Checks: `docs`
- Execution hint: selected at runtime

### T2 — Reconcile repository Issue snapshots and delivery receipt after RC6

- Status: `review`
- Objective: After ISS-20260729-BF2F89 reaches a clean integrated terminal revision, regenerate or copy the five controller Issue snapshots into the repository from durable controller state, commit only those exact snapshot paths, and reconcile the verified governance delivery with a complete receipt. Do not depend on the currently untracked copies in the dirty RC6 checkout and do not mix unrelated RC6 changes.
- Depends on: `T1`
- Allowed paths: `tasks/issues/ISS-20260730-AE1BCC-*.issue.json`, `tasks/issues/ISS-20260730-AE1BCC-*.issue.md`, `tasks/issues/ISS-20260730-A1EA53-*.issue.json`, `tasks/issues/ISS-20260730-A1EA53-*.issue.md`, `tasks/issues/ISS-20260730-84CE88-*.issue.json`, `tasks/issues/ISS-20260730-84CE88-*.issue.md`, `tasks/issues/ISS-20260730-B55445-*.issue.json`, `tasks/issues/ISS-20260730-B55445-*.issue.md`, `tasks/issues/ISS-20260730-CCF211-*.issue.json`, `tasks/issues/ISS-20260730-CCF211-*.issue.md`
- Checks: not defined
- Execution hint: selected at runtime

## Related Artifacts

- `ISS-20260802-539E7F runtime stability requirement`
- `new requirement-management and SQLite architecture Issue`
- `docs/architecture/RELIABILITY-PROGRAM.md retained as historical policy`
- `docs/runbooks/RELIABILITY-SESSION-PROTOCOL.md retained as historical policy`
