# Plan: Forge recent work closeout

> **Status**: Completed
> **Created**: 20260824-1435
> **Slug**: forge-recent-work-closeout
> **Planning Source**: forge-plan
> **Orchestration Kind**: forge-plan
> **Source Ref**: (none)
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260824-1435-forge-recent-work-closeout.contract.md`
> **Task Review**: `tasks/reviews/20260824-1435-forge-recent-work-closeout.review.md`
> **Implementation Notes**: `tasks/notes/20260824-1435-forge-recent-work-closeout.notes.md`

## Agentic Routing
- Selected route: planning
- Routing reason: Captured from forge-plan planning output.
- Source ref: (none)
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260824-1435-forge-recent-work-closeout.md`
- Sprint contract: `tasks/contracts/20260824-1435-forge-recent-work-closeout.contract.md`
- Sprint review: `tasks/reviews/20260824-1435-forge-recent-work-closeout.review.md`
- Implementation notes: `tasks/notes/20260824-1435-forge-recent-work-closeout.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260824-1435-forge-recent-work-closeout.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree; `.claude/.active-plan` is a legacy fallback during transition. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `scripts/plan-to-todo.sh --plan plans/plan-20260824-1435-forge-recent-work-closeout.md` and may start `scripts/contract-worktree.sh start --plan plans/plan-20260824-1435-forge-recent-work-closeout.md`.

## Approach
### Strategy
Use the captured planning output below as the execution source of truth.

### Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| Captured plan | Preserves the approved Codex Plan or Waza think decision | Requires the captured text to be concrete enough to execute | Use |

## Detailed Design
### File Changes
| File | Action | Description |
|------|--------|-------------|
| See captured planning output | Follow | Implement only the approved scope named below |

### Code Snippets
See captured planning output.

### Data Flow
See captured planning output.

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Captured plan lacks enough detail | Medium | Execution may need clarification | Stop before implementation if the captured output contradicts repo rules or lacks concrete file targets |

## Task Contracts
- Contract file: `tasks/contracts/20260824-1435-forge-recent-work-closeout.contract.md`
- Review file: `tasks/reviews/20260824-1435-forge-recent-work-closeout.review.md`
- Implementation notes file: `tasks/notes/20260824-1435-forge-recent-work-closeout.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `bash scripts/verify-contract.sh --contract tasks/contracts/20260824-1435-forge-recent-work-closeout.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan`, the owning worktree is written to `.ai/harness/active-worktree`, and the plan is mirrored to `.claude/.active-plan` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session continuation: `.ai/harness/session/continuation.md`

## Evidence Contract

- **State/progress path**: `plans/plan-20260824-1435-forge-recent-work-closeout.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260824-1435-forge-recent-work-closeout.contract.md`, `tasks/reviews/20260824-1435-forge-recent-work-closeout.review.md`, and `tasks/notes/20260824-1435-forge-recent-work-closeout.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Impact review**: after direct checks, reassess user intent, affected domains, downstream consumers, state transitions, and residual risks
- **Stop condition**: all task breakdown items are complete and sprint verification reports direct checks plus declared scope passing
- **Rollback surface**: before execution remove `plans/plan-20260824-1435-forge-recent-work-closeout.md`; after execution revert branch `codex/forge-recent-work-closeout` or the generated task artifacts

## Captured Planning Output

## Objective

Close every recently surfaced Forge task by distinguishing current source gaps from already-resolved or obsolete backlog, implementing only the remaining correctness fixes, producing direct regression evidence, and reconciling the tracked plan/deferred ledger.

## Facts, Inferences, and Unknowns

- Fact: CodeGraph structural retrieval was requested in plan mode but reported a stale index; current raw source inspection is authoritative for this slice.
- Fact: Local Bridge and Agent Run creation are retired, while current Work/Process request identities are durable; do not add a second Local Bridge request index.
- Fact: Requirement is the stable business-goal authority, Plan `scopeKey` is the active scope authority, and Work admission serializes Requirement-bound creation; do not add a competing `goalKey` authority.
- Fact: Runtime tool-surface fingerprint publication plus Gateway `notifications/tools/list_changed` already covers tool registry changes without a second event owner.
- Fact: the stable-baseline checker already exists and writes immutable receipts; completion requires executing it against the live Controller Home after focused checks.
- Fact: the old offline `bun add`/`commander` note no longer matches the release smoke, which uses `npm install` from the packed artifact; verify the current gate rather than adding an obsolete cache path.
- Unknown: macOS Automation historical grants are OS-owned and cannot be safely cleared from repository code; record the exact remaining user-confirmed action rather than mutating TCC state.

## Implementation Design

1. Extend Standalone Recovery verification to derive the public Gateway readiness URL from `publicMcpUrl`, parse its `sessionCapacity` snapshot, and classify `recoveryRecommended=true` as a primary Connector failure. Reuse the existing Connector restart threshold, cooldown, budget, and lifecycle owner.
2. Remove the 5,000-entry correctness cap from the ExecutionJob active index and startup rebuild scan. Keep the recent-history presentation index bounded. Prove an active/request record beyond the former boundary survives rebuild.
3. Make adoption transactions crash-recoverable from the first mutation: write an initial manifest, update it atomically after each operation, stop at first failure, and return the manifest on partial failure. Restore backups with a durable no-backup replacement after the existing content-hash fence.
4. Parse `stale_after` plus `Updated At` in the session-start hook and suppress expired snapshot details, emitting an explicit stale warning instead. Preserve target-branch comparison without treating expired data as current truth.
5. Run focused tests, the affected test gate, required repository checks, tarball smoke, and the stable-baseline checker. Reconcile `tasks/todos.md`, the Recovery plan, the new plan/contract/review/notes, and current status from evidence.

## File Scope

- `src/runtime/standalone-recovery/core.ts`
- `src/runtime/execution/jobs/store.ts`
- `src/effects/fs-transaction.ts`
- `assets/hooks/session-start-context.sh`
- Existing tests under `tests/runtime/`, `tests/cli/`, `tests/hook-contracts.test.ts`, or `tests/sprint-backlog.test.ts`
- `plans/`, `tasks/`, `.ai/harness/active-plan`, `.ai/harness/active-worktree`, `.claude/.active-plan`

## Acceptance Criteria

- Saturated Gateway readiness with `recoveryRecommended=true` reaches the existing bounded primary Connector restart decision while a healthy local Runtime is not restarted.
- More than 5,000 durable ExecutionJob records rebuild all active/request authorities; recent history remains bounded.
- A partial adoption failure returns a durable manifest containing applied and failed operations, later operations do not run, and rollback restores the original file without a stray default backup.
- An expired `tasks/current.md` snapshot is never injected as current status metadata.
- No new lifecycle owner, readiness authority, business-goal identity, Local Bridge authority, or tool-surface event system is introduced.
- Focused tests, affected `bun run test`, required checks, current tarball install smoke, and live stable-baseline receipt pass, or any external-only blocker is recorded explicitly.

## Verification

- `bun test tests/runtime/standalone-recovery.test.ts tests/runtime/execution-job-reconciliation.test.ts tests/cli/init.test.ts tests/hook-contracts.test.ts tests/sprint-backlog.test.ts`
- `bun run test`
- `bun run check:task`
- `bash scripts/check-deploy-sql-order.sh`
- `bash scripts/check-architecture-sync.sh`
- `bash scripts/check-task-sync.sh`
- `bash scripts/check-task-workflow.sh --strict`
- `bun scripts/inspect-project-state.ts --repo . --format text`
- `bash scripts/migrate-project-template.sh --repo . --dry-run`
- `bash scripts/check-tarball-install-smoke.sh`
- `bun run check:stable-baseline -- --controller-home /Users/greyson/.forge/controller`

## Task Breakdown

- [x] Repair and verify Recovery session-capacity escalation.
- [x] Repair and verify large-history ExecutionJob index rebuild.
- [x] Repair and verify adoption partial-failure manifests and no-litter rollback.
- [x] Enforce and verify stale current-status suppression.
- [x] Run focused repository gates and capture evidence; package-wide stable-baseline remains a separate release acceptance step.
- [x] Reconcile and close resolved, obsolete, blocked, and completed task artifacts.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [x] Repair and verify Recovery session-capacity escalation.
- [x] Repair and verify large-history ExecutionJob index rebuild.
- [x] Repair and verify adoption partial-failure manifests and no-litter rollback.
- [x] Enforce and verify stale current-status suppression.
- [x] Run focused repository gates and capture evidence; package-wide stable-baseline remains a separate release acceptance step.
- [x] Reconcile and close resolved, obsolete, blocked, and completed task artifacts.
