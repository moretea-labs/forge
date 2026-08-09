# Current Status Snapshot

<!-- updated_at: 2026-08-09 -->
<!-- stale_after: 24h -->

> **Status**: The canonical immutable Runtime now runs `bc2badee` and is ready. Explicit full maintenance safely cancelled four stale WorkContracts and reconciled ten Work-bound stale Edit Sessions without rolling back source. The complete retained legacy inventory is documented: 1,318 nonterminal sessions all lack durable `workId` ownership evidence and remain fail-closed. Live Resend delivery remains externally blocked until an API key, verified sending domain, and sender identity are configured.
> **Updated At**: 2026-08-09
> **Source**: Source review, focused Runtime/MCP tests, authenticated `repo-harness6` session evidence, repeated 60-second Controller RPC timeouts, and connector/source schema comparison.
> **Target**: Keep one canonical Forge Runtime release aligned with `main`, one Recovery service family, and the renamed `/Users/greyson/DevProjects/forge` paths.
> **Stale After**: 24h

This snapshot is a read model, not an execution gate.

## Current Focus

- ✅ An enabled implicit/embedded Local Bridge is now owned by the Canonical Runtime as an in-process HTTP UI/API module. Runtime startup publishes current PID/endpoint/generation evidence; ordered shutdown closes the listener and marks the compatibility projection stopped. Explicit standalone/remote modes remain externally owned.
- ✅ Terminal Process lease cleanup now persists a redacted structured failure diagnostic while retaining the canonical `pending` retry phase; exact-set/scope/fencing failures stay fail-closed, restart recovery retries them, and success clears the diagnostic without adding a second recovery owner.
- ✅ Explicit full maintenance has zero remaining safe stale Work/Edit candidates. Four WorkContracts were cancelled with evidence retained; ten Work-bound sessions were finalized, superseded, or rolled back through existing cleanup semantics.
- ⚠️ The full local inventory contains 1,318 retained nonterminal legacy Edit Sessions (`dirty` 1,179 / `open` 130 / `checked` 2 / `check_failed` 7). Every record lacks `workId`, so ownership cannot be proven and automatic cleanup correctly fails closed; all session IDs and the closeout rule are recorded in `docs/researches/20260809-stale-edit-session-inventory.md`.
- ✅ Runtime release `1786276859850-bc2badee7b6ce5e8769ee1f89ef7680a47eca25b` is active at PID 48981 with database, scheduler, release coherence, and MCP end-to-end diagnostics passing; queue, workers, and leases are zero for Forge.
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

- Live audit before the fix proved the warning was real: service runtime state claimed embedded PID 60290 at `127.0.0.1:8766`, but the PID and listener were absent. Runtime tool discovery contained exactly 123 tools, expected/actual counts matched with no missing/unexpected/duplicate entries, and neither retired `self_healing_monitor_tick` nor `self_healing_loop_plan` was advertised.
- `bun test tests/runtime/canonical-single-runtime.test.ts`: 18/18 passed, including same-process Local Bridge start/health/projection/close evidence and ordered complete-Runtime shutdown.
- `bun test tests/runtime/process-runtime.test.ts`: 51/51 passed, including normal exactly-once release, exit-receipt conflict recovery, terminal records missing from active index, whole-release change recovery, fencing mismatch fail-closed, visible transient failure plus successful retry, and read/write contention.
- Live Process `proc_mslrbu8k_bdf30891` completed `package:check:type` with workspace-read/build-cache-write leases, terminal status `succeeded`, `leaseReleaseState=released`, and no active lease files. Historical failure `proc_mslcn0gt_9c86a2f5` is also terminal with all three recorded leases released. A typed `/usr/bin/true` readonly command used `readonly_fast_path` with no Process record or execution lease.
- Live `runtime_maintenance_status` after the final explicit pass reported zero safe candidates, zero stale WorkContracts, and 437 protected unknown-owned Edit Sessions inside its bounded 500-candidate window; an unbounded local metadata scan accounted for all 1,318 retained IDs.
- `EDIT-1786271171326-396c4572` received exact-revision Process Check receipt `check_receipt_c55cb76569e2b352cd867080` for `package:check:type`, then maintenance finalized it without source rollback.
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
