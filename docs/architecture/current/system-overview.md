# Controller Runtime System Overview

> Status: **Runtime Authority**
>
> Routing convergence: execution depth, semantic ownership, and resource placement are independent decisions. `RouteDecision` owns Direct/Process/Durable selection; unrelated active Work never upgrades a Direct request. CodeGraph/lexical/Forge relations are combined inside the Context Plane as bounded impact evidence, not as another execution authority.

## 1. System Definition

Forge Controller Runtime is an Agent Engineering Control Plane for one or more local Git repositories. ChatGPT, Local UI, CLI and optional GitHub integrations submit decisions and commands. The runtime persists accepted work, schedules it under repository-owned conflict rules, executes it outside the Gateway process and records evidence for recovery, acceptance and release.

## 2. Canonical Runtime Topology

```text
Client
  -> forge-runtime (one local MCP application)
       MCP Transport
       Gateway Adapter
       Controller Services
       SQLite control plane
       Global Scheduler + Per-Repository Actors
       Evidence Plane + Materialized Projections
       |
       +-> forge-worker (bounded Runtime-owned child)
             command / check / Agent dispatch / integration / release gate
             |
             v
           repository workspace, Worktree, GitHub provider
```

The durable execution model uses atomic state, bounded Worker processes, Leases, and fencing. Gateway Adapter, Controller Services, Scheduler, SQLite, and MCP Transport run inside one Canonical Runtime process, while Workers remain bounded child execution units.

Supervisor, independent Daemon/Gateway services, Stable Ingress, runtime slots, bootstrap compatibility authority, restart coordinator, and component rollout/rollback are deleted from the source architecture. One Runtime owner record and one whole-release authority fence all current writes.

The approved target is [`runtime-architecture-simplification.md`](runtime-architecture-simplification.md): one local MCP application, one active Runtime, one root lifecycle owner, one binary readiness result, and one whole-Runtime release/rollback unit.

## 3. Gateway Adapter

Implemented as a module under:

- `src/cli/mcp/server.ts`
- `src/cli/mcp/transports/http.ts`
- `src/runtime/gateway/mcp/router.ts`
- `src/runtime/gateway/mcp/runtime-tools.ts`

The Gateway Adapter performs authentication, schema validation, explicit repository selection, bounded context/results, and routing inside the Canonical Runtime. Eligible reads and bounded actions may complete Direct; repository commands and checks enter Unified Process Runtime; durable Work is admitted only when lifecycle, recovery, dependency, or isolation requirements justify it. The Gateway does not make the HTTP request the owner of a long-running process.

Bounded direct reads include health, Controller context, repository state, Process/Work status, and bounded results. Overload is rejected with explicit 429/503 responses instead of unbounded accumulation.

The three MCP HTTP paths share one global session registry. SSE streams are bounded transport leases, not work ownership. Client DELETE, explicit prior-session replacement, lease expiry, absolute lifetime and oldest-safe capacity eviction may close a session with no active POST; capacity management never evicts active POST work. `/health` reports the global pool, while `/ready` reports whether a new initialize can be admitted safely.

## 4. Controller Services and Scheduler

Implemented under `src/runtime/control-plane/` and initialized by the Runtime Root.

The in-process Controller Services and Scheduler own:

- fair cross-repository dispatch;
- global Worker and Agent quotas;
- provider-specific quotas;
- Heavy Check limits;
- host free-memory and CPU-load admission;
- Schedule ticks;
- Portfolio DAG progress;
- orphan/deadline reconciliation.

Fairness state is persisted, so restart does not permanently reset repository aging.

## 5. Per-Repository Actor

Each repository is represented by one logical `RepoActor`. Actor decisions are serialized by a repository-specific mailbox lock whose critical section contains only state reads, Claim decisions and state transitions.

The Actor owns:

- dependency readiness;
- repository-local priority and aging;
- Workspace/Worktree placement;
- Claim acquisition;
- Lease and fencing assignment;
- waiting-state classification;
- release barriers.

Long work runs after the Actor releases its short transaction lock.

## 6. Execution Plane

Forge uses three execution depths rather than forcing every operation through one durable protocol:

1. **Direct** — bounded readonly observations, Direct Edit, and explicitly authorized ephemeral workspace actions can complete without manufacturing Work, Process, Lease, or Worker state when none is required.
2. **Unified Process Runtime** — repository commands and checks spawn one physical process, persist a stable Process identity and lifecycle, and support status/wait/log/cancel attachment without re-execution. Resource Claims and Leases protect conflicting effects.
3. **Durable Work / Scheduler** — long-lived, dependency-aware, recoverable, isolated, or parallel objectives use Work contracts, repository actors, workers, and optional worktrees.

Repository command input has one canonical boundary: typed argv arrays preserve executable and argument boundaries end to end and execute without a shell; legacy command strings remain supported only through an explicit compatibility shell boundary. Policy classification, path scope, authorization, Process execution, and result receipts consume the same representation.

Process records and durable Work are both idempotently addressable by their caller-visible identities. Fenced writes reject stale ownership. Result bodies are bounded; oversized results become addressable Artifacts. Legacy ExecutionJob records remain readable as compatibility state but are not the ordinary command/check hot path.

## 7. Resource Plane

Stable resource keys include:

```text
repo-state
repo-content:*
workspace:<checkoutId>
worktree:<identity>
path:<glob>
git-refs:<repoId>
heavy-check:<repoId>
integration:<repoId>
remote:<repoId>
release:<repoId>
```

Unknown write scope becomes `repo-content:*`. Workspace writes are single-writer. A second automatically placed Agent may move to a unique Worktree Claim. Worktree implementation can run concurrently, but Integration and Git-ref mutation are exclusive.

## 8. Schedule and Portfolio Planes

A Schedule produces one idempotent Occurrence per normalized time window. Occurrences are bounded and indexed. Shadow Mode records the decision without mutation. Budgets, cooldowns, maximum active occurrences and failure circuit breaking are persisted.

A Portfolio Workflow is a cross-repository DAG. Dependencies are explicit. Failure policy is deterministic stop or Saga compensation. External side effects are blocked from unattended workflows.

## 9. Evidence and Projection Planes

Evidence contains exact revision, environment fingerprint, outcome, Job identity and artifacts. Event ledgers are append-only. Large output is not embedded in hot status responses.

Materialized projections summarize active Jobs, queue depth, workers, Leases, release freeze and human-attention states. HTTP readiness and Local UI read these projections rather than scanning history.

## 10. Release Plane

A Release Gate is a durable Job with an exclusive repository-wide release Claim. It checks:

- current Git revision and clean Workspace;
- active Jobs, Runs and Local compatibility Jobs;
- pending Worktree integration;
- non-final Edit Sessions;
- other Leases;
- active-Issue Task completion;
- exact-revision verification evidence;
- repository/Git/GitHub identity consistency;
- whole-Runtime readiness evidence;
- package metadata.

The successful result is a release-ready manifest. Push, merge, publish and deployment remain separate, explicitly authorized operations.

## 11. Compatibility Layer

`src/cli/mcp/tools.ts` remains as a stable export facade; the preserved implementation is isolated in `src/cli/mcp/legacy-tool-service.ts`. Local Jobs and Agent Run records remain readable and operational for compatibility. In Controller mode, long compatibility implementations are invoked only by isolated Workers. The compatibility layer is not the scheduling owner.
