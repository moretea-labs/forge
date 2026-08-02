---
id: "ISS-20260716-34A906"
kind: "bug"
status: "done"
updated_at: "2026-08-02T06:20:39.479Z"
source: "repo-harness-controller-v8"
---

# 自动清理 Repo Harness 临时运行资源

已完成。运行时会按 TTL、批量上限和进程占用保护自动清理废弃临时目录；清理失败不会影响 Controller 可用性。源码、测试和主要检查均已通过，旧 Task 仅因历史完成语义未自动终态，不再保留为当前项目焦点。

## Goals

- Run bounded automatic cleanup after daemon startup and periodically
- Keep a minimum 24-hour TTL and process-occupancy protection
- Limit removals per cycle and never affect Controller readiness
- Preserve blue/green active and rollback slot resources
- Complete and commit the existing coherent lifecycle changes on main

## Non-goals

- Aggressive deletion of unknown non-repo-harness paths
- Changing blue/green deployment semantics
- Deleting active jobs, leases, worktrees, artifacts, or slots

## Acceptance Criteria

- [ ] Old unoccupied repo-harness temp directories are removed automatically in bounded batches
- [ ] Recent or process-owned temp directories remain protected
- [ ] Cleanup failure is logged but does not fail the daemon
- [ ] Existing resource lifecycle and health tests pass
- [ ] Type, MCP compatibility, runtime architecture, and Controller V8 checks pass
- [ ] Main is committed and clean

## GitHub

- Not published.

## Tasks

### T1 — Complete bounded automatic runtime GC

- Status: `verified`
- Objective: Review and complete the current main working tree changes. Add daemon-owned startup/periodic bounded GC for repo-harness temp directories using existing safe cleanup primitives, add regression tests, run focused and package checks, commit on main, then restart to the latest commit and verify readiness.
- Depends on: none
- Allowed paths: `src/runtime/**`, `src/cli/**`, `tests/runtime/**`, `tests/cli/**`, `docs/architecture/current/**`, `tasks/notes/**`
- Checks: `package:check:type`, `package:check:mcp-compatibility`, `package:check:runtime-architecture`, `package:check:controller-v8`
- Execution hint: agent / codex

## Related Artifacts

- `commits: f426ce9c99700463762e26260e7e11825bddc49f and follow-up sourceRevision normalization`
- `historical Issue ISS-20260716-34A906`
