# Plan: Forge Workflow Lifecycle Closeout P0

> **Status**: Completed
> **Created**: 20260824-1440
> **Slug**: workflow-lifecycle-closeout-p0
> **Planning Source**: forge-plan
> **Orchestration Kind**: repair
> **Source Ref**: (none)
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260824-1440-workflow-lifecycle-closeout-p0.contract.md`
> **Task Review**: `tasks/reviews/20260824-1440-workflow-lifecycle-closeout-p0.review.md`
> **Implementation Notes**: `tasks/notes/20260824-1440-workflow-lifecycle-closeout-p0.notes.md`

## Agentic Routing
- Selected route: repair
- Routing reason: Captured from forge-plan planning output.
- Source ref: (none)
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260824-1440-workflow-lifecycle-closeout-p0.md`
- Sprint contract: `tasks/contracts/20260824-1440-workflow-lifecycle-closeout-p0.contract.md`
- Sprint review: `tasks/reviews/20260824-1440-workflow-lifecycle-closeout-p0.review.md`
- Implementation notes: `tasks/notes/20260824-1440-workflow-lifecycle-closeout-p0.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260824-1440-workflow-lifecycle-closeout-p0.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree; `.claude/.active-plan` is a legacy fallback during transition. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `scripts/plan-to-todo.sh --plan plans/plan-20260824-1440-workflow-lifecycle-closeout-p0.md` and may start `scripts/contract-worktree.sh start --plan plans/plan-20260824-1440-workflow-lifecycle-closeout-p0.md`.

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
- Contract file: `tasks/contracts/20260824-1440-workflow-lifecycle-closeout-p0.contract.md`
- Review file: `tasks/reviews/20260824-1440-workflow-lifecycle-closeout-p0.review.md`
- Implementation notes file: `tasks/notes/20260824-1440-workflow-lifecycle-closeout-p0.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `bash scripts/verify-contract.sh --contract tasks/contracts/20260824-1440-workflow-lifecycle-closeout-p0.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan`, the owning worktree is written to `.ai/harness/active-worktree`, and the plan is mirrored to `.claude/.active-plan` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session continuation: `.ai/harness/session/continuation.md`

## Evidence Contract

- **State/progress path**: `plans/plan-20260824-1440-workflow-lifecycle-closeout-p0.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260824-1440-workflow-lifecycle-closeout-p0.contract.md`, `tasks/reviews/20260824-1440-workflow-lifecycle-closeout-p0.review.md`, and `tasks/notes/20260824-1440-workflow-lifecycle-closeout-p0.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Impact review**: after direct checks, reassess user intent, affected domains, downstream consumers, state transitions, and residual risks
- **Stop condition**: all task breakdown items are complete and sprint verification reports direct checks plus declared scope passing
- **Rollback surface**: before execution remove `plans/plan-20260824-1440-workflow-lifecycle-closeout-p0.md`; after execution revert branch `codex/workflow-lifecycle-closeout-p0` or the generated task artifacts

## Captured Planning Output

# Forge Workflow Lifecycle Closeout P0

## Goal

Make Forge task execution converge to one truthful terminal outcome across Canonical Work, Controller Session, Git worktree/branch state, Completion Receipt, Task/Plan projection, and host-session continuation. Forge must never report Idle, ready, or completed while owned dirty work, unintegrated delivery, stale active ownership, or an incomplete completion receipt remains.

## Success criteria

1. A read-only lifecycle audit detects unregistered managed worktrees, dirty orphan worktrees, unique unmerged Work commits, terminal Work with stale session ownership, receipt revision mismatches, and missing host hook readiness.
2. `tasks/current.md` and Runtime/Workbench projections cannot conclude Idle when the audit has actionable lifecycle findings.
3. A Work can become completed only after exact delivery revision reachability, target integration, required checks, completion receipt persistence, and explicit cleanup disposition.
4. Cancelled retained Work can resume only through explicit same-principal user reauthorization with exact checkout/base-revision proof.
5. Every controller round with active Work records an explicit disposition: continue, wait, finalize, or cancel. SessionStart reads Canonical Runtime state before Markdown recovery caches.
6. Existing dirty managed worktrees and unmerged branches are preserved until separately reviewed; this slice performs no destructive cleanup.

## Scope

- Canonical lifecycle audit and repository projection attention.
- Work finalization receipt, merge retry, terminal cleanup, and cancelled Work resume.
- Stop/SessionStart workflow adapter behavior and installed asset parity.
- Focused failure-injection tests and required Forge checks.
- Durable task/current/notes/review synchronization for this slice.

## Non-scope

- Deleting or force-cleaning historical worktrees or branches.
- Adding a second lifecycle authority, daemon, watchdog, or durable status store.
- Reworking unrelated Runtime recovery, OAuth, tunnel, plugin, or UI behavior.
- Automatically merging semantically ambiguous legacy changes.

## Architecture decisions

1. Canonical Runtime remains the only lifecycle authority. The lifecycle audit is a derived read-only conclusion over existing authority plus Git facts; it owns no mutations.
2. Git delivery is part of Work completion truth. A worker commit named Complete is not terminal evidence unless its delivery revision is reachable from the target branch and the receipt records that exact revision.
3. Host hooks are accelerators and backstops. The semantic controller records disposition through the existing Work surface; hooks only detect missing disposition and inject/resume exact context.
4. Dirty or ambiguous state fails closed into attention. It is preserved, not silently cancelled or removed.
5. Existing stranded fixes are reviewed and adapted to current main rather than blindly cherry-picked.

## Task Breakdown

- [x] T1 — Add lifecycle audit facts and projection attention for Git/Work/Session/receipt divergence.
- [x] T2 — Correct Completion Receipt delivery identity and finalizer merge retry semantics.
- [x] T3 — Add explicit retained-cancelled Work reauthorization and safe checkout reconstruction.
- [x] T4 — Require end-of-round disposition and make SessionStart prefer Canonical Runtime continuation.
- [x] T5 — Add failure-injection coverage, run Forge review and required checks, then integrate the isolated branch.

## Evidence Contract

- Focused tests must cover dirty orphan worktree, unique unmerged branch, stale active session, wrong receipt source revision, cancelled Work resume, merge-conflict retry, missing disposition, and restart/session handoff.
- `bun test tests/runtime/work-terminal-cleanup.test.ts tests/runtime/work-task-receipt.test.ts tests/hook-runtime.test.ts tests/hook-contracts.test.ts tests/workflow-contract.test.ts` passes without retry-only success.
- Root required checks pass.
- Final Git evidence proves the delivered revision is reachable from `main` and pre-existing dirty managed worktrees are unchanged.

## Rollback and failure handling

- Source rollback is the aggregate isolated-branch commit/revert; no schema migration is introduced.
- Any ambiguous legacy work remains attention-only and is never auto-cleaned.
- If current main has superseded a stranded fix, retain the current implementation and port only the missing invariant plus tests.
- If hook trust is unavailable, Runtime truth and explicit CLI diagnostics remain usable; readiness reports host automation degraded.

## Phase independence

- T1 can land without mutation authority and immediately prevents false green projections.
- T2 and T3 are independent lifecycle corrections guarded by focused tests.
- T4 consumes existing canonical lifecycle/disposition surfaces and does not add persistent state.
- T5 validates all earlier phases and is the only integration step.

## Stop condition

Stop and preserve all state if implementation would require deleting a dirty worktree, overwriting an unmerged branch, changing Controller Home authority, or adding a new lifecycle owner.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [x] T1 — Add lifecycle audit facts and projection attention for Git/Work/Session/receipt divergence.
- [x] T2 — Correct Completion Receipt delivery identity and finalizer merge retry semantics.
- [x] T3 — Add explicit retained-cancelled Work reauthorization and safe checkout reconstruction.
- [x] T4 — Require end-of-round disposition and make SessionStart prefer Canonical Runtime continuation.
- [x] T5 — Add failure-injection coverage, run Forge review and required checks, then integrate the isolated branch.
