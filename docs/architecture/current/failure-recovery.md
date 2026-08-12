# Failure Recovery

> Status: **Runtime Authority**

## 1. Objective

Failure recovery preserves durable truth when client connections, Gateway sessions, Controller processes, Workers, Agents, external providers, repositories, or indexes fail independently.

The recovery objective is not to turn every uncertain state into success. It is to determine what can be proven, preserve evidence, prevent duplicate unsafe execution, and expose an explicit next action.

## 2. Failure Domains

The target runtime has distinct failure domains:

```text
Client / MCP session
Gateway
Canonical Forge Runtime
Repo Actor
Worker
Agent or command process tree
External provider
Repository checkout
Controller Home storage
Projection / index
Network tunnel or reverse proxy
```

A failure in one domain must not automatically terminate or corrupt another domain.

## 3. Client and Transport Failure

An installed Controller Home has one Canonical Runtime Root as the core lifecycle owner. Accepted repository work is persisted before execution and is independent of the MCP request lifetime. Runtime status is a read-only owner-bound projection, while standalone Recovery reads that projection and the atomic whole-release authority; there is no Supervisor socket or component operation queue.

Examples:

- MCP client disconnects;
- reverse proxy returns 502;
- tunnel changes endpoint;
- Streamable HTTP session is lost;
- request exceeds proxy timeout;
- response body is truncated.

### Target Behavior

If a command was durably accepted before disconnection:

- the Job continues according to its contract;
- repeated request with the same idempotency key returns the existing Job;
- the client can recover through `get_job`, `get_run`, or related detail tools;
- the original connection is not execution ownership.

If durable acceptance cannot be proven, the caller may retry using the same request ID.

Transport sessions use one global registry across all HTTP MCP paths. A client SHOULD send DELETE when ending a session. The runtime MUST reclaim stream-only sessions through explicit prior-session replacement, bounded SSE lease, absolute lifetime, or oldest-safe capacity eviction. An active POST is protected from session-capacity eviction; an SSE GET by itself is not protected execution ownership.

### Health Requirement

Gateway health endpoints and compact status queries must not wait for active long operations.

`/health` proves liveness and reports actual global session counts. `/ready` additionally proves that a new initialize can be accepted safely. A full pool remains ready when it contains a safe eviction candidate; it becomes not-ready when every slot is protected by active POST work. A core failure makes whole-Runtime readiness false; any restart replaces the complete Runtime release rather than recovering an individual component.

A 502 may describe Gateway or proxy availability. It must not be used as evidence that a Job failed or never started.

## 4. Gateway Failure

The Gateway is stateless except for transport/session caches and bounded projections.

After a whole-Runtime restart it must:

1. acquire the single Controller Home Runtime ownership claim;
2. validate the selected whole-release manifest and local schema compatibility;
3. initialize SQLite, Controller Services and repository identities;
4. recover scheduling, Leases, projections and bounded Worker ownership;
5. start the in-process Scheduler and MCP Transport;
6. reject stale MCP sessions cleanly;
7. avoid resubmitting accepted work without idempotency lookup;
8. publish `ready: true` only after the authenticated MCP end-to-end probe succeeds.

A fatal MCP Transport, Controller Services, SQLite, or Scheduler failure makes the complete Runtime not ready and stops the one core process. No module restarts itself as an independently authoritative service.

## 5. Runtime core recovery

The Runtime Root owns scheduling initialization, reconciliation, Schedule delivery, Lease management and core failure propagation.

After restart it runs bounded recovery before publishing ready:

```text
load enabled repository registry
rebuild ExecutionJob active and requestId indexes from durable records
reconcile running/active ExecutionJobs and dead workers
reconcile Local Bridge compatibility Jobs
remove or classify expired Leases
rebuild every repository materialized projection from durable truth
publish the one binary Runtime readiness result with structured diagnostic reason codes
resume fair scheduling and normal asynchronous observation
```

Projection rebuild is unconditional on daemon restart, so a stale persisted projection is repaired even when a dirty marker was lost. Recovery failures are isolated by repository and phase: one broken repository does not prevent healthy repositories from recovering, and a failure in one phase does not silently skip later Lease or projection repair. The Controller must not assume every persisted `running` entity is still running. It verifies Lease, heartbeat, process/provider state, and durable result evidence.

### Runtime source coherence and lifecycle handoff

Runtime source coherence is part of the one binary readiness decision. A missing or stale startup Runtime source snapshot is a blocking condition, not a warning and not a metadata-maintenance candidate.

The running Runtime never owns its own replacement. Recovery diagnostics may classify the condition and return a structured external lifecycle handoff, but they must not expose a Runtime/component restart action, detached restart coordinator, rollout slot, or autonomous source-repair fallback.

The external lifecycle owner may replace only the existing single `forge-runtime` service. It must not start a second Runtime, create a component Runtime, mutate the source checkout as part of recovery, or introduce a rollout path. Readiness becomes true again only after the replacement Runtime has published a startup source snapshot and source-coherence evaluation proves that the configured Runtime source and active Runtime source agree.

Local runtime maintenance remains limited to bounded Controller Home / repository runtime metadata repair. When that executor has no safe candidate, its continuation is an explicit handoff; it does not escalate to an invented lifecycle or source-repair action.

## 6. Repo Actor Recovery

A Repo Actor is a logical single owner. Its mailbox and sequence position must be recoverable.

Actor recovery reads:

- repository enabled state;
- active Jobs and Claims;
- Leases and fencing tokens;
- Task effective states;
- Workspace and Worktree ownership;
- Integration Queue;
- release freeze;
- pending Schedule Occurrences.

Commands are applied idempotently by command ID or request ID. Replaying an already-applied command returns the recorded result.

## 7. Worker Failure

A Worker may exit because of:

- process crash;
- host restart;
- timeout termination;
- explicit cancellation;
- resource exhaustion;
- launch error;
- lost Controller connection.

Worker liveness is not inferred only from a parent PID. Recovery considers:

```text
Lease validity
fencing token
worker PID
child and process-group state
heartbeat
result artifact
stdout/stderr/event completion
external provider state
```

A dead Worker with a complete valid result may be reconciled to terminal success. A live descendant without a valid Lease must not retain state-write authority.

## 8. Process Tree Ownership

Local execution must record enough data to identify the complete process tree or process group.

Timeout or cancellation procedure:

```text
record termination intent
signal process group gracefully
wait bounded grace period
signal remaining group forcefully when allowed
record observed exit state
persist unresolved descendants if any
release Lease only after ownership transition is durable
```

A parent process exit is not sufficient evidence that compilers, tests, or Agent descendants have exited.

## 9. External Provider Failure

For GitHub or another provider:

- local Run stores provider session identity and links;
- provider status is refreshed independently from MCP connection;
- unavailable provider state yields a retriable external blocker or `unknown`, not fabricated success;
- duplicate provider sessions are prevented by request identity;
- external branch/PR existence is evidence, not automatic acceptance.

## 10. Storage Failure

Controller Home and repository runtime bindings are durable state dependencies.

On write failure:

- do not start a new Worker;
- do not advance lifecycle in memory only;
- return a storage-blocked result;
- preserve temporary files for diagnostics where safe;
- avoid deleting the prior valid snapshot.

Atomic-write protocol:

```text
write temporary file
flush when required by risk class
rename atomically
update index after entity snapshot
append audit event or record repair anomaly
```

If entity write succeeds and index update fails, reconciliation rebuilds the index from bounded durable entities.

## 11. Projection and Index Recovery

Indexes are rebuildable projections.

Target indexes include:

```text
active Jobs
requestId -> entity
Task -> Run IDs
active Claims and Leases
pending Integration Queue
active Schedule Occurrences
Candidate Finding semantic keys
recent attention items
```

Rules:

- hot reads use indexes;
- index owner/version is persisted;
- process restart may validate or rebuild active indexes;
- a missing terminal-history index does not require scanning history on every request;
- rebuild runs as a bounded reconciliation Job when history is large;
- malformed entities are isolated and reported rather than silently discarded.

## 12. Lease Recovery and Fencing

A Lease may be:

```text
active
expired
released
revoked
orphaned
```

Recovery procedure:

1. read persisted Lease and resource fencing counter;
2. determine whether current owner Job is non-terminal;
3. inspect heartbeat and execution evidence;
4. if ownership is uncertain, prevent new writes until expiry or explicit revocation;
5. grant new ownership with a higher fencing token;
6. reject late writes carrying the older token.

Process PID reuse must not grant ownership. The Lease ID and fencing token are authoritative.

## 13. Orphan Classification

Use `orphaned` when:

- an active owner disappeared;
- no valid terminal result proves success or failure;
- repeating the operation may have side effects;
- manual or policy-guided reconciliation is required.

Orphan metadata includes:

```text
lastHeartbeatAt
leaseExpiredAt
lastKnownPid/provider state
lastEvent
artifact completeness
safeToRetry
reconciliationReason
```

## 14. Unknown Run Classification

A Run uses `unknown` when execution outcome cannot be proven, including startup ambiguity or provider uncertainty.

Unknown does not mean failed, succeeded, or safe to retry. Task readiness must require explicit retry authorization after the Controller evaluates duplicate-execution risk.

## 15. Stale Classification

Use `stale` when the operation may have executed correctly but cannot satisfy the original contract because a required precondition changed.

Examples:

- repository Revision changed;
- Edit Session advanced to another Revision;
- approval token snapshot changed;
- integration target moved;
- Schedule window was superseded;
- repository identity or provider mapping changed.

Stale evidence remains historical but cannot complete the current Task.

## 16. Timed-Out Classification

A timeout requires:

- a persisted deadline;
- observed deadline expiry;
- termination or provider cancellation attempt;
- durable timeout event;
- resource-release/reconciliation outcome.

An in-memory timer firing without durable deadline identity is insufficient recovery evidence.

## 17. Retry Safety

Before retry, determine operation class:

### Naturally idempotent

Examples: bounded read, exact-revision check with cache key.

May retry automatically within budget.

### Idempotent through request identity

Examples: Job admission, Run creation, Schedule Occurrence creation.

Retry returns the original entity.

### Requires reconciliation

Examples: command may have modified files, Agent may still be alive, external provider session may exist.

Do not retry until current outcome and resource ownership are reconciled.

### Explicitly non-repeatable

Examples: publication, deployment, destructive mutation.

Require human decision and operation-specific compensation or resume protocol.

## 18. Reconciliation Jobs

Reconciliation is itself durable and bounded.

Types include:

- active Job reconciliation;
- active Run reconciliation;
- Lease reconciliation;
- Worktree inventory reconciliation;
- Integration Queue reconciliation;
- repository registry identity reconciliation;
- Schedule Occurrence reconciliation;
- projection rebuild.

Reconciliation Jobs must be idempotent and normally read-only except for lifecycle repair and index updates.

## 19. Startup Sequence

Controller startup order:

```text
1. validate Controller Home
2. load repository registry
3. validate runtime storage bindings
4. load/rebuild global active indexes
5. instantiate Repo Actors
6. reconcile Claims and Leases
7. reconcile active Jobs/Runs/Occurrences
8. start Worker dispatch
9. deliver due Schedules
10. report readiness
```

Gateway may report liveness before Controller readiness, but execution admission must wait for durable state readiness.

## 20. Health Model

### Liveness

The process event loop responds.

### Readiness

The component can safely perform its role.

Suggested health surfaces:

```text
Gateway /health
Gateway /ready
Controller status
Worker pool status
Repository-specific health
```

Repository-specific degradation does not make Gateway liveness fail.

## 21. Recovery Notifications

Notify only on material state change:

- Job recovered to terminal outcome;
- Job became orphaned/unknown;
- retry is unsafe without user decision;
- repository storage is blocked;
- integration conflict requires action;
- repeated Controller/Gateway instability crosses policy threshold.

Do not repeatedly notify for an unchanged orphan or external blocker.

## 22. Recovery Testing

Required test scenarios include:

- client disconnect after Job acceptance;
- Gateway restart during Worker execution;
- Controller restart with running Jobs;
- Worker crash before and after result persistence;
- process descendants surviving parent exit;
- expired Lease and late stale Worker write;
- corrupt/missing active index rebuild;
- repeated request ID after timeout;
- external provider temporarily unavailable;
- repository A recovery while repository B continues.

## 23. Current Implementation

MCP Transport, Gateway Adapter, Controller Services, Scheduler and SQLite run in one Canonical Runtime process. Workers remain bounded child process roles. Accepted Jobs are persisted before Worker spawn. Job heartbeat, deadline, attempt, PID, Lease and fencing state are durable, and active/request indexes reconstruct scheduling after a whole-Runtime restart.

Before an operation runs, the Worker writes an Operation Receipt. A completed receipt lets Reconciliation close a Job after a crash between side-effect completion and terminal-state persistence. A started-but-incomplete mutating receipt is treated as an uncertain side effect and becomes `human_attention_required`; it is not replayed. Safe read-only work may be requeued within attempt budget.

Worker ownership is the tuple of Job ID, attempt, Worker PID and original Lease/fencing set. A stale Worker cannot heartbeat, renew or release replacement Leases, or publish a terminal result for a newer attempt.

The Gateway does not infer execution failure from a disconnected request. Callers recover with the request ID or Job ID. Cancellation terminates the owned Worker, records a terminal state and releases only that attempt's Claims.

## 24. Recovery Invariants

- MCP transport sessions never own Worker lifetime;
- the restarted Canonical Runtime schedules from durable active indexes;
- a stale Worker cannot write through an expired or replaced fencing token;
- external effects are reconciled rather than blindly retried;
- repository A recovery does not require locking repository B;
- bounded projections remain readable while Workers execute.

## 26. Runtime Storage Recovery

Every Controller Home runtime directory carries a repository/binding owner marker. Empty or terminal legacy storage is migrated and replaced with a repository-local link. Non-conflicting entries are merged. Name collisions are moved to a repository-scoped quarantine with a diagnostic path rather than overwritten or deleted.

Active or unreadable Run and Local Job directories remain fail-closed. Worktree storage is recoverable because stale and partial entries can be preserved or quarantined without claiming execution readiness based on deletion.
