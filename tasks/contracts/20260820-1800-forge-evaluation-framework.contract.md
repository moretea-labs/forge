# Task Contract: forge-evaluation-framework

> **Status**: Fulfilled
> **Plan**: `plans/plan-20260820-1800-forge-evaluation-framework.md`
> **Task Profile**: eval-only
> **Owner**: Codex
> **Capability ID**: root
> **Last Updated**: 2026-08-20 18:30
> **Review File**: `tasks/reviews/20260820-1800-forge-evaluation-framework.review.md`
> **Notes File**: `tasks/notes/20260820-1800-forge-evaluation-framework.notes.md`

## Goal

Create Forge's first repository-snapshot evaluation framework, so future
architecture changes can be compared for efficiency and engineering correctness
without running benchmark work against an active user repository.

## Scope

- In scope: `evaluation/`, a focused framework regression test, test governance registration, TypeScript inclusion, and task artifacts.
- Out of scope: Forge Runtime or context-architecture changes, autonomous agent orchestration, automatic benchmark generation, databases, production runs, release activation, and user-repository mutation.

## Workflow Inventory

- Source plan: `plans/plan-20260820-1800-forge-evaluation-framework.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260820-1800-forge-evaluation-framework.review.md`
- Notes file: `tasks/notes/20260820-1800-forge-evaluation-framework.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.

## Allowed Paths

```yaml
allowed_paths:
  - evaluation/
  - tsconfig.json
  - tests/evaluation-framework.test.ts
  - tests/test-manifest.v1.json
  - plans/plan-20260820-1800-forge-evaluation-framework.md
  - tasks/contracts/20260820-1800-forge-evaluation-framework.contract.md
  - tasks/reviews/20260820-1800-forge-evaluation-framework.review.md
  - tasks/notes/20260820-1800-forge-evaluation-framework.notes.md
  - tasks/current.md
```

## Exit Criteria (Machine Verifiable)

```yaml
exit_criteria:
  files_exist:
    - evaluation/README.md
    - evaluation/run.ts
    - evaluation/scenarios/forge-lightweight-terminal-receipt.json
  tests_pass:
    - path: tests/evaluation-framework.test.ts
  commands_succeed:
    - bun test tests/evaluation-framework.test.ts
    - bun run check:type
    - bun run check:task
    - bash scripts/check-deploy-sql-order.sh
    - bash scripts/check-architecture-sync.sh
    - bash scripts/check-task-sync.sh
    - bash scripts/check-task-workflow.sh --strict
    - bun scripts/inspect-project-state.ts --repo . --format text
    - bash scripts/migrate-project-template.sh --repo . --dry-run
  manual_checks:
    - "Review maps isolation, trace collection, validators, metrics, and the historical seed to the user goal."
```

## Acceptance Notes (Human Review)

- Functional behavior: a Scenario resolves an immutable Git snapshot to an isolated clone, invokes a configured Forge CLI inside that clone, records evidence and validation results, and emits JSON/Markdown reports only to an explicit external directory.
- Edge cases: invalid scenario schema, unavailable commit, command timeout/failure, source status changes during a run, and a report path that would modify the source repository.
- Regression risks: confusing the existing skill-prompt `evals/` benchmark with scenario evaluation, creating a second Runtime authority, or treating missing evidence as successful coverage.

## Rollback Point

- Commit / checkpoint: local working tree before this task's paths are added.
- Revert strategy: remove only this task's `evaluation/`, focused test/manifest entry, TypeScript inclusion, and task artifacts; no Runtime state exists to roll back.
