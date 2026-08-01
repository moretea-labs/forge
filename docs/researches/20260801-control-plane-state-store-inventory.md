# Control-plane state store inventory

Date: 2026-08-01  
Status: implementation inventory for staged SQLite cutover

## Authority rule

Controller-home SQLite is authoritative only for explicitly migrated namespaces.
Git-tracked Issue/Task documents remain the human-reviewed intent and status
surface. JSON files are either append-only artifacts, compatibility import
inputs, or un-migrated authoritative stores; they must not be treated as SQLite
mirrors.

## Current state classes

| Class | Current location | Authority | Priority | Migration boundary |
| --- | --- | --- | --- | --- |
| Execution session, Work handle, work-prepare request, WorkContract, controller claim | Controller home JSON plus SQLite envelope | SQLite | migrated | one-time JSON import; subsequent writes SQLite-only |
| Process records, request/invocation bindings, leases | Controller home process directories | JSON records plus lease fencing | next | move indexes/bindings first; retain logs/exit receipts as artifacts |
| Execution Jobs and operation receipts | Controller home execution-job records/indexes | JSON records | next | Job/request/index mutation must cut over together |
| Plan contracts, handoff inbox/packets, goal contracts | Controller home JSON indexes | JSON records | later | independent bounded stores after Work/Job cutover |
| Authorization and access-policy decisions | Controller home JSON | JSON records | later | retain immutable decision/audit semantics and secret exclusions |
| Runtime/scheduler/daemon generation and wake state | Controller home JSON | runtime bootstrap state | last | defer while startup compatibility remains under repair |
| Issue/Task/Plan Markdown and JSON | Repository `tasks/`, `plans/` | Git-tracked documents | explicit decision | projections must not become a runtime write log |
| Check outputs, logs, artifacts, diffs | Artifact roots | file artifacts | remain files | SQLite stores only bounded IDs/hashes/revisions |
| Secrets/provider credentials | Secret files or provider stores | secret boundary | excluded | never place in SQLite payload/audit rows |

## Dependency order and controls

1. The migrated Work boundary (sessions, handles, idempotency, contracts, and
   controller claims) reads SQLite first and imports legacy JSON only once.
2. Migrate Process Runtime request/invocation indexes and lease records
   together: partial cutover could duplicate a launch or release the wrong
   lease.
3. Migrate Job records, request idempotency, active/recent indexes, and
   receipts as one transactional family. Logs remain files addressed by IDs.
4. Migrate Plan, handoff, and goal-contract stores after they consume stable
   Work/Job IDs rather than JSON paths.
5. Generate controller status projections only after those boundaries are
   stable; Git remains authoritative for user-authored Issue/Task intent.

For every namespace: SQLite is read first; a missing row imports exactly once;
mutations write only SQLite; every payload is versioned and audited; and
concurrent mutation, corrupt legacy projection, restart recovery, stale
revision, and rollback are tested before the next family moves. Failed
migrations roll back and stale JSON cannot overwrite an existing row.

## Immediate next slice

Map every atomic write path in `src/runtime/execution/process-runtime/store.ts`,
then migrate Process Runtime bindings and active indexes as the next state
family. This is the smallest remaining family with cross-file idempotency and
lease invariants.
