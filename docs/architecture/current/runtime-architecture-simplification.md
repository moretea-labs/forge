# Canonical Single Runtime Architecture and Seven-Phase Replacement

> **Status: Runtime Authority — Approved Target Architecture**
>
> **Scope:** Repo Harness local Runtime process ownership, readiness, release/rollback, Worker fencing, and deletion of legacy lifecycle paths.
>
> **Current implementation status:** transition. `src/runtime/root/` provides the first Canonical Runtime vertical slice, but the repository still contains a parallel Supervisor/Daemon/Ingress/slot lifecycle. That legacy stack is not the target and must not be expanded.

## 1. Non-negotiable end state

Repo Harness converges to:

```text
one local MCP application
one active Runtime
one root lifecycle owner
one complete release
one whole-Runtime readiness result
one whole-Runtime publish and rollback unit
```

Gateway Adapter, Controller Services, Scheduler, SQLite, MCP Transport, and Worker Manager retain module boundaries for code organization. They are not independent deployments, generations, lifecycle owners, readiness authorities, or rollback units.

The only supported core process topology is:

```text
repo-harness-runtime
  ├─ MCP Transport                 in process
  ├─ Gateway Adapter               in process
  ├─ Controller Services           in process
  ├─ Scheduler                     in process
  ├─ SQLite                        in process / library boundary
  └─ Worker processes              bounded child execution units
```

External tunnels are optional transports. They may connect to the Runtime endpoint, but they cannot start, stop, restart, adopt, publish, roll back, or determine readiness for the Runtime.

## 2. Target Runtime

`CanonicalRepoHarnessRuntime` is the sole root lifecycle owner. It performs one ordered startup, one ordered shutdown, and one fatal-failure path for the complete application.

It alone may:

- acquire the Controller Home Runtime ownership claim;
- initialize SQLite and Controller Services;
- start the in-process Scheduler;
- create the Gateway Adapter and MCP Transport;
- start and fence Workers through the Scheduler/Worker Manager boundary;
- publish the single Runtime readiness result;
- stop the complete Runtime after a fatal core-module failure.

No core module may create a KeepAlive loop, detached restart coordinator, secondary generation, child lifecycle supervisor, component release pointer, or component rollback operation. The canonical `runtime` CLI is observation-only; it cannot start, stop, restart, or recover the application.

## 3. Seven phases

| Phase | Required result | Current source assessment |
| --- | --- | --- |
| 1. Establish Canonical Single Runtime | MCP Transport, Gateway Adapter, Controller Services, Scheduler, SQLite, and Worker Manager are started by one Runtime Root | Partial: the vertical slice exists, but it remains parallel to the legacy installed lifecycle |
| 2. Converge lifecycle ownership | Runtime Root is the only core start/stop/failure/recovery owner | In progress: `repo-harness-runtime` is the sole canonical start entry; `runtime` is observation-only; public `controller`/Supervisor/MCP lifecycle commands, autonomous Recovery agent repair, MCP/Gateway Daemon auto-start, Gateway component restart/rollout/rollback tools, Supervisor facade operations, and repair-triggered detached restart are removed; the independent legacy Daemon entry, Supervisor process, and bounded recovery callers still require deletion |
| 3. Simplify readiness | Public Runtime readiness is only `ready: true/false`; module observations are diagnostic evidence | In progress: Canonical Runtime and public `controller_ready` use the binary contract; detailed component observations remain internal evidence for legacy status/recovery paths and require further deletion |
| 4. Remove ingress and Runtime slots | No Stable Ingress, fixed blue/green ports, runtime slots, mixed generation, adoption, or component cutover | Not complete |
| 5. Whole-Runtime publish and rollback | Code, configuration, entrypoint, manifest, SQLite schema/backup, and Worker protocol move as one compatible set | Canonical store implemented in `src/runtime/root/release-store.ts`; remaining work is deletion of the legacy Supervisor/slot publisher |
| 6. Complete Worker isolation and fencing | Workers are bounded Runtime-owned children; stale Workers cannot commit control-plane side effects | Existing fencing primitives are reusable; ownership must be bound to the Canonical Runtime instance/release |
| 7. Delete legacy architecture | Supervisor, Ingress, KeepAlive, slots, component rollout/rollback, and old authority are removed | Not complete |

A change that cannot be assigned to one phase, or that does not reduce core processes, lifecycle owners, readiness authorities, release units, or compatibility paths, is presumed scope drift and must stop for review.

## 4. Readiness contract

The public contract is intentionally small:

```ts
interface RuntimeReadiness {
  ready: boolean;
  reasonCodes: string[];
  diagnostics: {
    database: DiagnosticEvidence;
    scheduler: DiagnosticEvidence;
    releaseCoherence: DiagnosticEvidence;
    mcpEndToEnd: DiagnosticEvidence;
  };
  observedAt: string;
}
```

Only `ready` is the Runtime decision. `reasonCodes`, `diagnostics`, and `observedAt` explain the decision. Public readiness does not expose `state`, component top-level readiness objects, slots, generations, Supervisor state, or Ingress state. Detailed legacy observations may remain internal temporarily, but must not become a second lifecycle state machine.

Forbidden public Runtime readiness combinations include:

- `degraded`, `partial`, `recovering`, or component-specific top-level states;
- independently authoritative Gateway, Controller, Scheduler, or database readiness;
- port/PID health promoted to Runtime readiness;
- readiness that remains true after any fatal core module exits.

The Runtime becomes ready only after release compatibility, SQLite, Scheduler, MCP initialize, tools/list, authenticated Controller access, and a SQLite-backed read all succeed in the same Runtime instance.

## 5. Whole-Runtime release and rollback

A Runtime release is one immutable compatibility set:

```text
entrypoint
core code and assets
Runtime configuration schema
release manifest
SQLite schema compatibility
pre-upgrade database backup contract
Worker protocol version
migration and rollback metadata
```

Release validation is offline and does not require a second serving Runtime, traffic router, fixed alternate port, or persistent slot identity. `src/runtime/root/release-store.ts` records one atomic active/previous authority and binds each previous release to its verified SQLite backup.

Activation is a whole-Runtime restart:

1. validate the complete immutable release and configuration;
2. verify database compatibility and create the required backup before mutation;
3. stop admission and quiesce the current Runtime;
4. stop the complete current Runtime;
5. start the complete new Runtime from one release entrypoint;
6. require whole-Runtime readiness;
7. on failure, stop the failed Runtime and restore the complete previous release/config/database compatibility set;
8. start the previous Runtime and require whole-Runtime readiness.

No operation may independently publish, restart, or roll back Gateway, Controller, Scheduler, MCP Transport, SQLite schema, or Worker protocol.

## 6. Worker boundary and fencing

Workers remain separate processes because they execute bounded external work. They are not Runtime owners.

Every Worker attempt must carry:

- Runtime instance identity;
- Runtime release identity;
- Worker protocol version;
- Job/Work identity and attempt;
- exact Lease and fencing token set;
- bounded deadline and cancellation channel.

A Worker created by an old Runtime cannot renew Leases, publish heartbeats, commit results, write evidence as current, release replacement ownership, or perform control-plane side effects after Runtime ownership changes.

Workers cannot schedule other Workers, select releases, recover the Runtime, mutate Runtime authority, or maintain a forever loop.

## 7. Legacy inventory and deletion order

The following paths are legacy implementation inventory, not target building blocks:

| Legacy area | Required disposition |
| --- | --- |
| `src/runtime/supervisor/**` | delete after Canonical Runtime launch/release/rollback replacement is verified |
| `src/runtime/supervisor/ingress-router.ts` and ingress session/process state | delete in phase 4 |
| MCP KeepAlive/restart commands and implementations | public/hidden entrypoints, the 911-line restart implementation, and the 1,136-line KeepAlive process/tunnel/restart owner are deleted in phase 2; reusable HTTP/stdio transports remain module code only |
| MCP transport and Gateway tool Daemon auto-start | removed in phase 2; readiness and tool responses may observe daemon status but cannot create or recover Controller Services |
| independent Controller Daemon entry and `ensureControllerDaemon()` service API | deleted; the remaining daemon status name is a read-only compatibility projection over Canonical Runtime observation |
| `src/cli/controller/runtime-slots.ts` and slot homes | delete in phase 4 |
| `src/cli/controller/bluegreen-rollout.ts` | delete in phases 4/7 |
| public `controller` lifecycle/blue-green commands and public `supervisor` command | removed from the supported CLI surface in phase 2; implementation modules remain deletion inventory |
| detached restart coordinator and component restart bridges | no longer reachable through the canonical/public lifecycle CLI; delete remaining internal callers |
| standalone Recovery PI/agent repair and repository-write authority | removed in phase 2; Recovery code must never launch an agent in, generate scripts in, move files from, or otherwise mutate a source checkout |
| stable ingress ports and private blue/green ports | delete; one Runtime endpoint is configured directly |
| component generation and mixed-generation coherence | delete; one Runtime instance/release identity remains |
| Gateway/MCP component restart, rollout, rollback, green-gate and Supervisor facade operations | removed from direct tools and `rh_status`/`rh_work` in phase 2; no compatibility facade may trigger lifecycle changes |
| component rollout/rollback operation stores | no longer reachable through MCP facades; delete internal stores with the remaining Supervisor implementation |
| compatibility authority projections | migrate once, then delete; no permanent dual-read or dual-write |

Legacy code may receive only deletion-enabling or safety-fencing changes. New features, new states, new rollback protocols, or new recovery automation must not be added to it. Recovery diagnostics may read source identity, but must never write a source checkout. Recovery state, evidence, and configuration remain below Controller Home; temporary OS service metadata is legacy deletion inventory, not a new authority. Autonomous code repair is not an allowed Runtime recovery mechanism.

## 8. Scope-drift assessment of prior work

The earlier fixed release-manifest work, Controller Home ownership, explicit Runtime configuration, SQLite inspection, in-process Scheduler, authenticated MCP end-to-end probe, and Worker fencing primitives remain useful.

The following earlier direction is no longer an approved target:

- treating Supervisor as the permanent root application;
- retaining independently managed Daemon and Gateway processes;
- moving Stable Ingress into the Supervisor process instead of deleting it;
- replacing blue/green slots with candidate/current/previous traffic switching;
- preserving component readiness, component restart budgets, and component rollback;
- adding an independent primary Recovery service family for the local application.

Those changes may be retained temporarily only as legacy transition code while the Canonical Runtime replaces them. They do not count as completion of the seven phases above.

## 9. Required review questions

Every Runtime refactor review answers:

1. Which of the seven phases owns this work?
2. Does it directly reduce the gap for that phase?
3. Does it add a process, state, owner, authority, or long-term compatibility path?
4. Does it reintroduce component deployment, recovery, or rollback?
5. Does completion move the system toward one Runtime, one Owner, and one release?
6. Which legacy layers still remain?
7. What is the next deletion or convergence step?

## 10. Immediate execution order

1. Make `repo-harness-runtime` the only supported core startup entry.
2. Move Controller startup recovery and Worker Manager ownership into Runtime Root.
3. Remove public component readiness and use only whole-Runtime readiness.
4. Remove Stable Ingress and bind MCP Transport directly to the configured Runtime endpoint.
5. Remove runtime slots, fixed alternate ports, mixed generations, and component cutover.
6. Implement whole-Runtime release/backup/rollback.
7. Bind Worker commits to Runtime instance and release fencing.
8. Delete Supervisor, KeepAlive, Daemon service entry, component rollout/rollback, and compatibility authority.

No rollout, service restart, or live cutover is implied by source implementation work. Live activation requires separate explicit authorization and exact release evidence.
