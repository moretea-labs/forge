# Current Status Snapshot

<!-- updated_at: 2026-08-30T13:48:00+0800 -->
<!-- stale_after: 24h -->

> **Status**: Active
> **Updated At**: 2026-08-30T13:48:00+0800
> **Source Branch**: main
> **Published Baseline Commit**: 1ba073f5fa78dc69202f349afadab785f97d48f9
> **Target Branch**: main
> **Reason**: Forge 1.7.1 published; Forge Cloud Windows P0.1 is delivered and P0.2 lifecycle authority repair is active

This file is a tracked mainline snapshot for the post-1.7.1 handoff. It is not a live lock or a replacement for Forge Work/Plan authority. The tracked handoff note below is the portable source of truth for a fresh Forge Cloud Windows clone.

## Current Focus

- Status: Active on Forge Cloud Windows
- Active source-optimization lane: Windows Forge Cloud only
- Handoff: `tasks/notes/20260830-forge-cloud-windows-post-1.7.1-handoff.notes.md`
- P0.1 delivered: `3572c78137e65e45857da3e5b8acde18d92548a7`; GitHub Windows smoke #290 passed
- Next source task: P0.2 effect Work -> source-delta terminalization authority, including the narrow historical reconciliation path defined in the handoff note
- Local macOS source lane: frozen after this governance handoff; do not create parallel Forge source optimization unless the user explicitly overrides this policy

## Published Baseline

- published 1.7.1 commit: `1ba073f5fa78dc69202f349afadab785f97d48f9`
- current `origin/main`: `3572c78137e65e45857da3e5b8acde18d92548a7` (P0.1 Windows smoke repair)
- immutable tag: `v1.7.1` -> `1ba073f5fa78dc69202f349afadab785f97d48f9`
- npm: `@moretea-labs/forge@1.7.1`, `latest=1.7.1`
- GitHub Release: `v1.7.1`
- final publication check: `package:check:release-published` PASS

Do not move or rewrite `v1.7.1`. Post-release fixes belong on `main` and a later patch release.

## Local Controller State

The macOS Controller still reports active/pending historical state. It is **not** portable task authority for Windows Cloud:

- `work-publish-forge-1-7-1-from-exact-r-6cf1f181`: publication is complete, but lifecycle terminalization is blocked by the effect-Work/source-delta authority gap tracked as `hnd-1788067200203`.
- Two active remote-effect Works concern revenue/Devpost activity. They are unrelated business Work and must not be imported into Forge source optimization.
- Historical pending handoffs must be triaged against current source before any repair; several are already source-fixed and only lack live closure evidence.

## Source Optimization Policy

1. Future Forge product/runtime/source optimization runs on Forge Cloud Windows.
2. Start from fresh `origin/main`; never assume macOS Controller SQLite/leases/sessions are transferable.
3. Keep one primary Forge optimization lane. Temporary branches/worktrees are allowed only when required by Forge isolation and must be merged/cleaned promptly.
4. Do not revive old PlanContracts blindly. Reproduce current behavior first and use the tracked handoff priorities.
5. Preserve fail-closed lifecycle, delivery, controller isolation, and remote-effect authority.
6. Commit coherent slices and push delivered `main` promptly; do not leave verified source only on a local Windows checkout.
7. Windows CI/smoke is a first-class acceptance surface.
8. macOS-only TCC/browser live acceptance may remain an external evidence handoff; do not fake closure from Windows.

## Git Status at Handoff

- branch: `main`
- release baseline: `1ba073f5fa78dc69202f349afadab785f97d48f9`
- current delivered main: `3572c78137e65e45857da3e5b8acde18d92548a7`
- local source tree is synchronized with `origin/main` before the P0.2 implementation slice

## Source Artifacts

- Windows Cloud handoff: `tasks/notes/20260830-forge-cloud-windows-post-1.7.1-handoff.notes.md`
- Deferred-only ledger: `tasks/todos.md`
- historical plans: Controller PlanContracts must be treated as superseded by the post-1.7.1 handoff, not re-executed from their old source revisions
