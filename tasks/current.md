# Current Status Snapshot

<!-- updated_at: 2026-08-09 -->
<!-- stale_after: 24h -->

> **Status**: Runtime stability source fixes are committed on `main`; current closeout work adds a first-party Resend reporting sink with environment-only credentials, strongly confirmed delivery, provider receipt lookup, and explicit domain/SMTP readiness. Live Resend delivery remains externally blocked until an API key, verified sending domain, and sender identity are configured.
> **Updated At**: 2026-08-09
> **Source**: Source review, focused Runtime/MCP tests, authenticated `repo-harness6` session evidence, repeated 60-second Controller RPC timeouts, and connector/source schema comparison.
> **Target**: Keep one canonical Forge Runtime release aligned with `main`, one Recovery service family, and the renamed `/Users/greyson/DevProjects/forge` paths.
> **Stale After**: 24h

This snapshot is a read model, not an execution gate.

## Current Focus

- ✅ First-party `resend` plugin source now exposes non-secret configuration, auth/domain/SMTP status, domain verification, strongly confirmed sending, and sent-message receipt lookup; the personal-assistant reporting model includes a disabled-by-default `resend_email` sink.
- ⚠️ `FORGE_RESEND_API_KEY` / `RESEND_API_KEY` and `.forge/plugins/resend.json` are absent in the current checkout, so no live email can be sent or claimed as accepted yet.
- ✅ `ce6834e5b` fixes compiled `forge-runtime` Worker launch recursion by resolving the real Bun executable and preserves structured Runtime core-failure stderr.
- ✅ Canonical `controller_ready` now compares the startup source snapshot with `ctx.runtimeSourceRoot`, eliminating false `RUNTIME_SOURCE_SNAPSHOT_STALE` diagnostics caused by the Gateway process cwd.
- ✅ Startup and periodic ExecutionJob reconciliation isolate a malformed historical Job, continue healthy Job cleanup, remove timed-out Jobs from the active index, and release their Leases; `WRITER_FENCED` still fails the complete Runtime.
- ⚠️ Live `controller_context`, `work_prepare`, `controller_capabilities`, and `workflow_watchdog_report` calls timed out or failed at the Controller transport. Source fixes are verified but intentionally not activated under this slice's no-rollout/no-restart constraint.
- ⚠️ Source `rh_work` supports `controller_claim` and `launcher_start`; the current ChatGPT connector snapshot exposes `rh_work` but its operation enum stops at `delegate`. `quick_agent_session` remains a compatibility tool with an intentional retirement response.

### Prior deployed baseline (2026-08-07)

- ✅ Unified `forge-runtime` is `ready: true` on port 8765 under one launchd service owner; the legacy Supervisor/daemon/slots architecture is deleted in source and not running.
- ✅ `controller_ready` (read-only Repo Harness tool) succeeds locally and through the public tunnel; `/ready` returns HTTP 200 locally and publicly.
- ✅ Recovery Gateway (8787), Watchdog, and dedicated cloudflared tunnel run on the renamed Controller Home and pass `forge recovery verify` and `verify-connector`; the Recovery MCP surface now exposes `activate_runtime_release`.
- ✅ Repository registry migrated to `displayName: Forge`, `canonicalRoot/localRoot: /Users/greyson/DevProjects/forge` with the original `repo_123b7cf58b6b17b5cbe46a56` id preserved.
- ✅ CLI fix: `forge mcp setup chatgpt` no longer suggests the nonexistent `forge mcp keepalive`; the official `forge runtime service install --stage-only` and `forge recovery restart-runtime|recover|rollback|restart|activate-runtime` surfaces are implemented and documented.
- ✅ `/usr/bin/true` executes through the Repo Harness Process Runtime with exit 0 (`process_direct`); no `PROCESS_LEASE_CONFLICT: runtime-authority@runtime-fence` remains.
- ✅ MCP tool fingerprint refreshed: gateway `toolSurfaceFingerprint=6319a970d884e711`, `mcp.runtime.json` generation points at the new Runtime release.

## Validation Completed

- `bun test tests/runtime/capability-recovery.test.ts`: 29/29 passed, including terminal committed/superseded/unique-dirty, active/missing ownership, empty-session, explicit-full-only, summary, and legacy maintenance coverage for stale Edit Sessions.
- `bun test tests/runtime/process-environment.test.ts`: 5/5 passed.
- `bun test tests/runtime/canonical-single-runtime.test.ts`: 16/16 passed (previously 15/16).
- `bun test tests/runtime/execution-job-reconciliation.test.ts`: 3/3 passed.
- `bun test tests/runtime/runtime-source-isolation.test.ts`: 11/11 passed.
- `bun test tests/cli/mcp-controller.test.ts`: 36/36 passed.
- `bun scripts/verify-forge-runtime.sh` (6 selected runtime suites + typecheck): 0 failures.
- Focused runtime/CLI suites (runtime command surface, canonical single Runtime, MCP setup hint, release store, service contract, lifecycle authority): 33/33 passed.
- `bun run check:task` gate passed; `bun scripts/check-runtime-architecture.mjs` passed (44 required modules/documents).
- Runtime restart via `launchctl kickstart` recovered to ready in seconds; Recovery Gateway/Watchdog kickstart recovered on the new release path.
- Public `https://mcp.moretea-lab.tech/mcp` returns an authenticated MCP response (no 502); `controller_ready` succeeded through the public endpoint.

## Remaining Before Delivery

- Activation of the final immutable release remains with the external Runtime lifecycle owner; this stability slice explicitly performed no rollout or Runtime restart.
- Refresh/reconnect the external ChatGPT connector after activation so its cached `rh_work` schema includes `controller_claim` and `launcher_start`, then re-run live `controller_ready`, capabilities, and watchdog probes.
- Keep the compatibility symlink `repo-harness-controller-runtime -> forge` until Runtime, registry, Recovery, and tunnel all use the renamed path and reboot recovery is verified.
- Preserve `scripts/TM17Runner.app/` and `scripts/tm17-ui-step.command` (untracked, must not be committed).


## Authority T2 Progress

- `9b3e2ae7f` is merged locally: Requirement, Plan, and Work runtime records use Controller-home SQLite per-record transactions with revision/CAS fencing; legacy JSON/index data is imported only when the new namespace is absent.
- Requirement lifecycle and active-plan binding, Plan per-record persistence, Work per-record persistence, WAL-safe backup/restore, and focused regression tests are implemented.
- `check:type`, `check:runtime-architecture`, `check:test-governance`, `check:public-docs`, affected tests, and `check:controller-v8` pass. The Controller V8 repair also propagates immutable release `executionMode` into candidate/rollback canary checks and aligns MCP assertions with the shipped bounded stable schema. No runtime activation or rollout was performed.
