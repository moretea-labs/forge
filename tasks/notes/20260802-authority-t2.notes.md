# Authority T2 implementation notes

Date: 2026-08-02

## Delivered

- Added transactional SQLite Requirement records under `requirement/controller/<requirementId>` with user lifecycle states, orthogonal `needsAttention`, active plan binding, monotonic payload revision, and audited CAS updates.
- Added transactional SQLite PlanContract records under `plan_contract/<repoId>/<planId>` with per-record revision fencing and one-time legacy JSON import.
- Changed runtime WorkContract storage from one mutable SQLite index record to one SQLite record per Work under `work_contract/<repoId>/<workId>`. Existing JSON/index data is read only when no per-Work rows exist and imported once; subsequent writes are per-Work rows in one transaction.
- Added focused tests for Requirement lifecycle, Plan revision conflicts, Work compatibility, and WAL-safe backup/restore.

## Verification

- `bun run check:type`
- `bun run check:runtime-architecture`
- `bun run check:test-governance`
- `bun run test`
- Focused Requirement/Plan/Work tests: 12 passing

No runtime activation, rollout, slot switch, release switch, restart, or remote write was performed.


## Controller V8 gate repair (2026-08-02)

- The restored stable MCP contract keeps `advanced` as the default and exposes the bounded 128-tool stable schema; `core` remains a compatibility label for the same schema. The stale compact-Core assertions were updated to the shipped contract.
- Release canary verification now propagates each immutable release's manifest `executionMode` when validating candidate and rollback releases. Without this, compiled `process-runner.js` artifacts were incorrectly passed to Bun as source scripts and failed with `Unexpected �`.
- Regression coverage: `bun test tests/cli/mcp-controller.test.ts tests/runtime/runtime-observability.test.ts` — 46 passing; `bun run check:controller-v8` — 6 selected files passing and typecheck passing.
- Additional checks: `bun run check:public-docs`, `bun run check:type`, `bun run check:runtime-architecture`, `bun run check:test-governance`, `bash scripts/check-task-sync.sh`, and `bash scripts/check-task-workflow.sh --strict` passed. The workflow check reported existing ignored generated-runtime remediation notices only.