# Controller-home SQLite state authority

Status: accepted  
Date: 2026-08-01

## Decision

Controller-owned mutable execution facts will converge on a SQLite database at
`<durable-controller-home>/control-plane.sqlite`. The database is local to the
Controller installation, never a repository worktree. It is the authority for
migrated records; JSON files are import-only compatibility inputs, not a
mirrored write target.

The initial schema intentionally has one versioned record envelope rather than
an ORM or a premature table per product concept:

- `control_plane_records` has a namespace, scope, record key, schema version,
  monotonic revision, JSON payload, and timestamps;
- its primary key gives one atomic identity per durable fact;
- `control_plane_audit` records each authoritative write or legacy import;
- SQLite WAL, foreign-key enforcement, a busy timeout, and `BEGIN IMMEDIATE`
  make cross-process writes serializable; and
- `control_plane_schema` records schema migrations independently from payload
  versions.

The adapter uses Bun's bundled SQLite binding in the normal runtime and Node
22's built-in SQLite fallback for the package launcher. No native npm module or
ORM is introduced.

## Authority boundaries

| Data | Authority | Repository projection |
| --- | --- | --- |
| Execution sessions, Work handles, work-prepare idempotency claims, and WorkContracts | Controller-home SQLite as each namespace migrates | Legacy JSON is readable only for first import; it is never rewritten |
| Leases, process receipts, Jobs, Runs, checks, and evidence | Existing controller-home stores until their named migration | Existing artifacts remain evidence/read compatibility sources |
| Repository identity, checkout/worktree/branch/HEAD observations | Git plus the Controller repository registry | Never inferred from an Issue or handoff |
| Issue/Task intent, plans, architecture decisions, and user-facing status | Git-tracked documents until their explicit projection migration | Canonical human-reviewable content, not a runtime mutation log |
| Secrets and credentials | External credential providers or OS-managed stores | Never stored in SQLite payloads, projections, receipts, or audit data |

SQLite records are structured facts and bounded evidence references. Large logs,
binary artifacts, and source diffs remain filesystem artifacts addressed by
stable IDs and content/revision metadata.

## Migration and rollback rules

1. Read the SQLite record first. If it exists, ignore any legacy JSON changes.
2. If no record exists, validate and import exactly one legacy JSON value in a
   transaction. A malformed record fails closed and changes neither source.
3. After import, all writes go only to SQLite. A projection can be regenerated
   later, but cannot become a second mutation authority.
4. Each namespace migrates independently with focused compatibility and crash
   tests. Do not batch-migrate all controller directories.
5. A failed payload/schema migration rolls back its transaction and preserves
   the last known-good record. Downgrade readers must reject unknown required
   versions rather than overwrite them.
6. A reversible rollback means selecting the prior database backup or a
   verified read-only JSON import path before a namespace cutover; it never
   means replaying stale JSON on top of an existing SQLite row.

## Rollout sequence

1. Establish the durable SQLite envelope and migrate the execution session,
   Work-handle, idempotent work-prepare, and WorkContract namespaces.
2. Migrate process/check receipts and lease ownership, retaining exact Git
   identity in every verification record.
3. Migrate controller-owned Run, Job, and evidence indexes; keep append-only
   artifacts outside the database.
4. Generate bounded task/status projections from controller facts, then decide
   whether Issue/Task records remain Git-authoritative or receive a separately
   reviewed controller projection boundary.
5. Only after the above is stable, migrate Campaign and optional plugin state.

Each phase requires focused concurrent-write, interrupted-write, legacy-import,
restart, and stale-revision tests before the next namespace becomes
authoritative.

## Current implementation

Phase 1 has migrated execution sessions, Work handles, idempotent
work-prepare claims, and WorkContract stores. Their old JSON locations are
retained solely for first-read import compatibility. Issue and Task JSON/Markdown
have not migrated, so they must not be described as SQLite-backed runtime state.
