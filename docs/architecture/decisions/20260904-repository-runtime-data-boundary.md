# Repository / Runtime Data Boundary

Status: accepted for Kernel V2

## Decision

The Git working tree is an authored product and engineering surface, not a Runtime database or cache root. Forge keeps four storage classes distinct:

1. **Repository-authored truth**: source, tests, product/architecture docs, `plans/`, `tasks/`, declarative project configuration. Git owns history.
2. **Durable machine authority**: Requirement/Plan/Work/Controller/session/lease/evidence state lives in Controller Home SQLite or a Controller-owned repository namespace.
3. **Provider artifacts and rebuildable cache**: browser profiles/captures/downloads, interaction state, check receipts, generated caches and similar machine output live below Controller Home and carry explicit retention/GC rules.
4. **Ephemeral scratch**: short-lived process scratch lives in the OS temporary directory and must be removable after process ownership expires.

Repository-local `.ai/harness/*` or `.forge/*` runtime directories may exist only as explicit migration/compatibility links to Controller Home. New physical Runtime writers must not be added under the repository root.

## Retention

- Terminal/no-op legacy runtime records may be removed only after storage has been relocated outside the repository and ownership/status/age are proven. Cleanup must never create a second `*-archive` history tree in the repository.
- Provider artifacts use bounded age/size/ownership retention. Durable semantic history is retained in the Control Plane, not by accumulating filesystem snapshots.
- Human-authored plans are removed at terminal closeout only after Git and Control Plane lineage prove their final state is preserved. No `plans/archive/` is created.
- Compatibility links are transitional API surfaces. They do not make the repository the storage authority.

## Enforcement

`check:repository-hygiene` is part of the governed task gate. It rejects retired live roots and known physical Runtime/cache namespaces in the source tree. Runtime storage initialization migrates Browser provider state and interaction sessions into the repository's Controller Home namespace.
