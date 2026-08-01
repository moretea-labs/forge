---
id: "ISS-20260731-CCF3E3"
kind: "governance"
status: "in_progress"
updated_at: "2026-08-01T00:00:00.000Z"
source: "repo-harness-controller-v8"
---

# Converge Control Plane storage architecture and detach runtime state from repositories

Define and gradually implement the long-term Repo Harness Control Plane storage boundary. Move runtime/task/work state ownership away from product repositories while preserving human-readable projections and avoiding disruption to active reliability work.

## Goals

- Define authoritative state versus generated projections.
- Establish repository versus controller-home ownership boundaries.
- Design phased migration from repository-local issue snapshots to controller-owned persistence.
- Preserve Git cleanliness and multi-machine consistency.
- Avoid introducing conflicts with active work by starting with architecture and bounded migration preparation only.

## Non-goals

- Do not immediately migrate all existing issue JSON/Markdown files.
- Do not introduce SQLite as a replacement without schema and migration validation.
- Do not modify active reliability, browser, Apple, or release implementation paths.

## Acceptance Criteria

- [ ] Architecture decision document defines repository, control plane, and artifact boundaries.
- [ ] Persistence strategy defines authoritative storage, projections, migration, rollback, and compatibility behavior.
- [ ] Plan covers SQLite or equivalent local transactional storage evaluation without premature commitment.
- [ ] Migration phases can coexist with active tasks and do not require broad worktree-based parallel changes.
- [ ] Old repository-local snapshots remain readable during transition.

## GitHub

- Not published.

## Tasks

### T1 — Write Control Plane storage architecture decision

- Status: `verified`
- Objective: Document authoritative state boundaries, repository ownership, artifact ownership, projection rules, lifecycle differences, and migration principles. This task is analysis/documentation only.
- Depends on: none
- Allowed paths: `docs/**`
- Checks: `package:check:public-docs`
- Execution hint: selected at runtime
- Evidence: `docs/architecture/decisions/20260801-controller-home-sqlite-state.md` defines the controller-home SQLite authority, one-way JSON import, audit, rollback, and phased migration. `package:check:public-docs` passed on 2026-08-01.

### T2 — Inventory current state stores and migration dependencies

- Status: `verified`
- Objective: Map issue/task/work/run/session/lease/evidence storage locations and identify which stores must move first, including compatibility constraints and active feature dependencies.
- Depends on: none
- Allowed paths: `docs/**`, `src/runtime/**`
- Checks: `package:check:type`
- Execution hint: selected at runtime
- Evidence: `docs/researches/20260801-control-plane-state-store-inventory.md` maps authority, compatibility, dependencies, and migration priority. Controller claim sessions are SQLite-authoritative with one-time legacy JSON import; `bun run check:type` and `bun test tests/runtime/control-plane-sqlite-store.test.ts` passed (8 tests).

### T3 — Design shadow persistence migration strategy

- Status: `verified`
- Objective: Define a future controller-owned persistence layer with shadow reads, projection generation, validation, rollback, and incremental cutover. Do not implement the database migration in this task.
- Depends on: none
- Allowed paths: `docs/**`
- Checks: not defined
- Execution hint: selected at runtime
- Evidence: The Process Runtime shadow-cutover design in `docs/researches/20260801-control-plane-state-store-inventory.md` defines one-way import, atomic namespace-family cutover, derived active-index projection, fault coverage, and rollback that cannot replay stale JSON over SQLite.

## Related Artifacts

- None.
