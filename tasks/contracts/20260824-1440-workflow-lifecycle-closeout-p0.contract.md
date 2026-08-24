# Task Contract: workflow-lifecycle-closeout-p0

> **Status**: Fulfilled
> **Plan**: plans/plan-20260824-1440-workflow-lifecycle-closeout-p0.md
> **Task Profile**: code-change
> **Owner**: greyson
> **Capability ID**: root
> **Last Updated**: 2026-08-24 14:41
> **Review File**: `tasks/reviews/20260824-1440-workflow-lifecycle-closeout-p0.review.md`
> **Notes File**: `tasks/notes/20260824-1440-workflow-lifecycle-closeout-p0.notes.md`

## Goal

Make Forge task execution converge truthfully across Canonical Work, Controller Session, Git delivery/worktree state, Completion Receipt, Task/Plan projection, and host-session continuation. False Idle/Completed conclusions must become explicit lifecycle attention without deleting ambiguous work.

## Scope

- In scope: read-only lifecycle audit/projection attention; exact Work delivery receipts; retryable finalization; explicit retained-cancelled Work resume; Stop/SessionStart disposition and continuation guards; focused failure-injection tests; task/review/notes synchronization.
- Out of scope: deleting historical worktrees or branches; a second lifecycle owner or persistent state machine; unrelated Recovery/OAuth/tunnel/plugin/UI changes; automatically integrating ambiguous legacy code.

## Workflow Inventory

- Source plan: `plans/plan-20260824-1440-workflow-lifecycle-closeout-p0.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260824-1440-workflow-lifecycle-closeout-p0.review.md`
- Notes file: `tasks/notes/20260824-1440-workflow-lifecycle-closeout-p0.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion evidence: `scripts/verify-sprint.sh` reports this contract's direct checks and declared scope. Then perform a fresh semantic impact review.

## Allowed Paths

```yaml
allowed_paths:
  - plans/
  - tasks/todos.md
  - tasks/contracts/20260824-1440-workflow-lifecycle-closeout-p0.contract.md
  - tasks/reviews/20260824-1440-workflow-lifecycle-closeout-p0.review.md
  - tasks/notes/20260824-1440-workflow-lifecycle-closeout-p0.notes.md
  - assets/hooks/
  - scripts/refresh-current-status.sh
  - src/runtime/control-plane/
  - src/runtime/gateway/mcp/
  - src/runtime/projections/
  - src/cli/commands/
  - tests/hook-contracts.test.ts
  - tests/hook-runtime.test.ts
  - tests/runtime/work-task-receipt.test.ts
  - tests/runtime/work-terminal-cleanup.test.ts
  - tests/runtime/canonical-single-runtime.test.ts
  - tests/runtime/runtime-observability.test.ts
  - tests/workflow-contract.test.ts
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
    - plans/plan-20260824-1440-workflow-lifecycle-closeout-p0.md
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260824-1440-workflow-lifecycle-closeout-p0.notes.md
  tests_pass:
    - path: tests/runtime/work-task-receipt.test.ts
    - path: tests/runtime/work-terminal-cleanup.test.ts
    - path: tests/runtime/runtime-observability.test.ts
    - path: tests/hook-contracts.test.ts
  commands_succeed:
    - bun run check:task
    - bash scripts/check-task-workflow.sh --strict
    - bash scripts/check-task-sync.sh
```

## Acceptance Notes (Human Review)

- Functional behavior: one lifecycle conclusion covers Work/Session/Git/receipt facts; active Work has an explicit end-of-round disposition; safe resume retains exact identity.
- Edge cases: dirty orphan checkout, unique unmerged commit, merge conflict retry, cancelled retained checkout, missing checkout reconstructed only at exact zero-delta base, hooks disabled/untrusted.
- Regression risks: legacy compatibility projections may intentionally retain historical fields; avoid turning read-only attention into cleanup authority or widening Runtime readiness semantics.

## Rollback Point

- Commit / checkpoint: branch `codex/workflow-lifecycle-closeout-p0` from `d1da593be`.
- Revert strategy: revert the aggregate branch commit; no schema or destructive worktree mutation is allowed in this slice.
