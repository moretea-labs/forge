# Control-plane state store inventory

Date: 2026-08-01  
Updated: 2026-08-05  
Status: implemented inventory for the Requirement SQLite cutover

## Authority rule

`<durable-controller-home>/control-plane.sqlite` is the sole mutable authority
for every namespace listed as migrated below. Requirement, ExecutionPlan,
PlanStep, Work relationships, lifecycle, revision, migration idempotency and
audit are cut over. Repository Issue/Task documents are frozen history and
one-time import evidence; they are not a temporary authority anymore.

A compatibility read checks SQLite first. If an authoritative row exists, all
later JSON or Markdown changes are ignored. No code path may replay, reconcile
or overwrite an existing SQLite row from repository Issue/Task state. Optional
exports flow only from SQLite to an explicit offline directory and carry source
revision, SQLite revisions and content fingerprints.

## Current state classes

| Record family | Current authority | Filesystem role | Cutover state |
| --- | --- | --- | --- |
| Execution session, Work handle, work-prepare idempotency and WorkContract | Controller-home SQLite | first-import compatibility and bounded artifacts only | migrated |
| Requirement | Controller-home SQLite namespace `requirement/controller` | frozen aliases and one-way export only | migrated |
| ExecutionPlan and PlanStep | Controller-home SQLite namespace `plan_contract/<repoId>`; PlanSteps are versioned inside the Plan | frozen Issue/Task aliases and one-way export only | migrated |
| Requirement portfolio migration marker | Controller-home SQLite namespace `requirement_portfolio_migration/<repoId>` | reviewed Git mapping remains immutable design evidence | migrated |
| Work relationships and completion linkage | Controller-home SQLite Work/contract namespaces | logs and large evidence remain external artifacts referenced by IDs | migrated |
| Control-plane revision and audit | `control_plane_records` and `control_plane_audit` | no writable repository mirror | migrated |
| Process logs, check output, large evidence, diffs and binaries | bounded artifact roots | authoritative artifact bytes; SQLite stores only IDs, hashes and revisions | intentionally remain files |
| Repository identity, checkout, branch and HEAD | Git plus Controller repository registry | never inferred from Issue/Task | unchanged |
| Secrets and credentials | provider or OS-managed secret stores | forbidden in migration/export payloads, SQLite records and audit | excluded |
| Legacy Issue/Task JSON and Markdown | none for runtime mutation | frozen history or reviewed first-import source | retired |
| `currentIssue`, legacy project state, project board and task ledger | none for runtime mutation | deprecated frozen projection only | retired |

## Implemented controls

1. Existing SQLite rows always win over legacy files.
2. Migration writes Requirement, Plan and marker rows inside one transaction;
   interruption at any write boundary rolls the entire transaction back.
3. Unknown required schema versions and corrupt databases fail before schema
   initialization or overwrite.
4. Concurrent updates use revision CAS and fail closed.
5. Backups are produced from SQLite, then integrity/schema/audit continuity are
   verified. Restore validates a staging copy before atomic replacement.
6. Offline export is staged and atomically published. Export failure does not
   roll back or alter authoritative writes.
7. Migration and export reject secrets, credentials, binary payloads and large
   log-like strings.
8. Stable Supervisor bootstrap and standalone Recovery do not read Issue/Task
   files for minimum recovery capability.
9. Default MCP and Local Bridge views expose Requirement Board plus Execution
   Diagnostics; legacy aliases are labelled deprecated/frozen/read-only.
10. Durable Issue, Task, `currentIssue`, project-board, task-ledger and
    governance reconciliation mutations fail at the public boundary after
    cutover.

## Rollback boundary

Before a migration transaction commits, failure leaves no partial namespace.
After cutover, rollback means restoring a verified SQLite backup that preserves
record revisions, audit continuity and Requirement/Plan/Work relationships.
Repository Issue/Task JSON, Markdown, task-ledger output and offline exports are
never replayed over existing SQLite records.

The current writer-by-family inventory and deleted compatibility paths are
maintained in `docs/architecture/current/control-plane-authority-inventory.md`.
