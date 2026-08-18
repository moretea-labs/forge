# Plan: Quality-first executable Forge harness

> **Status**: Completed
> **Created**: 20260818-1535
> **Slug**: quality-first-executable-harness
> **Planning Source**: codex-plan
> **Orchestration Kind**: contract-worktree
> **Source Ref**: docs/researches/20260818-quality-first-executable-harness-map.md
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260818-1535-quality-first-executable-harness.contract.md`
> **Task Review**: `tasks/reviews/20260818-1535-quality-first-executable-harness.review.md`
> **Implementation Notes**: `tasks/notes/20260818-1535-quality-first-executable-harness.notes.md`

## Agentic Routing
- Selected route: /direct
- Routing reason: Captured from codex-plan planning output.
- Source ref: docs/researches/20260818-quality-first-executable-harness-map.md
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260818-1535-quality-first-executable-harness.md`
- Sprint contract: `tasks/contracts/20260818-1535-quality-first-executable-harness.contract.md`
- Sprint review: `tasks/reviews/20260818-1535-quality-first-executable-harness.review.md`
- Implementation notes: `tasks/notes/20260818-1535-quality-first-executable-harness.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260818-1535-quality-first-executable-harness.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree; `.claude/.active-plan` is a legacy fallback during transition. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `scripts/plan-to-todo.sh --plan plans/plan-20260818-1535-quality-first-executable-harness.md` and may start `scripts/contract-worktree.sh start --plan plans/plan-20260818-1535-quality-first-executable-harness.md`.

## Approach
### Strategy
Use the captured planning output below as the execution source of truth.

### Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| Captured plan | Preserves the approved Forge /plan, Codex Plan, or optional external planning decision | Requires the captured text to be concrete enough to execute | Use |

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
- Contract file: `tasks/contracts/20260818-1535-quality-first-executable-harness.contract.md`
- Review file: `tasks/reviews/20260818-1535-quality-first-executable-harness.review.md`
- Implementation notes file: `tasks/notes/20260818-1535-quality-first-executable-harness.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `bash scripts/verify-contract.sh --contract tasks/contracts/20260818-1535-quality-first-executable-harness.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan`, the owning worktree is written to `.ai/harness/active-worktree`, and the plan is mirrored to `.claude/.active-plan` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session continuation: `.ai/harness/session/continuation.md`

## Evidence Contract

- **State/progress path**: `plans/plan-20260818-1535-quality-first-executable-harness.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260818-1535-quality-first-executable-harness.contract.md`, `tasks/reviews/20260818-1535-quality-first-executable-harness.review.md`, and `tasks/notes/20260818-1535-quality-first-executable-harness.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260818-1535-quality-first-executable-harness.review.md` must record a passing Forge /review recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: before execution remove `plans/plan-20260818-1535-quality-first-executable-harness.md`; after execution revert branch `codex/quality-first-executable-harness` or the generated task artifacts

## Captured Planning Output

## Objective

Refactor Forge toward a quality-first, performance-second executable assistant harness without replacing the primary ChatGPT/controller's semantic reasoning or adding another orchestration/state-machine layer.

Current-HEAD architecture evidence is recorded in `docs/researches/20260818-quality-first-executable-harness-map.md` at source HEAD `8540e85583498ef6a21215788b549db48e28fab7`.

## Decisions

1. Reuse the existing Context Pack, repository session cache, CodeGraph provider, direct repository executor, Process handles, Runtime recovery owner, and Forge checks.
2. `rh_context` is repeatable progressive retrieval. The first request remains broad; follow-ups reuse session-scoped inventory/search/range/structural evidence. ChatGPT owns semantic sufficiency.
3. Exact known files receive reserved materialization. Symbol/function/type or complete-small-file units precede fixed windows.
4. Current raw source is authoritative. Stale CodeGraph relationships are labeled hints and changed files overlay the baseline.
5. Ordinary local Git/inspect/edit/test/build/script commands use Ephemeral Exec. Commands still running after a bounded interactive admission may return a Lightweight Managed handle. Durable execution is explicit for external/release/non-idempotent effects.
6. Work/Plan route for continuity/orchestration, not predicted file/line complexity. Investigation expands context; it does not itself create Work.
7. Git/Edit Session/Process handle/validation result are sufficient for ordinary coding. Work and durable Process authorities exist only for actual durable workflows.
8. Decompose by responsibility and caller boundary; do not create forwarding-only facades or destabilize browser/device capabilities for line-count optics.

## Initial Scope

- `src/cli/controller/context-pack.ts`
- `src/cli/repository/inspector.ts`
- `src/cli/repository/session-cache.ts`
- new focused modules under `src/runtime/context/` and/or `src/cli/controller/context/`
- `src/runtime/context/codegraph-read-provider.ts`
- `src/runtime/gateway/mcp/runtime-tools.ts`
- `src/cli/mcp/instructions.ts` and directly related public documentation
- `src/runtime/execution/process-runtime/**`
- `src/cli/repositories/command-executor.ts`
- `src/runtime/control-plane/routing/**`
- Work/verification/projection stores only after phase-5 caller tracing
- oversized modules named by the architecture map when decomposition is behavior preserving
- focused tests and benchmark scripts under `tests/**` and `scripts/**`
- Forge architecture/research/task/plan/contract/review artifacts required by repository policy

Initial likely scope is discovery evidence, not semantic truth. Additional paths may be inspected or added when fresh impact analysis identifies a material dependency and repository policy permits it; actual changed scope must be reported separately.

## Implementation Phases

### Phase 1 — Context contract and coverage

- Rewrite all one-call/sufficiency instructions.
- Wire transport session/repository/checkout identity into Context Pack reads.
- Add exact-known reserved materialization and explicit inspected/uninspected/unresolved/skipped/test/cache coverage.
- Add focused contract tests.

### Phase 2 — Progressive symbol-aware context

- Split query planning, lexical retrieval, structural retrieval, ranking, source materialization, coverage, and session/cache concerns.
- Return complete small files and complete matched functions/methods/types when bounded; use fixed windows only as fallback.
- Cache multi-query lexical and structural results per session/source identity.
- Overlay current changed files and filter/down-rank structurally unrelated scratch/mobile/test candidates.
- Add cold/hot context latency and cache-reuse benchmarks.

### Phase 3 — Thin execution lanes

- Make bounded ordinary local commands Ephemeral Exec with no durable Process/SQLite/recovery/lease membership.
- Upgrade genuinely long commands to Lightweight Managed handles with bounded logs and best-effort restart visibility.
- Keep release/remote/non-idempotent operations explicit Durable and return `outcome_unknown` after ambiguous failure; never auto-replay.
- Measure harness overhead separately from child duration.

### Phase 4 — Routing and scope

- Remove `expectedFiles > 4` and `expectedChangedLines > 200` durable admission.
- Keep durable routing for explicit continuity, schedules, independent deliverables, multi-controller work, and real long-running/external requirements.
- Separate initial likely, inspected, and actual changed scope in contracts/projections without weakening explicit policy fences.

### Phase 5 — Authority and compatibility reduction

- Trace current callers for WorkHandle, verification snapshots, checkout/reconciliation/completion/lease projections, and legacy MCP handlers.
- Remove or derive redundant mutable projections while retaining one authority per concern.
- Delete internal compatibility code only when all supported callers/tests migrate.

### Phase 6 — Responsibility decomposition

- Decompose context modules as part of phases 1–2.
- Decompose runtime/execution/work/recovery/gateway modules along existing behavior boundaries.
- Review browser adapter decomposition only with real screenshot/physical-browser sibling verification; do not churn it solely for line count.
- Keep core modules near 200–500 lines where cohesive; document justified exceptions above 700–800 lines.

## Verification

- Focused context, route-policy, command-facade, Process Runtime, recovery, facade, MCP controller, and compatibility tests for each coherent phase.
- `bun run check:task`
- `bash scripts/check-deploy-sql-order.sh`
- `bash scripts/check-architecture-sync.sh`
- `bash scripts/check-task-sync.sh`
- `bash scripts/check-task-workflow.sh --strict`
- `bun scripts/inspect-project-state.ts --repo . --format text`
- `bash scripts/migrate-project-template.sh --repo . --dry-run`
- Fresh requirement/changed-symbol Context Pack review after coherent edits.
- Before/after cold/hot context latency, ordinary command harness overhead, managed admission overhead, and largest-file line counts.

## Acceptance Evidence

The final review must map concrete source/tests/measurements to all 15 acceptance criteria in the user goal and report architectural changes, removed complexity, intentionally durable mechanisms, retained compatibility with reasons, checks, latency, and line-count deltas.

## Task Breakdown

- [x] Establish and preserve the current-HEAD architecture/performance baseline.
- [x] Complete Phase 1 context contract, session wiring, known-path reservation, and coverage reporting.
- [x] Complete Phase 2 progressive symbol-aware retrieval, caching, freshness overlay, relevance filtering, and benchmarks.
- [x] Complete Phase 3 Ephemeral/Lightweight/Durable execution separation and no-replay behavior.
- [x] Complete Phase 4 continuity-based routing and expandable scope model.
- [x] Complete Phase 5 mutable-authority and compatibility reduction.
- [x] Complete Phase 6 responsibility-based God File decomposition.
- [x] Run fresh impact review, focused tests, required Forge checks, latency benchmarks, and line-count comparison.
- [x] Complete Forge review/notes/status artifacts and final acceptance report.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [x] Establish and preserve the current-HEAD architecture/performance baseline.
- [x] Complete Phase 1 context contract, session wiring, known-path reservation, and coverage reporting.
- [x] Complete Phase 2 progressive symbol-aware retrieval, caching, freshness overlay, relevance filtering, and benchmarks.
- [x] Complete Phase 3 Ephemeral/Lightweight/Durable execution separation and no-replay behavior.
- [x] Complete Phase 4 continuity-based routing and expandable scope model.
- [x] Complete Phase 5 mutable-authority and compatibility reduction.
- [x] Complete Phase 6 responsibility-based God File decomposition.
- [x] Run fresh impact review, focused tests, required Forge checks, latency benchmarks, and line-count comparison.
- [x] Complete Forge review/notes/status artifacts and final acceptance report.
