# Plan: Forge Evaluation Framework

> **Status**: Completed
> **Created**: 2026-08-20 18:00
> **Slug**: forge-evaluation-framework
> **Planning Source**: user goal
> **Task Contract**: `tasks/contracts/20260820-1800-forge-evaluation-framework.contract.md`
> **Task Review**: `tasks/reviews/20260820-1800-forge-evaluation-framework.review.md`
> **Implementation Notes**: `tasks/notes/20260820-1800-forge-evaluation-framework.notes.md`

## Agentic Routing

- Selected route: `/direct`
- Routing reason: The requested first version has a bounded, repository-local surface and must not modify the Forge Runtime or user repositories.
- Due diligence:
  - P1 map: `evals/` benchmarks skill prompts, while this slice needs an independent repository-snapshot scenario boundary.
  - P2 trace: scenario JSON -> local Git clone at an immutable commit -> Forge CLI invocation inside clone -> trace and validators -> report.
  - P3 decision rationale: Reuse Git and Forge's normal CLI rather than add a service, database, scheduler, or agent runner.

## Workflow Inventory

- Active plan: no active-plan pointer is claimed; the checkout contains unrelated in-progress changes.
- Sprint contract: `tasks/contracts/20260820-1800-forge-evaluation-framework.contract.md`
- Sprint review: `tasks/reviews/20260820-1800-forge-evaluation-framework.review.md`
- Implementation notes: `tasks/notes/20260820-1800-forge-evaluation-framework.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: the task contract's `allowed_paths`.
- Execution isolation: this change creates no Runtime process, does not activate a release, and evaluation runs clone a source repository into an OS temporary directory.

## Design

The `evaluation/` tree owns a small Scenario v1 contract, a local-clone sandbox,
structured trace/validator/metric/report functions, and a CLI wrapper. The
runner has one built-in Forge CLI invoker; a future agent or MCP invoker may
produce the same trace data without changing the scenario or report format.

The sandbox never uses `git worktree` against a source repository. It records
the source Git status before and after each run, clones with `--no-local` into a
temporary directory, and rejects report output inside the source repository.

## Task Breakdown

- [x] Define and parse Scenario v1 plus trace, validator, metric, and report contracts.
- [x] Implement local-clone isolation and the Forge CLI execution adapter.
- [x] Add one safely represented Forge historical-regression seed scenario and a focused test.
- [x] Run focused plus required Forge checks; record the review and task snapshot.
