# Task Contract: 20260801-round2-performance-reliability-runtime

> **Status**: Fulfilled
> **Plan**: plans/plan-20260801-2053-20260801-round2-performance-reliability-runtime.md
> **Task Profile**: code-change
> **Owner**: greyson
> **Capability ID**: root
> **Last Updated**: 2026-08-01 20:53
> **Review File**: `tasks/reviews/20260801-2053-20260801-round2-performance-reliability-runtime.review.md`
> **Notes File**: `tasks/notes/20260801-2053-20260801-round2-performance-reliability-runtime.notes.md`

## Goal

Implement the approved round-two reliability and runtime convergence slices in an isolated worktree while preserving the dirty user worktree: supervisor stale-release/duplicate-daemon recovery, keyed controller-context SWR, local MCP evidence, scheduler/process idle-resource bounds, session cache lifecycle, and repeatable benchmark output.

## Scope

- In scope:
  - `src/runtime/supervisor/`
  - `src/runtime/projections/`
  - `src/runtime/gateway/mcp/`
  - `src/runtime/control-plane/global-scheduler/`
  - `src/runtime/execution/process-runtime/`
  - `src/cli/repository/`
  - `src/cli/mcp/transports/`
  - `scripts/benchmark-controller-round2.ts`
  - round-two tests under `tests/runtime/` and `tests/cli/`
- Out of scope:
  - restoring user-deleted tests
  - editing the dirty primary worktree
  - changing authorization boundaries or introducing SQLite/JSON dual-write authority

## Workflow Inventory

- Source plan: `plans/plan-20260801-2053-20260801-round2-performance-reliability-runtime.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260801-2053-20260801-round2-performance-reliability-runtime.review.md`
- Notes file: `tasks/notes/20260801-2053-20260801-round2-performance-reliability-runtime.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: `scripts/verify-sprint.sh` must see this contract pass, the review recommend pass, and `## External Acceptance Advice` pass or record a manual override.

## Allowed Paths

```yaml
allowed_paths:
  - docs/spec.md
  - plans/
  - tasks/todos.md
  - tasks/contracts/20260801-2053-20260801-round2-performance-reliability-runtime.contract.md
  - tasks/reviews/20260801-2053-20260801-round2-performance-reliability-runtime.review.md
  - tasks/notes/20260801-2053-20260801-round2-performance-reliability-runtime.notes.md
  - .ai/context/capabilities.json
  - .claude/templates/
  - src/
  - scripts/benchmark-controller-round2.ts
  - tests/
```

## Delegation Contract

```yaml
delegation:
  budget:
    tokens: null
    tool_calls: null
    wall_time_minutes: null
  permission_scope:
    mode: inherit_allowed_paths
    writable_paths: []
    network: inherited
  roles:
    parent:
      mode: narrate_and_gatekeep
      purpose: approval_checkpoint_owner
    explorer:
      mode: read_only
      purpose: codebase_research
    worker:
      mode: edit_within_allowed_paths
      purpose: implementation
    verifier:
      mode: read_only
      purpose: exit_criteria_review
```

## Exit Criteria (Machine Verifiable)

```yaml
exit_criteria:
  files_exist:
    - plans/plan-20260801-2053-20260801-round2-performance-reliability-runtime.md
    - scripts/benchmark-controller-round2.ts
  artifacts_exist:
    - tasks/notes/20260801-2053-20260801-round2-performance-reliability-runtime.notes.md
  tests_pass:
    - path: tests/runtime/controller-context-projection-round2.test.ts
    - path: tests/runtime/mcp-e2e-round2.test.ts
    - path: tests/runtime/process-runtime-round2.test.ts
    - path: tests/cli/session-cache-round2.test.ts
  commands_succeed:
    - bun run check:type
    - bun test tests/cli/mcp-controller.test.ts
    - bun test tests/runtime/scheduler-heartbeat.test.ts tests/runtime/scheduler-capacity.test.ts tests/runtime/process-runtime.test.ts
  qa_scores:
    - dimension: functionality
      min: 7
  manual_checks:
    - "Evaluator review file recommends pass"
```

## Acceptance Notes (Human Review)

- Functional behavior:
- Edge cases:
- Regression risks:

## Rollback Point

- Commit / checkpoint:
- Revert strategy:
