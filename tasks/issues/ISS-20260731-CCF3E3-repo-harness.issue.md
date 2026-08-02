---
id: "ISS-20260731-CCF3E3"
kind: "governance"
status: "done"
updated_at: "2026-08-02T06:25:31.750Z"
source: "repo-harness-controller-v8"
---

# 确定 Repo Harness 控制面状态存储方案

已完成架构基础：Controller-home SQLite 作为已迁移控制面命名空间的唯一权威，旧 JSON 只允许一次性导入，日志和大型证据继续保留为文件。该成果将作为新的需求管理与执行账本架构输入，不再单独推进兼容式迁移。

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

### T2 — Inventory current state stores and migration dependencies

- Status: `verified`
- Objective: Map issue/task/work/run/session/lease/evidence storage locations and identify which stores must move first, including compatibility constraints and active feature dependencies.
- Depends on: none
- Allowed paths: `docs/**`, `src/runtime/**`
- Checks: `package:check:type`
- Execution hint: selected at runtime

### T3 — Design shadow persistence migration strategy

- Status: `verified`
- Objective: Define a future controller-owned persistence layer with shadow reads, projection generation, validation, rollback, and incremental cutover. Do not implement the database migration in this task.
- Depends on: none
- Allowed paths: `docs/**`
- Checks: not defined
- Execution hint: selected at runtime

## Related Artifacts

- `docs/architecture/decisions/20260801-controller-home-sqlite-state.md`
- `docs/researches/20260801-control-plane-state-store-inventory.md`
- `new requirement-management and SQLite architecture Issue`
- `ISS-20260802-539E7F runtime authority remains separate`
