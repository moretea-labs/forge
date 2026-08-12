# Control-plane authority inventory

Status: current implementation  
Cutover date: 2026-08-05

## Invariant

Each mutable control-plane record family has exactly one writer. For the
migrated families below that writer targets
`<durable-controller-home>/control-plane.sqlite`. Git stores source and accepted
documentation; artifact roots store bounded external evidence. Neither is a
second lifecycle writer.

## Mutable families and writers

| Family | SQLite identity | Sole writer boundary | Read/default projection |
| --- | --- | --- | --- |
| Requirement | `requirement/controller/<requirementId>` | Requirement store and Requirement facade CAS operations | Requirement Board |
| ExecutionPlan | `plan_contract/<repoId>/<planId>` | Plan-contract store and migrated completion transaction | Requirement Board and Execution Diagnostics |
| PlanStep | versioned member of its ExecutionPlan row | Plan mutation transaction; never Task JSON | Execution Diagnostics; deprecated Task alias derives from this state |
| Work and Requirement/Plan relationship | Work/contract namespaces scoped to repository | Work lifecycle store | Execution Diagnostics |
| Portfolio migration marker | `requirement_portfolio_migration/<repoId>/requirement-portfolio-20260802-v1` | one-time migration transaction | cutover guard and audit diagnostics |
| Revision/audit | `control_plane_records`, `control_plane_audit` | SQLite store transaction | integrity and recovery inspection |
| Repository identity | Git and repository registry, not Issue/Task | repository registration and Git observation paths | Work/diagnostic identity fields |
| Logs, binaries and large evidence | artifact files referenced by stable IDs | process/check/artifact owners | evidence references only |

## Frozen compatibility surfaces

The following surfaces have no durable runtime mutation authority after the
migration marker exists:

- repository Issue JSON/Markdown creation, status, archive and update;
- repository Task status, verification, completion and dependency mutation;
- `currentIssue` and legacy project-state mutation;
- legacy project-board mutation and default Issue/Task board;
- task-ledger and handoff artifact writes;
- governance reconciliation that mutates Issue/Task/project state;
- MCP aliases for legacy Issue/Task/currentIssue mutation;
- Local Bridge Issue/Task/currentIssue mutation routes;
- fallback overwrite or repository-to-SQLite reconciliation;
- Work-to-Task durable reverse projection.

Pre-cutover parsing helpers and ephemeral Issue support may remain for an
unmigrated fixture or historical tool compatibility. Every durable public entry
checks the migration marker before reading or writing a legacy file. This is not
a dual-writer allowance.

## Compatibility read contract

A historical Issue/Task alias may appear only in Execution Diagnostics or an
explicit legacy read API. Its state is derived from authoritative Requirement,
ExecutionPlan, PlanStep and Work rows. Responses identify themselves as
`deprecated`, `frozen`, `readOnly` and `controller-home-sqlite` authoritative.
Changing the source Issue/Task file after cutover cannot alter the projection.

The default user view is Requirement Board. It does not select a
`currentIssue`, expose a mutable legacy board or infer execution state from Git
JSON.

## Export contract

`requirement-portfolio-export` is SQLite-to-offline only. It includes the source
revision, migration fingerprint, per-record SQLite revisions and a content
fingerprint. Publication is staged and atomic. It cannot target `tasks/issues`,
has `replayAllowed: false`, and export failure does not affect the committed
SQLite transaction.

## Deletion verification

The final cutover tests prove:

1. all durable Issue/Task writer entry points fail at the cutover guard;
2. no source file contains both an authoritative SQLite writer call and a
   legacy writer call;
3. no reverse export importer or stale-projection replay path exists;
4. late legacy writes leave SQLite-derived views unchanged;
5. Canonical Runtime and standalone Recovery minimum bootstrap do not depend on
   legacy Issue/Task files.

Any later non-critical compatibility residue is recorded as a
MaintenanceFinding. It does not reopen a completed Requirement unless the user
outcome itself regresses.

## Session continuation versus HandoffItem

The frozen `handoff artifact writes` rule refers to lifecycle/decision handoff state. Current hooks may write only the ignored, rebuildable host-session cache under `.ai/harness/session/`; those files are projections for fresh-session context and are never control-plane writers.

A decision requiring ChatGPT or user judgement is represented by Runtime `HandoffItem` and surfaced through `rh_inbox`. Session Markdown cannot create, acknowledge, resolve, dismiss, supersede, or expire a `HandoffItem`.

`HandoffItem` persistence intentionally remains Controller-owned JSON at `Controller Home/repositories/<repoId>/handoff-inbox/index.json`, written atomically under the repository handoff-inbox lock. It is the sole authority for the attention/decision inbox. It is not moved into the Requirement/Plan/Work SQLite tables merely for storage uniformity: those tables own transactional delivery lifecycle, while the inbox owns bounded human/controller judgement points. Runtime restart recovery reopens this Controller Home record; repo-local session, projection, controller-packet, and transfer files are never replayed into it.

Repo-local recovery artifacts now have disjoint namespaces: `.ai/harness/session/` for rebuildable host-session context, `.ai/harness/controller/packets/` for bounded external-controller packets, `.ai/harness/projections/` for read-only compatibility/status views, and `.ai/harness/transfers/` for patch-transfer artifacts. The generic `.ai/harness/handoff/` namespace is retired.

See `docs/architecture/current/legacy-governance.md` for the RepoHarness-to-Forge disposition rules.
