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
