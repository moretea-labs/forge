# Current Status Snapshot

<!-- updated_at: 2026-07-26 -->
<!-- stale_after: 24h -->

> **Status**: Standalone disaster-recovery core implemented; system-level activation remains intentionally blocked pending administrator approval.
> **Updated At**: 2026-07-26
> **Source**: Stable Supervisor state, release manifests, and isolated recovery-core tests.
> **Target**: Establish a recovery path that never relies on the active Gateway or an unverified previous release.
> **Stale After**: 24h

This snapshot is a read model, not an execution gate.

## Current Focus

- ✅ Standalone compiled recovery binary installed under stable Controller Home; no symlink to the active release or worktree.
- ✅ Recovery core checks Supervisor state, slot manifests, manifest hashes, primary health, MCP initialize/tools/list/read-only-call, and records separate audit/quarantine data.
- ✅ Rollback is fail-closed: the active release is no-op when known-good, and an un-attested previous slot is refused.
- ✅ Isolated tests cover known-good attestation, no-op rollback, and the six-observation/two-signal watchdog threshold.
- ⏭ Bootstrap the independently rendered system LaunchDaemons only after one administrator-approved operation.
- ⏭ Provision a separate Tailscale Funnel hostname and independently authenticate a ChatGPT Recovery Connector.
- ⏭ Configure the forced-command recovery SSH key after administrator approval; no SSH setting has been changed.

## Validation Completed

- `bun x tsc --noEmit`: 0 errors.
- `bun test tests/runtime/standalone-recovery.test.ts`: 2 pass.
- Compiled recovery binary and two system LaunchDaemon plists rendered under the stable Controller Home.
- Independent recovery Gateway MCP initialize and fixed seven-tool list verified locally; no shell tool is exposed.

## Remaining Before Delivery

- Do not bootstrap the LaunchDaemons, configure SSH, or expose a Funnel without explicit administrator authorization.
- Obtain an MCP probe credential accepted by the OAuth-protected primary endpoint before attesting the live active release as known-good.
- Complete isolated fault injection, reboot, Tailscale SSH, Grok, Funnel, and ChatGPT Connector exercises before declaring unattended operation ready.
