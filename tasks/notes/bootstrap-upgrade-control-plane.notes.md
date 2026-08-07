# Bootstrap / Upgrade / Restart control plane (2026-08-07)

Slice notes for restoring a stable single-Runtime state on `main@668ffbe7` and adding a
formal Recovery-owned upgrade path. Full acceptance converges later via ChatGPT + Repo Harness.

## Decisions

- Kept the existing architecture. The standalone Recovery already owned restart/rollback;
  the missing piece was activating a new immutable Runtime release without the primary
  Runtime execution plane. Added one bounded operation (`activate_runtime_release`) to
  standalone Recovery core, its CLI (`forge-recovery activate-runtime-release`) and MCP
  surface (`forge recovery activate-runtime`), mirroring `recover_primary_runtime`:
  stop -> publish authority (SQLite backup) -> start -> verify -> rollback on failure.
- Runtime lifecycle commands live under `forge recovery` (restart-runtime / recover /
  rollback / restart / activate-runtime / install / verify / status). `forge runtime`
  stays read-only by design (existing test contract forbids a `runtime restart` owner).
- Diagnostics no longer recommend the nonexistent `bun run controller:restart`; they now
  name `forge recovery restart-runtime` and `forge runtime status`.
- MCP hints now spell the callable operations as `rh_work.controller_claim` /
  `rh_work.launcher_start` (operations of the exposed `rh_work` tool), matching the real
  ChatGPT schema.

## Pre-existing defects fixed (blocked the required typecheck gate)

- `tests/runtime/process-runtime.test.ts` contained two literal `[REDACTED]` placeholders
  (invalid TS) committed at `4d758a02`; restored numeric `terminalFenceToken` values.
- That parse error masked 20 latent type errors in `WorkCompletionReceipt` union handling
  (requirement-store, requirement-board, work-contract-store, work-task-receipt,
  read-only-tool). Narrowed to repository completion receipts; no behavior change for
  repository receipts, local-effect receipts now fail closed where delivery/cleanup fields
  were previously read.

## Open items / environment notes

- `bun run smoke:mcp-http-runtime` fails on this host both before and after the change
  (HTTP_SMOKE_TIMEOUT on the spawned /health); pre-existing environment issue, not caused
  by this diff.
- The ChatGPT-facing `forge mcp serve` gateway (8767) runs from the source checkout; it
  was restarted to load the current source (readonly commands now bypass writer leases).
