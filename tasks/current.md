# Current Status Snapshot

<!-- updated_at: 2026-08-30T16:05:00+0800 -->
<!-- stale_after: 24h -->

> **Status**: Active
> **Updated At**: 2026-08-30T16:05:00+0800
> **Source Branch**: main
> **Published Baseline Commit**: 1ba073f5fa78dc69202f349afadab785f97d48f9
> **Target Branch**: main
> **Reason**: Forge 1.7.1 published; Windows P0.1-P0.3 source repairs are integrated and the 1.7.2 Runtime lifecycle patch is in release validation

This file is a tracked mainline snapshot for the post-1.7.1 handoff. It is not a live lock or a replacement for Forge Work/Plan authority. The tracked handoff note below is the portable source of truth for a fresh Forge Cloud Windows clone.

## Current Focus

- Status: Active on Forge Cloud Windows
- Active source-optimization lane: Windows Forge Cloud only
- Handoff: `tasks/notes/20260830-forge-cloud-windows-post-1.7.1-handoff.notes.md`
- P0.1 delivered: `3572c78137e65e45857da3e5b8acde18d92548a7`; GitHub Windows smoke #290 passed
- P0.2 source repair delivered: `35915d4bed240fd5e6d5221e11ef81d98a73cc9c`; effect Work is promoted before governed source mutation and the narrow reviewed historical reconciliation path remains fail-closed
- P0.3 source repair delivered through `810b69170d8a6c5a1bab28f61c04e1ebd4670c4c` and `2cf73466e57959b7c1172635a173352b32a7c190`; explicit Controller session capability now survives transport rotation without same-principal conversation leakage
- Active release task: publish 1.7.2 with the above repairs plus Linux/WSL package Runtime activation convergence and clean systemd shutdown semantics
- Next post-release source task: P0.4 supported standalone Recovery self-upgrade/cutover authority
- Local macOS source lane: frozen after this governance handoff; do not create parallel Forge source optimization unless the user explicitly overrides this policy

## Published Baseline

- published 1.7.1 commit: `1ba073f5fa78dc69202f349afadab785f97d48f9`
- latest confirmed remote baseline before the 1.7.2 candidate: `2cf73466e57959b7c1172635a173352b32a7c190`
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
- current candidate main contains P0.1-P0.3 plus the Linux/WSL Runtime activation repair; release containment is recorded after the 1.7.2 tag is published
- the local source tree was clean before the 1.7.2 Runtime shutdown regression slice

## Source Artifacts

- Windows Cloud handoff: `tasks/notes/20260830-forge-cloud-windows-post-1.7.1-handoff.notes.md`
- Deferred-only ledger: `tasks/todos.md`
- historical plans: Controller PlanContracts must be treated as superseded by the post-1.7.1 handoff, not re-executed from their old source revisions
