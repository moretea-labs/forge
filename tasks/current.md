# Current Status Snapshot

<!-- updated_at: 2026-08-02 -->
<!-- stale_after: 24h -->

> **Status**: Standalone recovery remains operationally separate; compiled Supervisor bootstrap, canonical runtime authority/config, direct child ownership, and immutable release execution paths are implemented. Focused runtime and governance gates pass. Recovery Connector and known-good attestation remain incomplete.
> **Updated At**: 2026-08-02
> **Source**: Stable Supervisor state, release manifests, canonical runtime authority/config checks, compiled-entry smoke checks, and focused runtime tests.
> **Target**: Establish a recovery path that never relies on the active Gateway or an unverified previous release.
> **Stale After**: 24h

This snapshot is a read model, not an execution gate.

## Current Focus

- ✅ Standalone compiled recovery binary installed under stable Controller Home; no symlink to the active release or worktree.
- ✅ User-level launchd gateway and watchdog are loaded from stable Controller Home and start through a clean `env -i` environment.
- ✅ Tailscale Funnel exposes the independent recovery gateway at a path-scoped `/recovery/mcp` endpoint while preserving the primary root mapping to stable ingress.
- ✅ Recovery core checks Supervisor state, slot manifests, manifest hashes, primary health, MCP initialize/tools/list/read-only-call, and records separate audit/quarantine data.
- ✅ Rollback is fail-closed: the active release is no-op when known-good, and an un-attested previous slot is refused.
- ✅ Isolated tests cover known-good attestation, no-op rollback, and the six-observation/two-signal watchdog threshold.
- ⏭ Independently authenticate a ChatGPT Recovery Connector against the recovery Funnel endpoint.
- ⏭ Configure the forced-command recovery SSH key after administrator approval; no SSH setting has been changed.

## Validation Completed

- `bun x tsc --noEmit`: 0 errors.
- `bun run check:main`: passed; task gate and all five runtime smoke scripts passed.
- Recovery smoke confirms `processRecovered: true`, `executionJobCount: 0`, and successful controller-session replacement.
- `bun test tests/runtime/standalone-recovery.test.ts`: 16/16.
- `bun test tests/runtime/stable-supervisor-hardening.test.ts`: 59/59.
- `bun test tests/runtime/stable-state-and-bootstrap.test.ts`: 15/15.
- `bun test tests/runtime/process-runtime.test.ts`: 39/39.
- `bun test tests/runtime/runtime-cutover-r2.test.ts`: 39/39.
- `bun test tests/cli/controller-service.test.ts`: 5/5.
- Governance checks passed: deploy SQL order, architecture sync (0 blocking), task sync, strict workflow check, project-state inspection, and migration dry-run. Generated workflow runtime manifests remain absent in this isolated worktree; no non-dry-run migration was performed.

## Remaining Before Delivery

- Do not create a ChatGPT Recovery Connector, configure SSH, or promote the user LaunchAgents to system LaunchDaemons without explicit administrator authorization.
- Obtain an MCP probe credential accepted by the OAuth-protected primary endpoint before attesting the live active release as known-good.
- Complete isolated fault injection, reboot, Tailscale SSH, reliable Grok, and ChatGPT Connector exercises before declaring unattended operation ready.
