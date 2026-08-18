# Implementation Notes: quality-first-executable-harness

> **Status**: Completed
> **Plan**: plans/plan-20260818-1535-quality-first-executable-harness.md
> **Contract**: tasks/contracts/20260818-1535-quality-first-executable-harness.contract.md
> **Review**: tasks/reviews/20260818-1535-quality-first-executable-harness.review.md
> **Last Updated**: 2026-08-18 19:05
> **Lifecycle**: notes

## Design Decisions

- `rh_context.search` is the only public progressive source-context contract.
  It reserves exact-path budget, reports inspected/uninspected/unresolved/test
  coverage, and reuses Git, lexical, range, and structural evidence by session
  plus source identity.
- Current raw source is authoritative. Stale CodeGraph relations are emitted as
  hints only, while dirty/current changed paths overlay the graph baseline.
- Ordinary local writes/builds/tests enter an authorized non-persistent command
  executor. If the interactive budget expires, the same child remains visible
  through an in-memory `lightweight:` handle with bounded logs and no SQLite,
  Lease, recovery, or replay membership.
- Persistent Process receipts are retained only for real Work/Edit verification
  consumers and explicit durable workflows. External/release/destructive work
  stops at a never-auto-retry boundary.
- Predicted file and line counts no longer select Work. `allowedPaths` remains a
  policy fence; predicted, inspected, and changed paths live in `scopeEvidence`.
- Decomposition followed ownership boundaries: Context planning/materialization,
  command child/snapshot mechanics, lightweight handles, and MCP schemas.

## Deviations From Plan Or Spec

- The browser adapter was not split. It exceeds the preferred line count, but
  the plan explicitly requires real screenshot and sibling-device verification
  before changing that shared interaction surface; line-count-only churn would
  increase risk without reducing authority.
- The legacy full MCP profile remains versioned compatibility. Its retired
  `controller_context_pack` handler was removed, while broader deletion is
  deferred to an explicit client migration.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Make all managed commands persistent | Rejected | Recreates Process/Lease/recovery tax for ordinary coding. |
| Make all long commands ephemeral-only | Rejected | Loses useful bounded wait/log/cancel interaction while the controller remains alive. |
| Use predicted scope as `allowedPaths` | Rejected | Freezes discovery before impact evidence is complete. |
| Split every file over 700 lines | Rejected | Responsibility and caller boundaries matter more than line-count optics. |

## Open Questions

- None.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Baseline map: `docs/researches/20260818-quality-first-executable-harness-map.md`
- Authority audit: `docs/researches/20260818-authority-compatibility-audit.md`
- Target architecture: `docs/architecture/current/quality-first-executable-harness.md`

## Final Measurements

- Quality benchmark (5 iterations): context cold p50/p95 `57.84/76.92 ms`,
  hot p50/p95 `0.46/0.60 ms`, hot/cold ratio `0.008`; repeated calls
  reported lexical, structural, and range cache hits.
- Lightweight command benchmark: raw child p50 `7.56 ms`, total p50
  `28.17 ms`, pre-spawn harness p50/p95 `10/12 ms`, with `0` durable
  Process writes and `0` Lease operations.
- Focused architecture matrix: `220` tests passed across seven files.
- Governed affected gate: `24/24` selected files passed; `bun run
  check:task` passed and emitted a task-gate receipt.
- Largest changed files: `runtime-tools.ts` `6621 -> 5900`,
  `legacy-tool-service.ts` `5520 -> 5481`, `command-executor.ts`
  `1066 -> 575`, `context-pack.ts` `908 -> 725`; extracted cohesive modules
  are all `16–725` lines and no new module exceeds 1000 lines.
- The final fresh impact review found one cache-key mismatch (`maxDepth`) and
  one stale size-based Work fixture. Both were corrected before acceptance.
- Final sprint verification exposed and fixed a fallback bug where an isolated
  worktree without generated hook helpers selected the oldest historical
  contract instead of the active plan's declared contract.
- The same audit fixed stale-base selection: implicit verification now prefers
  current local `main` over an older `origin/main`, while explicit diff-base
  environment overrides remain authoritative.

## Final Verification

- `git diff --check`
- `bun run check:type`
- focused context/process/routing/facade/MCP suites (`220/220`)
- `bun run benchmark:quality-harness -- --iterations 5`
- `bun run test` (governed affected gate, `24/24` files)
- `bun run check:task`
- `bash scripts/check-deploy-sql-order.sh`
- `bash scripts/check-architecture-sync.sh`
- `bash scripts/check-task-sync.sh`
- `bash scripts/check-task-workflow.sh --strict`
- `bun scripts/inspect-project-state.ts --repo . --format text`
- `bash scripts/migrate-project-template.sh --repo . --dry-run`

The strict workflow check passed its source/document contracts and reported
four expected ignored generated-runtime files absent in this isolated worktree.
The required migration dry-run verified their supported remediation without
changing runtime state.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
