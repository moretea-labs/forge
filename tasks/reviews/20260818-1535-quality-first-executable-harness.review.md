# Task Review: quality-first-executable-harness

> **Status**: Passed
> **Plan**: plans/plan-20260818-1535-quality-first-executable-harness.md
> **Contract**: tasks/contracts/20260818-1535-quality-first-executable-harness.contract.md
> **Notes File**: tasks/notes/20260818-1535-quality-first-executable-harness.notes.md
> **Checks File**: .ai/harness/checks/latest.json
> **Last Updated**: 2026-08-18 19:05
> **Recommendation**: pass

## Human Review Card

- Verdict: pass
- Change type: code-change
- Intended files changed: Context Plane, command/check execution, routing/Work
  scope, MCP compatibility, focused tests/benchmarks, and Forge workflow docs.
- Actual files changed: 50 tracked/untracked paths within the contract allowlist;
  no production runtime state, `_ops`, secrets, remote refs, or deployment state.
- Commands passed: typecheck; 220 focused tests; quality benchmark; 24-file
  governed affected gate; task, deploy SQL, architecture, task sync, strict
  workflow, project inspection, and migration dry-run checks.
- External acceptance: manual_override; this is a local source refactor with no
  deployed/browser/device behavior change; the prompt explicitly permits the
  same primary controller to perform the fresh evidence review.
- Residual risks: broader legacy full-profile MCP compatibility remains; the
  browser/recovery God Files were intentionally not split without their required
  physical/runtime verification. Four ignored generated runtime files are absent
  only in the isolated worktree and have a verified migration path.
- Reviewer action required: none before local handoff.
- Rollback: revert the local phase commits on
  `codex/quality-first-executable-harness`; no remote or runtime rollback exists.

## Mode Evidence

- Selected route: `/direct` in an isolated contract worktree.
- P1/P2/P3 evidence: baseline architecture map, caller/authority audit, and
  target architecture are linked from the implementation notes.
- Root cause or plan evidence: ordinary coding inherited durable Process/Lease
  cost; first-pass context behaved as a bounded answer rather than a progressive
  evidence session; size heuristics conflated complexity with continuity.

## Verification Evidence

- Waza `/check` run: not installed and not required by Forge; native Forge
  `/review`-style diff/impact review and required checks were used.
- Commands run: see `## Retest Steps` and implementation notes.
- Manual checks: fresh requirement-to-changed-symbol review, authority/caller
  audit, public tool-surface search, line-count comparison, and benchmark output.
- Supporting artifacts: architecture map, authority audit, target architecture,
  benchmark script, focused tests, task receipt, and implementation notes.
- Implementation notes reviewed: yes.
- Run snapshot: task receipt under `.ai/harness/checks/gates/`; ignored local
  checkpoints remain under `.ai/harness/checks/tests/checkpoints/`.

## External Acceptance Advice

> **External Acceptance**: manual-override-pass
> **External Reviewer**: none required
> **External Source**: local source/diff/benchmark evidence
> **External Started**: 2026-08-18
> **External Completed**: 2026-08-18

- P1 blockers: none.
- P2 advisories: retain the documented compatibility and browser/recovery split
  follow-ups until explicit consumer and physical-runtime verification exists.
- Acceptance checklist: all 15 prompt criteria map to evidence below.

## Behavior Diff Notes

| # | Acceptance evidence |
|---|---------------------|
| 1 | Repeatable `rh_context.search` instructions and session identity permit controller-selected expansion. |
| 2 | Async first-call fan-in overlaps CodeGraph and one batched lexical scan. |
| 3 | Hot calls hit Git, lexical, structural, and range caches; hot p50 was `0.46 ms`. |
| 4 | Exact known paths reserve file and snippet capacity and report missing/materialized coverage. |
| 5 | TypeScript source materialization returns complete functions, methods, classes, interfaces, and type aliases before windows. |
| 6 | Baseline/dirty overlays and stale structural hints keep current raw source authoritative; unrelated mobile/scratch nodes are filtered. |
| 7 | Ordinary local commands use the direct executor and in-memory Lightweight registry, not durable Process Runtime. |
| 8 | Benchmark and tests prove `0` persistent Process writes and `0` Lease operations for the ordinary lane. |
| 9 | Remote/destructive effects stop at explicit Durable boundaries with `never_auto_retry` and `outcome_unknown` reconciliation guidance. |
| 10 | File/line estimates and investigation no longer create Work; continuity, schedules, independent deliverables, and explicit durable modes do. |
| 11 | `scopeEvidence` records initial/additional likely, inspected, and actual changed paths separately from `allowedPaths` fences. |
| 12 | Runtime schemas, Context responsibilities, command process/snapshot mechanics, and Lightweight handles were extracted; no new module exceeds 1000 lines. |
| 13 | Public `controller_context_pack` and its duplicate handler/route/policy were removed; ordinary commands no longer create Work/Process/Lease/replay authorities. |
| 14 | 220 focused tests and the 24-file governed affected gate passed; retained durable Work/Edit verification remains covered. |
| 15 | Context hot/cold ratio `0.008`, pre-spawn p95 `12 ms`, zero durable writes/leases, and material line-count reductions all pass fixed thresholds. |

## Residual Risks / Follow-ups

- Intentionally durable: Work/Plan continuity, Work/Edit-bound exact validation
  receipts, complete Runtime release/rollback, scheduler ownership, and remote or
  non-idempotent external effects.
- Intentionally retained: versioned full-profile MCP consumers, WorkHandle's
  physical worktree/finalization state, immutable verification snapshots, and
  standalone Runtime recovery. The authority audit explains why each is not a
  duplicate lifecycle owner.
- Browser and standalone recovery decomposition remain future explicit slices;
  this change did not touch their behavior.

## Scorecard

| Dimension | Score | Notes |
|-----------|-------|-------|
| Functionality | 9/10 | All requested contracts are implemented and exercised; no deployment acceptance was in scope. |
| Product depth | 9/10 | Context quality, execution latency, scope expansion, and durable boundaries align with the stated controller-first product direction. |
| Design quality | 9/10 | Existing authorities were reused and reduced; no new orchestration/state-machine layer was added. |
| Code quality | 9/10 | Cohesive splits, typed contracts, focused invariant tests, benchmarks, and full affected gates pass. |

## Failing Items

- None.

## Retest Steps

- Re-run: `bun run check:type`; the seven-file focused test command from the
  notes; `bun run benchmark:quality-harness -- --iterations 5`; `bun run test`;
  `bun run check:task`.
- Re-check: deploy SQL, architecture sync, task sync, strict workflow, project
  inspection, and migration dry-run commands from the contract.

## Summary

- Pass. The refactor makes Forge thinner on ordinary coding paths and richer in
  retrieval evidence while preserving explicit durable mechanisms where their
  recovery/continuity semantics are materially required. No push, publish,
  release, Runtime activation, or external coding-agent integration occurred.
