# Task Contract: forge-recent-work-closeout

> **Status**: Fulfilled
> **Plan**: plans/plan-20260824-1435-forge-recent-work-closeout.md
> **Task Profile**: code-change
> **Owner**: greyson
> **Capability ID**: root
> **Last Updated**: 2026-08-24 14:36
> **Review File**: `tasks/reviews/20260824-1435-forge-recent-work-closeout.review.md`
> **Notes File**: `tasks/notes/20260824-1435-forge-recent-work-closeout.notes.md`

## Goal

Close the audited recent Forge work by repairing the four remaining correctness gaps, proving current release/baseline gates, and reconciling stale deferred items without adding duplicate authorities.

## Scope

- In scope: Standalone Recovery Connector-capacity escalation; complete ExecutionJob active/request rebuild; partial adoption manifests and no-litter restore; current-status freshness enforcement; focused/repository/release/baseline verification; task artifact reconciliation.
- Out of scope: new lifecycle/readiness owners, a second goal identity, reactivating retired Local Bridge or ExecutionJob creation, a new tool-surface event bus, forced macOS TCC mutation, or redesigning the package installer for an obsolete `bun add` path.

## Workflow Inventory

- Source plan: `plans/plan-20260824-1435-forge-recent-work-closeout.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260824-1435-forge-recent-work-closeout.review.md`
- Notes file: `tasks/notes/20260824-1435-forge-recent-work-closeout.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion evidence: `scripts/verify-sprint.sh` reports this contract's direct checks and declared scope. Then perform a fresh semantic impact review.

## Allowed Paths

```yaml
allowed_paths:
  - docs/spec.md
  - plans/
  - tasks/todos.md
  - tasks/contracts/20260824-1435-forge-recent-work-closeout.contract.md
  - tasks/reviews/20260824-1435-forge-recent-work-closeout.review.md
  - tasks/notes/20260824-1435-forge-recent-work-closeout.notes.md
  - .ai/context/capabilities.json
  - .claude/templates/
  - .ai/harness/active-plan
  - .ai/harness/active-worktree
  - .claude/.active-plan
  - assets/hooks/session-start-context.sh
  - scripts/
  - src/
  - tests/
  - tasks/current.md
  - tasks/notes/20260811-forge-residual-runtime-issues.notes.md
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
    - docs/spec.md
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260824-1435-forge-recent-work-closeout.notes.md
  tests_pass:
    - path: tests/runtime/standalone-recovery.test.ts
    - path: tests/runtime/execution-job-reconciliation.test.ts
    - path: tests/cli/init.test.ts
    - path: tests/sprint-backlog.test.ts
  commands_succeed:
    - bun run test
    - bun run check:task
    - bash scripts/check-task-workflow.sh --strict
    - bash scripts/check-tarball-install-smoke.sh
    - bun run check:stable-baseline -- --controller-home /Users/greyson/.forge/controller
```

## Acceptance Notes (Human Review)

- Functional behavior: each real source gap has a direct regression and previously-completed/obsolete items close by source evidence.
- Edge cases: >5,000 historical Jobs, first-operation/partial adoption failure, post-apply user edits, missing/malformed Gateway capacity JSON, expired/malformed status timestamps.
- Regression risks: Recovery must reuse existing Connector budgets; recent-history reads remain bounded; manifests remain path-fenced and rollback remains hash-fenced.

## Rollback Point

- Commit / checkpoint: branch `codex/forge-recent-work-closeout` from `d1da593be`.
- Revert strategy: revert this branch aggregate; live stable-baseline receipts are immutable operational evidence and do not alter Runtime state.
