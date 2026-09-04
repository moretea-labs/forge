# Repository / Runtime Data Boundary

Status: accepted for Kernel V2

## Decision

The Git working tree is an authored product and engineering surface, not a Runtime database or cache root. Forge keeps four storage classes distinct:

1. **Repository-authored truth**: source, tests, human-maintained product/architecture/research/deferred-goal documents, and declarative project configuration. Git owns history. A path under `plans/` or `tasks/` is not source merely because of its directory name; generated lifecycle projections remain machine state.
2. **Durable machine authority**: Requirement/Plan/Work/Controller/session/lease/evidence state lives in Controller Home SQLite or a Controller-owned repository namespace.
3. **Provider artifacts and rebuildable cache**: browser profiles/captures/downloads, interaction state, check receipts, generated caches and similar machine output live below Controller Home and carry explicit retention/GC rules.
4. **Ephemeral scratch**: short-lived process scratch lives in the OS temporary directory and must be removable after process ownership expires.

Repository-local `.ai/harness/*`, `.forge/*`, `_ops/`, `.repo-harness/`, and `.codegraph/` machine state may exist only as explicit migration inputs/compatibility links to Controller Home. New physical Runtime writers must not be added under the repository root. `forge.config.json` is the small declarative project opt-in marker and contains no mutable Runtime state.

## Lifecycle and Retention

- **Authority retirement is immediate.** When a Plan is superseded/cancelled/finalized, any non-terminal Work that still derives execution authority from that terminal Plan must be rebound through an explicit successor transaction or terminalized. It must disappear from current/admission projections immediately even though its history row remains durable.
- **History retention is separate from authority.** Requirement/Plan/Work terminal records remain queryable for bounded audit, lineage, rollback/recovery and acceptance evidence. A retained historical row is never considered active merely because it still exists in SQLite.
- **Physical GC is last.** Terminal/no-op records and artifacts may be deleted only after no active authority, successor obligation, audit reference, rollback window or recovery hold depends on them and the configured age/count/size retention policy is satisfied. SQLite deletion/compaction must not be the mechanism that makes authority non-current.
- Human-readable Requirement/Plan/Work views are optional read-only projections. If materialized at all they have one stable identity per projected view, explicit source revision/freshness, are fully regenerable from Controller Home, and are replaced rather than accumulated. They never participate in lifecycle transitions. Human-authored plans may remain in Git only when they are independently useful design documents, not because PlanContract requires a Markdown twin.
- Provider artifacts use bounded age/size/ownership retention. Durable semantic history is retained in the Control Plane, not by accumulating filesystem snapshots or `*-archive` trees in the repository.
- Compatibility links are transitional API surfaces. They do not make the repository the storage authority.

## Enforcement

`check:repository-hygiene` is part of the governed task gate. It rejects retired live roots and known physical Runtime/cache namespaces in the source tree. Runtime storage initialization migrates Browser provider state and interaction sessions into the repository's Controller Home namespace.
