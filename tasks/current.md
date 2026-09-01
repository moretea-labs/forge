# Current Status Snapshot

<!-- updated_at: 2026-09-01T10:15:00+0800 -->
<!-- stale_after: 24h -->

> **Status**: Active
> **Updated At**: 2026-09-01T10:15:00+0800
> **Source Branch**: main
> **Published Baseline Commit**: 1bc7e5a6348ab807c9cc9d7b1b5dd0f87904e020
> **Target Branch**: main
> **Reason**: P0 dual-instance Connector/Tunnel/OAuth convergence; Mac and GREYSON-DESKTOP WSL remain independent long-lived Forge + Recovery installations

This file is a tracked mainline snapshot for the current Forge Cloud Windows lane. It is not a live lock or a replacement for Forge Work/Plan authority. The tracked handoff note below remains the portable post-release source baseline.

## Current Focus

- P0 authority: retain two independent instances. Mac remains live and unmodified; only WSL canonical source `/home/greyson/src/forge` is changed.
- Mac evidence: its Primary Connector resolves `/Users/greyson/DevProjects/forge`; its Recovery is an independent local service. It is not a source-development target.
- WSL authority: `greyson-desktop`, Controller Home `/home/greyson/.forge/controller`, canonical repository `repo_f37fe508f6e8dabb8fe607e4`, checkout `checkout_d61bdffca8e9b7cc2e2b8d64`.
- WSL Runtime and loopback OAuth Connector are healthy. Primary OpenAI Secure Tunnel `tunnel_6a8a862b52188191b859cf61e7cdb9a3` is healthy but was unmanaged by Recovery; `restart_public_tunnel` is correctly scoped only to Recovery's dedicated public tunnel and therefore cannot repair Primary.
- Source repair: persist an explicit Connector instance identity (WSL target `forge-wsl`) through the Controller Home and service environment; bring the standalone Recovery installer into parity with the CLI for Linux/OpenAI Primary tunnel ownership and distinct tunnel identities. Recovery's non-interactive command PATH also includes the standard user tool directory so it can own `tunnel-client` repair from systemd-user.
- Blocking external boundary: the WSL OAuth issuer still resolves to loopback and no dedicated WSL public OAuth hostname/tunnel is provisioned. A new primary-only Cloudflare tunnel + DNS hostname and a separately named ChatGPT `Forge WSL` tunnel connector are required; neither may reuse Recovery WSL or the Mac endpoint.
- Work dedupe: `work-repair-forge-linux-wsl2-package--60323050` and `work-successor-continuation-repair-fo-a753657e` are completed; no active overlapping Work contract was found. Do not start destructive Worktree cleanup while the P0 public OAuth path remains incomplete.

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
