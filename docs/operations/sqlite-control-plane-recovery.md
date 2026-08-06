# SQLite control-plane backup and recovery

Status: current runbook  
Authority: `<durable-controller-home>/control-plane.sqlite`

## Safety boundary

Recovery restores only a verified SQLite backup. Do not copy, replay or merge
repository Issue/Task JSON, Markdown, project-state, task-ledger output or an
offline export into an existing control-plane database. Those files are frozen
compatibility material and may be stale.

Canonical Runtime bootstrap and standalone Recovery retain their minimum
capability without consulting legacy Issue/Task files. If the database is
unavailable, Recovery may diagnose, require the Runtime to be stopped, inspect
local backups and restore a verified database; it must not synthesize authority
from Git JSON.

## Backup

1. Resolve the durable Controller home and exact repository/check-out identity.
2. Create a new backup path; never overwrite an earlier backup.
3. Use the control-plane backup API, which snapshots through SQLite and then
   verifies `quick_check`, the required schema, required tables, record count and
   audit continuity.
4. Record the repository ID, checkout ID, branch and HEAD associated with the
   backup evidence. Do not place secrets, credentials, logs or binaries in the
   database or backup metadata.

A backup is not restorable merely because it is a readable file. It must pass
the same supported-schema and audit-continuity validation as the live database.
The database and every backup are local project-execution data below Controller
Home. They are never committed, packaged, embedded in a Runtime release, listed
as manifest payload, or sent to another user; only schema compatibility metadata
belongs to the distributed release contract.

## Restore

1. Fence normal control-plane writers.
2. Verify the candidate backup before changing the live path.
3. Copy it to a staging path under the durable Controller home.
4. Re-run integrity, schema and audit-continuity checks against staging.
5. Remove stale WAL/SHM sidecars and atomically rename staging into the live
   `control-plane.sqlite` path.
6. Reopen the database and verify Requirement, Plan, PlanStep and Work
   relationships, revisions and exact repository/check-out/branch/HEAD
   identity.
7. Restart the daemon and compare Requirement Board plus Execution Diagnostics
   with the pre-restart inspection.

A failed staging verification leaves the current authority untouched. Never
replace corruption with an empty database and never downgrade an unknown
required schema version.

## Acceptance checks

A recovery is accepted only when:

- SQLite integrity is `ok`;
- the schema version is supported;
- every current record revision has a matching audit event;
- Requirement-to-Plan and Plan-to-Work relationships are preserved;
- repository, checkout, branch and HEAD identity are unchanged;
- daemon restart produces the same authoritative state;
- no Issue/Task, `currentIssue`, legacy board or export file was used as input.
