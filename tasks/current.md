# Current Status Snapshot

<!-- updated_at: 2026-08-03 -->
<!-- stale_after: 24h -->

> **Status**: Stable Supervisor, daemon, gateway, ingress, public tunnel, and the 128-tool MCP surface are operational on immutable release `9776f1b8...`. The old 502/503 condition was caused by a stale service/runtime handoff; the repaired release is active and local/public health probes return HTTP 200.
> **Updated At**: 2026-08-03
> **Source**: Stable Supervisor state, release manifests, authenticated MCP initialize/tools/list/controller_ready probes, and local/public HTTP probes.
> **Target**: Keep one fixed Bootstrap service aligned with the current immutable release and complete the accepted Requirement-centered control-plane migration.
> **Stale After**: 24h

This snapshot is a read model, not an execution gate.

## Current Focus

- ✅ Immutable standalone Supervisor release `9776f1b8...` is active through the fixed Controller-home Bootstrap and launchd service.
- ✅ Supervisor, daemon, gateway, and stable ingress converge on the same release; ingress `/health` and `/ready` return HTTP 200.
- ✅ Public `https://mcp.moretea-lab.tech/health` returns HTTP 200 through the Cloudflare tunnel.
- ✅ Authenticated MCP `initialize` and `tools/list` succeed; the active advanced surface exposes 128 tools.
- ✅ The old 502/503 failure path is no longer active; the prior stale service metadata is now accepted when the fixed Bootstrap manifest matches the current release.
- ⏭ Independently authenticate a ChatGPT Recovery Connector against the recovery Funnel endpoint.
- ⏭ Configure the forced-command recovery SSH key after administrator approval; no SSH setting has been changed.

## Validation Completed

- `bun test tests/runtime/stable-supervisor-hardening.test.ts -t 'service activation requires current, generated, installed, and running Supervisor releases to agree'`: 1/1.
- Bootstrap service coherence now resolves generated and installed fixed-Bootstrap definitions against `bootstrap-manifest.json`; direct source probe returned `ok: true`.
- Supervisor install staged and activated release `fc722c87...`; final state is `observedState: healthy`, active slot `green`, and `currentOperationId: null`.
- Local `/health` and public `/health` returned HTTP 200 after activation; authenticated MCP `initialize` and `tools/list` succeeded.
- `bun src/cli/index.ts controller board --repo .` succeeded and read the current Issue/Task projection.
- Existing governance evidence remains in the prior snapshot; required checks must be rerun after this source and task-state update.

## Remaining Before Delivery

- Do not create a ChatGPT Recovery Connector, configure SSH, or promote the user LaunchAgents to system LaunchDaemons without explicit administrator authorization.
- Re-run the repository required checks after the final Issue/architecture snapshot commit.
- Complete isolated fault injection, reboot, Tailscale SSH, reliable Grok, and ChatGPT Connector exercises before declaring unattended operation ready.


## Authority T2 Progress

- `9b3e2ae7f` is merged locally: Requirement, Plan, and Work runtime records use Controller-home SQLite per-record transactions with revision/CAS fencing; legacy JSON/index data is imported only when the new namespace is absent.
- Requirement lifecycle and active-plan binding, Plan per-record persistence, Work per-record persistence, WAL-safe backup/restore, and focused regression tests are implemented.
- `check:type`, `check:runtime-architecture`, `check:test-governance`, `check:public-docs`, affected tests, and `check:controller-v8` pass. The Controller V8 repair also propagates immutable release `executionMode` into candidate/rollback canary checks and aligns MCP assertions with the shipped bounded stable schema. No runtime activation or rollout was performed.