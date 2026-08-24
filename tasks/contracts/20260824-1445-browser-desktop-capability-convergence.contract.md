# Task Contract: browser-desktop-capability-convergence

> **Status**: Active
> **Plan**: plans/plan-20260824-1445-browser-desktop-capability-convergence.md
> **Task Profile**: code-change
> **Owner**: greyson
> **Capability ID**: root
> **Last Updated**: 2026-08-24 14:45
> **Review File**: `tasks/reviews/20260824-1445-browser-desktop-capability-convergence.review.md`
> **Notes File**: `tasks/notes/20260824-1445-browser-desktop-capability-convergence.notes.md`

## Goal

Make Browser the single semantic/session authority for silent reuse of live user browser tabs, keep Desktop Operator as the bounded macOS execution broker, and make both sides restart-safe and capability-compatible under source installation.

## Scope

- In scope: Browser Controller Home session authority, legacy repo-session import, native-tab deduplication, bounded listing, fail-closed attach, Desktop Operator capability handshake/session reconciliation/environment isolation, focused docs/tests, source install and live probes.
- Out of scope: merging Desktop Operator into Forge Runtime, publishing a formal provider release, adding another daemon/readiness authority, or treating ChatGPT consultation transcripts as Browser interaction sessions.

## Workflow Inventory

- Source plan: `plans/plan-20260824-1445-browser-desktop-capability-convergence.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260824-1445-browser-desktop-capability-convergence.review.md`
- Notes file: `tasks/notes/20260824-1445-browser-desktop-capability-convergence.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion evidence: `scripts/verify-sprint.sh` reports this contract's direct checks and declared scope. Then perform a fresh semantic impact review.

## Allowed Paths

```yaml
allowed_paths:
  - docs/spec.md
  - docs/architecture/
  - docs/reference-configs/
  - plans/
  - tasks/todos.md
  - tasks/contracts/20260824-1445-browser-desktop-capability-convergence.contract.md
  - tasks/reviews/20260824-1445-browser-desktop-capability-convergence.review.md
  - tasks/notes/20260824-1445-browser-desktop-capability-convergence.notes.md
  - .ai/context/capabilities.json
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
    - docs/spec.md
    - src/runtime/plugins/browser-session-authority.ts
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260824-1445-browser-desktop-capability-convergence.notes.md
  tests_pass:
    - path: tests/runtime/browser-session-authority.test.ts
    - path: tests/runtime/macos-capability-broker.test.ts
  commands_succeed:
    - bun run check:type
    - bun run check:task
    - bash scripts/check-task-workflow.sh --strict
```

## Acceptance Notes (Human Review)

- Functional behavior: native sessions survive Runtime/provider restarts through reconciliation, repeated adoption reuses one canonical identity, and silent attach never opens a managed browser unless explicitly configured.
- Edge cases: stale native tab identities become unverified/tombstoned without destroying user tabs; managed sessions remain repository-bound; provider restart invalidates AX and visual evidence while retaining a stable application binding.
- Regression risks: Browser adapter has broad call paths and Node bridge execution; verify direct and bridged inputs retain Controller Home, and preserve repo-local profile/artifact placement.

## Rollback Point

- Commit / checkpoint: source branch `codex/browser-desktop-capability-convergence` from `d1da593be` plus the independent clean Desktop Operator source checkout.
- Revert strategy: revert the localized Forge branch changes and Desktop Operator source changes; reinstall the previous app bundle only if live verification requires operational rollback.
