# Plan: Controller Durable Plan Contract

> **Status**: Completed
> **Created**: 20260724-1014
> **Slug**: plan-contract
> **Planning Source**: codex-plan
> **Orchestration Kind**: host-plan
> **Source Ref**: (none)
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260724-1014-plan-contract.contract.md`
> **Task Review**: `tasks/reviews/20260724-1014-plan-contract.review.md`
> **Implementation Notes**: `tasks/notes/20260724-1014-plan-contract.notes.md`

## Agentic Routing
- Selected route: architecture-runtime
- Routing reason: Captured from codex-plan planning output.
- Source ref: (none)
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260724-1014-plan-contract.md`
- Sprint contract: `tasks/contracts/20260724-1014-plan-contract.contract.md`
- Sprint review: `tasks/reviews/20260724-1014-plan-contract.review.md`
- Implementation notes: `tasks/notes/20260724-1014-plan-contract.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260724-1014-plan-contract.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree; `.claude/.active-plan` is a legacy fallback during transition. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `scripts/plan-to-todo.sh --plan plans/plan-20260724-1014-plan-contract.md` and may start `scripts/contract-worktree.sh start --plan plans/plan-20260724-1014-plan-contract.md`.

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
- Contract file: `tasks/contracts/20260724-1014-plan-contract.contract.md`
- Review file: `tasks/reviews/20260724-1014-plan-contract.review.md`
- Implementation notes file: `tasks/notes/20260724-1014-plan-contract.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `bash scripts/verify-contract.sh --contract tasks/contracts/20260724-1014-plan-contract.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan`, the owning worktree is written to `.ai/harness/active-worktree`, and the plan is mirrored to `.claude/.active-plan` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Evidence Contract

- **State/progress path**: `plans/plan-20260724-1014-plan-contract.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260724-1014-plan-contract.contract.md`, `tasks/reviews/20260724-1014-plan-contract.review.md`, and `tasks/notes/20260724-1014-plan-contract.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260724-1014-plan-contract.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: before execution remove `plans/plan-20260724-1014-plan-contract.md`; after execution revert branch `codex/plan-contract` or the generated task artifacts

## Captured Planning Output

# Controller Durable PlanContract — Phase 1

## Goal
Make planning a durable, controller-owned pre-execution contract for complex work so a resumed ChatGPT session cannot silently reinterpret scope before execution.

## Confirmed Evidence
- `WorkContract` is an execution-level record; it starts as `running` for Goal Workloop but does not record the approved plan or source revision.
- `GoalContract` owns autonomous objective routing and cannot become a second execution plan without duplicating Campaign and Work lifecycles.
- The five-tool facade is intentionally stable; adding another top-level MCP tool would worsen discovery cost.
- `rh_work.start` currently accepts complex work directly, so a plan must gate WorkContract creation rather than merely render a checklist.

## Decisions
1. Add a separate durable `PlanContract` store beside the WorkContract store. It owns plan metadata and steps; it never owns worker or worktree lifecycle.
2. Keep the public facade to five tools. Expose plan operations as `rh_work` suboperations: `plan_create`, `plan_get`, `plan_list`, `plan_approve`, and `plan_supersede`.
3. Bind an approved plan to a frozen source revision string. For this phase, callers provide the revision already observed in preflight; execution linkage is additive and deferred until dispatch exists.
4. Plan creation is read-only controller metadata. `plan_approve` requires concrete step acceptance checks and exactly one active plan per normalized scope key.
5. Do not force all work through plans. Direct small work remains supported. This phase creates the persistence and validation seam for later `plan_execute`, `replan`, and runtime reliability work.

## Scope
- Add PlanContract types, store, state transition validation, bounded summaries, and tests.
- Wire compact PlanContract operations into existing `rh_work` without adding facade tools.
- Update current architecture documentation and task workflow artifacts.

## Non-goals
- Do not change worker dispatch, lease reconciliation, Campaign, GoalContract, or WorkContract execution status transitions.
- Do not implement automatic replan approval, plan execution, commit/merge/cleanup automation, or historical state migration.
- Do not modify `_ops/` or active production runtime state.

## Acceptance Criteria
- [ ] A complex plan can be created, read, listed, approved, and superseded through `rh_work` while the top-level facade remains five tools.
- [ ] Plan approval rejects missing source revision, missing checks, non-pending dependencies, duplicate step IDs, and an overlapping active scope.
- [ ] Only legal PlanContract state transitions are accepted; terminal plans cannot be approved or superseded again.
- [ ] Plan responses are bounded summaries by default and preserve revision, scope, steps, stop/replan conditions, and evidence references.
- [ ] Existing `rh_work` start/continue/verify/finalize behavior remains covered by focused regression tests.

## Task Breakdown
- [x] Define PlanContract state, validation rules, and persistent store with targeted tests.
- [x] Add compact `rh_work` PlanContract operations without expanding the five-tool facade.
- [x] Document the PlanContract to WorkContract boundary and synchronize task state.
- [x] Run focused tests, required checks, and review failures before closeout.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [x] Define PlanContract state, validation rules, and persistent store with targeted tests.
- [x] Add compact `rh_work` PlanContract operations without expanding the five-tool facade.
- [x] Document the PlanContract to WorkContract boundary and synchronize task state.
- [x] Run focused tests, required checks, and review failures before closeout.
