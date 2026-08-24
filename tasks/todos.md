# Deferred Goal Ledger

> **Status**: Backlog
> **Updated**: 2026-08-24 14:36
> **Scope**: Medium/long-term goals deferred from active plan execution

Current plan tasks live in the active plan's `## Task Breakdown`.
Do not duplicate that execution checklist here. Record only work intentionally deferred beyond this slice, with the tradeoff and revisit trigger.

## Deferred Goals

| Goal | Why Deferred | Tradeoff | Revisit Trigger |
|------|--------------|----------|-----------------|
| Close the 2026-08-11 Forge residual runtime/execution issues (`tasks/notes/20260811-forge-residual-runtime-issues.notes.md`) | Active optimization is intentionally split across sessions; one stable ledger prevents rediscovery and duplicate fixes | Until closed, Process fixed tax, active-index O(N), stale MCP schema, legacy shell plugin false locks, and cold Git cost remain measurable residuals | Re-read the ledger at the start of every Forge optimization session; update each item with commit + benchmark evidence when fixed |
| Add a stable business-goal identity (`goalKey` / authoritative scope identity) across intentionally isolated WorkContracts | `d2e6c845` now prevents two non-isolated Works from writing the same checkout and preserves ChatGPT schedule conversation affinity; inferring semantic equality across legitimate isolated slices is a broader portfolio/goal-identity design change | An explicit isolated Work can still duplicate an existing product goal if a caller invents a new scope, but it can no longer become a second writer of the canonical checkout | When changing Plan scope semantics, Goal/Portfolio identity, or cross-worktree Work admission |
