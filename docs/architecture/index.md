# Architecture Index

> Architecture request index and compatibility entry point. **Runtime Authority:** [`CURRENT.md`](CURRENT.md).

The canonical documentation model is intentionally small:

- [`CURRENT.md`](CURRENT.md) — sole maintained current architecture authority.
- [`../ROADMAP.md`](../ROADMAP.md) — current and next architecture/product priorities.
- [`EVOLUTION.md`](EVOLUTION.md) — append-only historical architecture change log.
- [`versions/`](versions/) — per-version architecture snapshots.
- [`../../CHANGELOG.md`](../../CHANGELOG.md) — release history.
- `decisions/` — accepted ADRs that have not yet been folded into `CURRENT.md`.
- `requests/` — pending architecture drift/change requests only.
- `researches/`, plans and task records — evidence, not architecture authority.

Executable code and persisted schemas are authoritative for implementation facts. `CURRENT.md` defines the architecture contract; a version snapshot or historical note never overrides it.

## Pending Architecture Requests

<!-- BEGIN ARCHITECTURE PENDING REQUESTS -->
- (none)
<!-- END ARCHITECTURE PENDING REQUESTS -->

## Accepted Architecture Decisions

Existing accepted ADRs remain under [`decisions/`](decisions/). Once a decision becomes ordinary current architecture, its durable rule should be folded into `CURRENT.md`; the ADR remains historical rationale.

## Change discipline

Do not create another current-architecture page for each refactor. Update `CURRENT.md` only when the architecture contract changes, update `ROADMAP.md` when priorities change, append `EVOLUTION.md` for material architecture transitions, and create/update a version snapshot only at a release/version boundary.
