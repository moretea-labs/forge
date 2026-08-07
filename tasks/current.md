# Current Status Snapshot

<!-- updated_at: 2026-08-07 -->
<!-- stale_after: 24h -->

> **Status**: Unified `forge-runtime` is the single lifecycle owner on immutable release `1786101625826-668ffbe7...` through the launchd service `com.moretea.forge.runtime.41dd111b15e2`; standalone Recovery Gateway/Watchdog/Tunnel run the post-fix `main` release (`169e4119`), and the ChatGPT Repo Harness MCP surface executes repository commands again (no `PROCESS_LEASE_CONFLICT`).
> **Updated At**: 2026-08-07
> **Source**: Runtime status projection (`runtime/status.json`), whole-release authority (`runtime/releases/authority.json`), Recovery connector verification, authenticated MCP `controller_ready` calls, and local/public HTTP probes.
> **Target**: Keep one canonical Forge Runtime release aligned with `main`, one Recovery service family, and the renamed `/Users/greyson/DevProjects/forge` paths.
> **Stale After**: 24h

This snapshot is a read model, not an execution gate.

## Current Focus

- ✅ Unified `forge-runtime` is `ready: true` on port 8765 under one launchd service owner; the legacy Supervisor/daemon/slots architecture is deleted in source and not running.
- ✅ `controller_ready` (read-only Repo Harness tool) succeeds locally and through the public tunnel; `/ready` returns HTTP 200 locally and publicly.
- ✅ Recovery Gateway (8787), Watchdog, and dedicated cloudflared tunnel run on the renamed Controller Home and pass `forge recovery verify` and `verify-connector`; the Recovery MCP surface now exposes `activate_runtime_release`.
- ✅ Repository registry migrated to `displayName: Forge`, `canonicalRoot/localRoot: /Users/greyson/DevProjects/forge` with the original `repo_123b7cf58b6b17b5cbe46a56` id preserved.
- ✅ CLI fix: `forge mcp setup chatgpt` no longer suggests the nonexistent `forge mcp keepalive`; the official `forge runtime service install --stage-only` and `forge recovery restart-runtime|recover|rollback|restart|activate-runtime` surfaces are implemented and documented.
- ✅ `/usr/bin/true` executes through the Repo Harness Process Runtime with exit 0 (`process_direct`); no `PROCESS_LEASE_CONFLICT: runtime-authority@runtime-fence` remains.
- ✅ MCP tool fingerprint refreshed: gateway `toolSurfaceFingerprint=6319a970d884e711`, `mcp.runtime.json` generation points at the new Runtime release.

## Validation Completed

- `bun scripts/verify-forge-runtime.sh` (6 selected runtime suites + typecheck): 0 failures.
- Focused runtime/CLI suites (runtime command surface, canonical single Runtime, MCP setup hint, release store, service contract, lifecycle authority): 33/33 passed.
- `bun run check:task` gate passed; `bun scripts/check-runtime-architecture.mjs` passed (44 required modules/documents).
- Runtime restart via `launchctl kickstart` recovered to ready in seconds; Recovery Gateway/Watchdog kickstart recovered on the new release path.
- Public `https://mcp.moretea-lab.tech/mcp` returns an authenticated MCP response (no 502); `controller_ready` succeeded through the public endpoint.

## Remaining Before Delivery

- Activate the final releases built from the merged `main` HEAD and re-run the required checks.
- Keep the compatibility symlink `repo-harness-controller-runtime -> forge` until Runtime, registry, Recovery, and tunnel all use the renamed path and reboot recovery is verified.
- Preserve `scripts/TM17Runner.app/` and `scripts/tm17-ui-step.command` (untracked, must not be committed).


## Authority T2 Progress

- `9b3e2ae7f` is merged locally: Requirement, Plan, and Work runtime records use Controller-home SQLite per-record transactions with revision/CAS fencing; legacy JSON/index data is imported only when the new namespace is absent.
- Requirement lifecycle and active-plan binding, Plan per-record persistence, Work per-record persistence, WAL-safe backup/restore, and focused regression tests are implemented.
- `check:type`, `check:runtime-architecture`, `check:test-governance`, `check:public-docs`, affected tests, and `check:controller-v8` pass. The Controller V8 repair also propagates immutable release `executionMode` into candidate/rollback canary checks and aligns MCP assertions with the shipped bounded stable schema. No runtime activation or rollout was performed.
