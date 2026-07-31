---
id: "ISS-20260730-AE1BCC"
kind: "governance"
status: "in_progress"
updated_at: "2026-07-31T00:05:37.341Z"
source: "repo-harness-controller-v8"
---

# Establish the Repo Harness reliability and context convergence program

Canonical durable program anchor for the next Repo Harness reliability release line. The RC6 prerequisite was satisfied and released at exact green revision 2a48486b7b8c3395d05e4f30201e968ee88f9779; current origin/main has advanced to 809349d43b6583b4cfa22e55986f760f16380cb3. Result Issues: execution evidence ISS-20260730-A1EA53; Apple context/capability/release ISS-20260730-84CE88; non-permission tool-surface convergence ISS-20260730-B55445; bounded bug-reduction Shadow ISS-20260730-CCF211. Future sessions recover from these Issues, Tasks, WorkContracts, Completion Receipts, and repository documentation rather than chat history.

## Goals

- Persist one canonical program charter, dependency graph, invariants, acceptance gates, and cross-session continuation protocol.
- Link four result Issues without duplicating the active RC6 release work or relying on the stale paused App Store Connect Campaign record.
- Ensure every future implementation Task is resumable from stable IDs and follows one Task → one WorkContract → one isolated worktree → verification → commit → merge → cleanup.
- Preserve the complete final scope, including Apple release orchestration and full Advanced/Full tool callability.

## Non-goals

- Do not modify runtime implementation while RC6 is still being closed.
- Do not introduce a second control plane or revive deprecated Campaign automation as the source of truth.
- Do not reinterpret Core tool-surface reduction as a permission restriction or removal of underlying capabilities.
- Do not launch broad parallel implementation from this governance Task.

## Acceptance Criteria

- [ ] A repository-tracked Program Charter records the total goal, four result goals, mandatory RC6 gate, dependencies, non-goals, invariants, parallelism policy, and final acceptance criteria.
- [ ] A repository-tracked Session Protocol gives copyable startup, coordinator, worker, interruption, handoff, merge, and cleanup procedures using stable IDs.
- [ ] Four durable result Issues exist and are linked from this governance Issue and the charter.
- [ ] The charter explicitly states Core is an architecture/exposure optimization only; Advanced and Full retain all stable callable tools and category-level E2E coverage.
- [ ] The charter retains the complete Apple target: credential/profile/context resolution, Xcode capabilities, signing, archive/export/upload, processing, assets, TestFlight, metadata, and release orchestration.
- [ ] The documentation change is committed, merged to main, and its temporary branch/worktree is removed without touching the dirty RC6 checkout.

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

- Status: `running`
- Objective: After ISS-20260729-BF2F89 reaches a clean integrated terminal revision, regenerate or copy the five controller Issue snapshots into the repository from durable controller state, commit only those exact snapshot paths, and reconcile the verified governance delivery with a complete receipt. Do not depend on the currently untracked copies in the dirty RC6 checkout and do not mix unrelated RC6 changes.
- Depends on: `T1`
- Allowed paths: `tasks/issues/ISS-20260730-AE1BCC-*.issue.json`, `tasks/issues/ISS-20260730-AE1BCC-*.issue.md`, `tasks/issues/ISS-20260730-A1EA53-*.issue.json`, `tasks/issues/ISS-20260730-A1EA53-*.issue.md`, `tasks/issues/ISS-20260730-84CE88-*.issue.json`, `tasks/issues/ISS-20260730-84CE88-*.issue.md`, `tasks/issues/ISS-20260730-B55445-*.issue.json`, `tasks/issues/ISS-20260730-B55445-*.issue.md`, `tasks/issues/ISS-20260730-CCF211-*.issue.json`, `tasks/issues/ISS-20260730-CCF211-*.issue.md`
- Checks: not defined
- Execution hint: selected at runtime

## Related Artifacts

- `ISS-20260729-BF2F89 (mandatory prerequisite)`
- `ISS-20260730-A1EA53 (Result Goal 1: execution evidence)`
- `ISS-20260730-84CE88 (Result Goal 2: Apple context/capability/release)`
- `ISS-20260730-B55445 (Result Goal 3: Core/Advanced/Full without capability loss)`
- `ISS-20260730-CCF211 (Result Goal 4: bug-reduction Shadow)`
- `CMP-20260723-0FFA4F (stale paused projection; inspect/migrate only, never sole source)`
- `docs/architecture/RELIABILITY-PROGRAM.md @ 25f40004c9f229b935fc649daaf68498eb4d4f06`
- `docs/runbooks/RELIABILITY-SESSION-PROTOCOL.md @ 25f40004c9f229b935fc649daaf68498eb4d4f06`
- `work_2705c12349124ed2b9b94950a427c31a (actual integration/cleanup complete; stale finalize projection retained as ISS-20260730-A1EA53 audit fixture)`
