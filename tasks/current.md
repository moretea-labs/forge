# Current Status Snapshot

<!-- updated_at: 2026-08-31T18:05:00+0800 -->
<!-- stale_after: 24h -->

> **Status**: Active
> **Updated At**: 2026-08-31T18:05:00+0800
> **Source Branch**: codex/independent-windows-wsl-recovery
> **Published Baseline Commit**: c873cfeb11a223ced342e7101c016261b4a93b38
> **Target Branch**: main
> **Reason**: Emergency Windows/WSL Forge Cloud authority recovery; success requires GREYSON-DESKTOP WSL to be the one canonical Runtime, Connector, tunnel, and independent-rescue authority

This file is a tracked mainline snapshot for the current Forge Cloud Windows lane. It is not a live lock or a replacement for Forge Work/Plan authority. The tracked handoff note below remains the portable post-release source baseline.

## Current Focus

- Status: Active emergency recovery on Forge Cloud Windows
- Active authority objective: `GREYSON-DESKTOP -> Windows -> WSL UbuntuDev -> /home/greyson/src/forge -> /home/greyson/.forge/controller -> canonical Runtime -> canonical OAuth Connector -> OpenAI Secure Tunnel -> ChatGPT Forge Cloud`
- Independent rescue source implementation is staged for `/home/greyson/.forge-recovery` and `C:\ProgramData\ForgeRecovery`; it permits only fixed status/start/restart/verification actions and has no arbitrary-shell RPC
- Read-only audit found a fail-closed conflict: the canonical user-level Controller Home exists but the repo-local legacy Controller Home currently owns the running Runtime and Connector. The direct cutover bootstrap has passed its no-change preflight and must preserve the full legacy home as evidence while moving active service authority to the canonical home.
- Tunnel identity observed locally: alias `forge`, id `tunnel_6a8a862b52188191b859cf61e7cdb9a3`; its local runtime was stopped at audit time, so an external Forge Cloud success claim is not yet valid.
- The former autonomous-continuation acceptance remains deferred until the canonical Windows/WSL recovery chain is restored and verified.
- Current repair: frozen MCP clients may encode `controller_claim`, `continue`, `finalize`, `stop`, and `controller_release` as `controller.round:<operation>:<authorityId>:<relayScopeId>` through `operation=repair`; Runtime maps the call back to the canonical operation and applies the same exact authority/scope fences
- Windows bridge repair: WSL continuation now opens only an explicitly resolved, installed Google Chrome executable and fails closed when Chrome is unavailable; it no longer delegates to the Windows default-browser handler
- Self-hosting gate repair: the bundled migration helper now resolves its owning Forge checkout from both package and repo-pinned locations instead of silently exiting from the wrong parent directory
- Verification so far: TypeScript no-emit passed; 94 focused tests cover control-plane hardening, `rh_work` authority, autonomous continuation, ChatGPT continuation binding, and helper self-resolution
- Handoff: `tasks/notes/20260830-forge-cloud-windows-post-1.7.1-handoff.notes.md`
- P0.1 delivered: `3572c78137e65e45857da3e5b8acde18d92548a7`; GitHub Windows smoke #290 passed
- P0.2 source repair delivered: `35915d4bed240fd5e6d5221e11ef81d98a73cc9c`; effect Work is promoted before governed source mutation and the narrow reviewed historical reconciliation path remains fail-closed
- P0.3 source repair delivered through `810b69170d8a6c5a1bab28f61c04e1ebd4670c4c` and `2cf73466e57959b7c1172635a173352b32a7c190`; explicit Controller session capability now survives transport rotation without same-principal conversation leakage
- 1.7.2 published: `c873cfeb11a223ced342e7101c016261b4a93b38`; GitHub Main gate, Windows smoke, release gate, npm Trusted Publishing, and final published-state consistency check passed
- P0.4 standalone Recovery self-upgrade/cutover authority was delivered through `694ecb4a14526bdd148e8dae8401c7dc0a06bf43`; the autonomous continuation acceptance is the active follow-on
- Local macOS source lane: frozen after this governance handoff; do not create parallel Forge source optimization unless the user explicitly overrides this policy

## Published Baseline

- published 1.7.2 commit: `c873cfeb11a223ced342e7101c016261b4a93b38`
- immutable tag: `v1.7.2` -> `c873cfeb11a223ced342e7101c016261b4a93b38`
- prior immutable tag: `v1.7.1` -> `1ba073f5fa78dc69202f349afadab785f97d48f9`
- npm: `@moretea-labs/forge@1.7.2`, `latest=1.7.2`
- GitHub Release: `v1.7.2`
- final `package:check:release-published`: PASS for registry, dist-tag, tarball, tag, and local version agreement

Do not move or rewrite `v1.7.1` or `v1.7.2`. Post-release fixes belong on `main` and a later release.

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
- published release main: `c873cfeb11a223ced342e7101c016261b4a93b38`
- local `main`, `origin/main`, and peeled `v1.7.2` were identical and the source tree was clean after publication verification

## Source Artifacts

- Windows Cloud handoff: `tasks/notes/20260830-forge-cloud-windows-post-1.7.1-handoff.notes.md`
- Deferred-only ledger: `tasks/todos.md`
- historical plans: Controller PlanContracts must be treated as superseded by the post-1.7.1 handoff, not re-executed from their old source revisions
