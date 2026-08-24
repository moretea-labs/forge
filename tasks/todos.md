# Deferred Goal Ledger

> **Status**: Backlog
> **Updated**: 2026-08-24 15:55
> **Scope**: Medium/long-term goals deferred from active plan execution

Current plan tasks live in the active plan's `## Task Breakdown`.
Do not duplicate that execution checklist here. Record only work intentionally deferred beyond this slice, with the tradeoff and revisit trigger.

## Deferred Goals

| Goal | Why Deferred | Tradeoff | Revisit Trigger |
|------|--------------|----------|-----------------|
| Review historical macOS Automation grants recorded in `tasks/notes/20260811-forge-residual-runtime-issues.notes.md` | The residual-runtime ledger is reconciled with no known P0/P1 correctness debt; only selector-bound System Settings cleanup remains and permission toggles require user action-time confirmation | Historical principals remain visible in macOS Automation settings, but this is P2 operational hygiene and does not block Runtime correctness or delivery | Revisit when the user is present to confirm the exact permission toggles; preserve the stable signed `Forge Desktop Operator` Chrome/Vivaldi grants |
| Add a stable business-goal identity (`goalKey` / authoritative scope identity) across intentionally isolated WorkContracts | `d2e6c845` now prevents two non-isolated Works from writing the same checkout and preserves ChatGPT schedule conversation affinity; inferring semantic equality across legitimate isolated slices is a broader portfolio/goal-identity design change | An explicit isolated Work can still duplicate an existing product goal if a caller invents a new scope, but it can no longer become a second writer of the canonical checkout | When changing Plan scope semantics, Goal/Portfolio identity, or cross-worktree Work admission |
