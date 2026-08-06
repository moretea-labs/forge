# Runtime Health and Resource Lifecycle

Status: Current implementation note (2026-07-16)

This note records the additive runtime-health and cleanup semantics. It does not
create a new Controller boundary, health database, projection worker, or cleanup
scheduler.

## Observation versus evaluation

Runtime callers collect diagnostic observations from the Canonical Runtime,
Scheduler, Workers, materialized projections, Local Controller endpoint, and
runtime storage. `src/runtime/health/evaluator.ts` remains a side-effect-free
operational evaluator for blockers and warnings; it is not a lifecycle or
readiness authority. The Runtime Root publishes the only public Runtime
readiness decision as `ready: boolean`, with module observations retained only
as diagnostic evidence.

Projection age is not a health signal by itself. A readable idle projection is
usable even when old. A dirty/source-changed projection is warning-level during
the bounded refresh grace period and becomes a blocker only when the required
refresh is missed or the build fails.

Task Ledger status describes workflow progress and is not live process
ownership. A Task may remain `running` across sequential Runs while no Worker is
currently active. Differences between Task Ledger running counts and runtime
Worker counts are repository-scoped attention evidence; they never block the
global Gateway, Controller readiness, or release rollout. Execution readiness
continues to fail closed on durable Job, queue, Lease, current-attention, and
projection-build evidence.

## Projection content and producer health

`RepositoryRuntimeProjection.metadata` distinguishes content revision, source
revision, content fingerprint, build attempt/success times, build errors, and
producer generation. Dirty-marker invalidation remains the source-change signal;
hot reads may rebuild in memory but do not clear the marker or rewrite a
projection heartbeat.

## Local Controller capability

The expected health endpoint and its Local Controller surface are authoritative.
Embedded, standalone, remote, disabled, and unknown modes are represented in
runtime state and `/health`. A healthy expected endpoint can therefore report a
ready capability while persisted `running=false` or stale PID evidence is kept
as a warning. Wrong surfaces, missing endpoints, generation mismatches, and
inactive-slot evidence remain blockers when the capability is required.

## Current attention and history

`buildRuntimeOperationalView` provides one read model with three explicit
sections: current health blockers, pending attention, and recent history.
Pending handoffs include acknowledged/in-progress items until they are explicitly
resolved or dismissed. Terminal Jobs, resolved handoffs, and prior incidents
remain in history and never degrade readiness merely because they exist. The
underlying Job, event, and handoff records are not deleted by this view.

## Ownership-aware cleanup

Ownership is embedded in supported lifecycle records through `ManagedResource`.
Agent Run worktrees and Execution Jobs carry an owner, type, timestamps, state,
and optional retention/path data. Transitional runtime-slot records are not
cleanup authority. Missing legacy metadata remains unknown and is protected.
Existing cleanup authorities retain
their startup/periodic/manual entrypoints, now emit a bounded audited
`CleanupCycleSummary`, isolate failures, and default automatic removal to 50
items per cycle. Type-specific collectors continue to guard process identity,
TTL, worktree references, and known runtime roots.

The implementation intentionally does not broaden automatic deletion for legacy
artifacts, edit sessions, branches, or unproven temporary resources. Those
resources remain retained until their existing Git/reference/lease authority can
prove eligibility.

## Canonical lifecycle boundary

Runtime slot, candidate/standby, and Supervisor records are no longer source
contracts. Cleanup proves eligibility from current Runtime ownership, exact
release authority, process identity, Job attempt, Lease tokens, and explicit
whole-release rollback references; it never infers authority from historical
slot or component metadata.

Focused regression coverage protects idle projections, missed refreshes, endpoint
capability precedence, attention/history separation, bounded cleanup, and
identity-safe compatibility behavior.
