# Task Contract: quality-first-executable-harness

> **Status**: Fulfilled
> **Plan**: plans/plan-20260818-1535-quality-first-executable-harness.md
> **Task Profile**: code-change
> **Owner**: greyson
> **Capability ID**: root
> **Last Updated**: 2026-08-18 19:05
> **Review File**: `tasks/reviews/20260818-1535-quality-first-executable-harness.review.md`
> **Notes File**: `tasks/notes/20260818-1535-quality-first-executable-harness.notes.md`

## Goal

Make Forge a thinner quality-first execution layer: progressive `rh_context`
retrieval, continuity-based routing, explicit Ephemeral/Lightweight/Durable
execution lanes, expandable scope evidence, reduced compatibility/state
authority, and responsibility-based decomposition without weakening safety.

## Scope

- In scope: Context Plane retrieval/cache/materialization, command/check lanes,
  route policy, Work scope evidence, public MCP compatibility cleanup,
  architecture documentation, focused regressions, and latency benchmarks.
- Out of scope: browser/device adapter decomposition without physical screenshot
  and sibling verification; whole legacy full-profile version removal; production
  Runtime activation, release, push, or publication.

## Workflow Inventory

- Source plan: `plans/plan-20260818-1535-quality-first-executable-harness.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260818-1535-quality-first-executable-harness.review.md`
- Notes file: `tasks/notes/20260818-1535-quality-first-executable-harness.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: `scripts/verify-sprint.sh` must see this contract pass, the review recommend pass, and `## External Acceptance Advice` pass or record a manual override.

## Allowed Paths

```yaml
allowed_paths:
  - docs/spec.md
  - docs/architecture/
  - docs/researches/
  - plans/
  - package.json
  - scripts/
  - SKILL.md
  - tasks/todos.md
  - tasks/current.md
  - tasks/contracts/20260818-1535-quality-first-executable-harness.contract.md
  - tasks/reviews/20260818-1535-quality-first-executable-harness.review.md
  - tasks/notes/20260818-1535-quality-first-executable-harness.notes.md
  - .ai/context/capabilities.json
  - .ai/harness/checks/
  - .ai/harness/runs/
  - .claude/templates/
  - src/
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
    - docs/architecture/current/quality-first-executable-harness.md
    - docs/researches/20260818-authority-compatibility-audit.md
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260818-1535-quality-first-executable-harness.notes.md
  tests_pass:
    - path: tests/runtime/codegraph-context-provider.test.ts
    - path: tests/runtime/route-policy.test.ts
    - path: tests/runtime/repository-command-lifecycle.test.ts
    - path: tests/runtime/process-runtime.test.ts
    - path: tests/runtime/thin-harness-gateway-routing.test.ts
    - path: tests/cli/mcp-controller.test.ts
  commands_succeed:
    - bun run check:type
    - bun run check:task
    - bash scripts/check-deploy-sql-order.sh
    - bash scripts/check-architecture-sync.sh
    - bash scripts/check-task-sync.sh
    - bash scripts/check-task-workflow.sh --strict
  qa_scores:
    - dimension: functionality
      min: 7
  manual_checks:
    - "Evaluator review file recommends pass"
```

## Acceptance Notes (Human Review)

- Functional behavior: repeated context expansion reuses source-identity caches;
  ordinary commands do not acquire durable Process/Lease authority; durable
  external boundaries never auto-replay ambiguous effects.
- Edge cases: exact known path under tight budgets, whole-symbol retrieval,
  stale graph hints, dirty overlays, request-id conflicts, explicit Plan/Work,
  remote/destructive effects, and scope evidence expansion.
- Regression risks: legacy full-profile consumers, Work-bound check receipt
  reuse, Process attach semantics, and architecture/task workflow sync.

## Rollback Point

- Commit / checkpoint: coherent local phase commits on
  `codex/quality-first-executable-harness` after final verification.
- Revert strategy: revert those local commits; no runtime activation or remote
  publication is part of this slice.
