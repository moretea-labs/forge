# Requirement-centered control plane authority

Status: accepted  
Date: 2026-08-02  
Decision owners: Controller architecture  
Supersedes: the Issue/Task Git-authority clauses in `20260801-controller-home-sqlite-state.md` and `20260801-control-plane-state-store-inventory.md`

## Context

Repo Harness currently exposes one repository Issue/Task ledger as both human planning material and mutable runtime state. Objective, scope, checks, status and completion evidence are repeated across Issue, Task, WorkContract, Run and ExecutionJob. Runtime state updates continuously dirty the source checkout, historical cleanup defects can reopen already delivered outcomes, and a technical replan often appears as a second user requirement.

The accepted SQLite envelope already proves that bounded controller facts can use one transactional Controller-home authority. This decision completes the product model and freezes the cutover boundary before implementation.

## Decision

The control plane is requirement-centered:

```text
Requirement
└── active ExecutionPlan version
    └── ordered PlanStep
        └── zero or one current Work
            └── one or more Attempt
                ├── Process / ExecutionJob / Run
                ├── Check and verification evidence
                ├── Receipt
                └── Artifact references

MaintenanceFinding ── references any entity without owning its lifecycle
```

After each namespace cuts over, `<durable-controller-home>/control-plane.sqlite` is the only mutable authority for Requirement, ExecutionPlan, PlanStep, Work relationships, lifecycle, audit and idempotency. Git keeps source, accepted architecture decisions and optional one-way exports. It is not a runtime mutation log and cannot overwrite an existing SQLite record.

## Product entities

### Requirement

A Requirement is one user-visible desired outcome. It owns:

- stable `requirement_id` and legacy aliases;
- user-language title and outcome statement;
- acceptance criteria and explicitly required delivery references;
- the active ExecutionPlan version;
- user lifecycle state and an orthogonal health marker;
- monotonic revision, timestamps and audit references.

A Requirement does not own commands, paths, executor choice, leases, Task states, checks or process details.

The only user lifecycle states are:

| State | Meaning |
| --- | --- |
| `planned` | Accepted outcome, not yet executing |
| `active` | At least one approved plan step is being prepared, executed or verified |
| `waiting_for_user` | Progress requires a user decision or authorization |
| `done` | User acceptance and required delivery evidence are satisfied |
| `cancelled` | The user outcome is intentionally abandoned or replaced |

`needs_attention` is a separate Boolean/summary health marker. It may coexist with `planned`, `active` or `done`; it is never a sixth lifecycle state.

### ExecutionPlan

An ExecutionPlan is a versioned, replaceable technical strategy for one Requirement. It owns assumptions, resolved decisions, non-goals, ordered steps, replan conditions, stop conditions and an integration strategy.

Internal plan states are `draft`, `approved`, `active`, `retired` and `superseded`. Replacing a plan creates a new version under the same Requirement. It must not create another Requirement merely because architecture, provider or sequencing changed.

At most one plan version is active for a Requirement. Historical versions remain immutable evidence.

### PlanStep

A PlanStep is a bounded dependency node inside one plan. It contains an objective, dependency IDs, authoritative files, allowed and forbidden paths, checks and acceptance criteria.

A PlanStep intentionally has no independent complex lifecycle. It is either:

- not yet materialized as Work;
- bound to one current Work; or
- derived as satisfied from the accepted Work evidence.

The materialized `workId` is the PlanStep-to-Work reference. PlanStep fields
describe the approved planning node; after materialization they are not a
second mutable execution contract.

Retry creates another Attempt for the same Work. Replan supersedes the plan step and creates a new Work only when the execution contract materially changes.

### Work

Work is the only execution contract. It is the sole mutable owner of:

- objective and expected outcome;
- repository and exact checkout/base identity;
- allowed/forbidden paths and scope;
- risk and authorization requirements;
- declared checks and verification policy;
- acceptance criteria and delivery requirements;
- execution, verification and finalization state;
- completion evidence and exact integrated revision.

Issue, Task, PlanStep, Run and ExecutionJob may reference Work but must not duplicate or override these fields after cutover.

Work has two separate vocabularies. Its compatibility status is bounded to
`open`, `running`, `blocked`, `ready`, `completed`, `failed` and `cancelled`;
it is execution state, not the user lifecycle. Its canonical technical phase
is exactly one of `implementation`, `verification`, `delivery` or `cleanup`.
Projection labels may be richer, but they cannot become another authority.

A Work may enter `completed` only through a Work-owned completion receipt that
matches the Work identity, proves an exact reachable target revision and proves
cleanup with no blockers. Historical cancelled Runs, missing receipts and
projection lag are retained as evidence or maintenance findings and cannot
rewrite a reviewed Requirement outcome.

### Attempt

An Attempt is one execution try for one Work. It records executor/provider, immutable input revision, start/end time, Process/ExecutionJob/Run references, exit/failure classification and evidence references.

Attempts never decide Requirement state directly. A failed Attempt can be followed by another Attempt without reopening or cloning the Requirement.

### MaintenanceFinding

A MaintenanceFinding records bounded operational debt such as stale projections, missing historical receipts, cleanup failures, orphaned artifacts or deprecated compatibility paths. It owns severity, status, affected entity references, remediation and evidence.

A finding may set `needs_attention`; it cannot change a Requirement from `done` unless it proves that a required acceptance criterion or delivered result is invalid.

## Completion semantics

A Requirement becomes `done` only when all of the following are true:

1. every required user acceptance criterion has provenance-aware `passed` evidence;
2. required delivery references exist and identify the delivered revision or external result;
3. all checks classified as critical for the Requirement have valid passing evidence;
4. no unresolved user decision changes the accepted outcome.

Task declarations, branch existence, Worktree references, arbitrary receipts, successful process exit or a worker claim are never sufficient by themselves.

Non-critical cleanup warnings, missing historical receipts, projection lag and export failure become MaintenanceFindings. They do not reopen a completed Requirement.

A completed Requirement may leave `done` only through an explicit user outcome revision, explicit cancellation/replacement, or evidence invalidation that directly defeats a required acceptance criterion. Every transition is audited.

## Authority and storage boundaries

| Data | Mutable authority | Recovery / projection rule |
| --- | --- | --- |
| Requirement, ExecutionPlan, PlanStep, relationships and lifecycle | Controller-home SQLite after namespace cutover | Restore from verified SQLite backup and audit; Git export is never replay authority |
| Work contract, completion and integration evidence | Controller-home SQLite | Existing legacy JSON imports exactly once when no authoritative row exists |
| Attempt, Process, Job, Run, lease and bounded receipts | Controller-home stores, migrated transactionally by family | Logs and large outputs remain external artifacts |
| Git repository, checkout, branch, HEAD and diff identity | Git plus repository registry observations | Never inferred from Requirement, Plan, Issue or Task text |
| Source, accepted ADRs and operator-authored documentation | Git | Human-reviewed documents; no runtime status writes |
| Optional Requirement export snapshots | Generated from SQLite to Git or another sink | One-way, revision-stamped, replaceable projection |
| Stable Supervisor bootstrap authority/config | Small atomic files outside control-plane SQLite | Must remain readable when management database is unavailable |
| Standalone Recovery minimum state | Recovery-owned atomic state outside primary control-plane SQLite | Must survive primary Controller failure |
| Logs, screenshots, binaries, large diffs and command output | Artifact filesystem/object store | SQLite stores bounded IDs, hashes, sizes and revisions only |
| Secrets and credentials | OS/external credential provider | Never stored in payloads, exports, receipts or audit rows |

SQLite records use schema versions, monotonic revisions, audit rows, WAL, foreign-key enforcement, busy timeout and transactional compare-and-swap under `BEGIN IMMEDIATE`.

## Write and projection invariants

1. Each migrated record family has exactly one writer authority.
2. SQLite is read first. Legacy JSON may import only when no authoritative row exists.
3. Once imported, later Git or JSON changes are ignored by runtime mutation paths.
4. No compatibility path writes both SQLite and Issue/Task files.
5. Projections contain source revision and content fingerprint and are safe to delete and rebuild.
6. A stale projection may fail visibly but cannot mutate authoritative state.
7. A transaction spanning related identities either commits all records or none.
8. Unknown required schema versions fail closed; downgrade readers never overwrite them.

## Legacy Issue/Task cutover

The current Issue/Task portfolio is an import source and historical alias set, not the target model. Migration is one-way:

1. Freeze the repository Issue/Task writers and capture an exact revision-stamped portfolio snapshot.
2. Classify each Issue as a user Requirement, a plan version/step, historical evidence alias, or MaintenanceFinding.
3. Import Requirements first, then plans/steps, then Work/evidence links in one resumable migration with idempotency keys.
4. Validate entity counts, aliases, dependencies, terminal evidence and user-visible state against the frozen snapshot.
5. Switch reads and the default board to SQLite.
6. Enable optional one-way export from SQLite with source revision metadata.
7. Delete runtime Issue/Task writers, `currentIssue` mutation, twenty-state user projections and fallback overwrite paths.

The portfolio size is determined from the frozen execution-time snapshot. Documentation must not assume the earlier estimate of 31 records; the 2026-08-02 accepted snapshot contains 33 repository Issue records.

Rollback before read cutover discards the incomplete imported namespace transaction. Rollback after cutover restores a verified SQLite backup and compatible artifacts. It never replays stale Git Issue/Task files over authoritative rows.

## Read models

The default Requirement Board shows only user title, outcome, five-state lifecycle, health marker, latest delivery, blocking reason and required user decision.

Execution Diagnostics is a separate on-demand view for plans, Work, Attempts, Process, Jobs, Runs, leases, checks, receipts, artifacts and MaintenanceFindings. Diagnostic detail cannot leak into or redefine the user lifecycle.

## Failure requirements

Implementation and cutover must prove:

- concurrent revision conflict and CAS behavior;
- interruption at every migration boundary;
- stale legacy and projection writes after cutover;
- SQLite corruption detection, backup restore and audit continuity;
- daemon and machine restart recovery;
- export failure without authority loss;
- exact repository/checkout identity preservation;
- no duplicate side effects when an Attempt disappears;
- bootstrap and standalone Recovery availability while control-plane SQLite is unavailable.

## Consequences

This removes Git cleanliness from the runtime correctness path, prevents technical replans from multiplying user requirements and makes completion evidence explicit. It also requires a deliberate one-time migration and deletion of familiar Issue/Task compatibility APIs. Until a namespace is cut over, its current authority remains in force; shadow dual-write is forbidden throughout the transition.
