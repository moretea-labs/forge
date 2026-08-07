# Canonical Single Runtime Architecture and Seven-Phase Replacement

> **Status: Runtime Authority — Approved Target Architecture**
>
> **Scope:** Repo Harness local Runtime process ownership, readiness, release/rollback, Worker fencing, and deletion of legacy lifecycle paths.
>
> **Current implementation status:** source convergence complete. The Canonical Runtime is the only core lifecycle architecture; Supervisor, independent Daemon/Ingress, runtime slots, bootstrap compatibility authority, restart coordinator, and component lifecycle scripts are deleted. Live activation of a release remains a separate explicitly authorized operational action.

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
forge-runtime
  ├─ MCP Transport                 in process
  ├─ Gateway Adapter               in process
  ├─ Controller Services           in process
  ├─ Scheduler                     in process
  ├─ SQLite                        in process / library boundary
  └─ Worker processes              bounded child execution units
```

External tunnels are optional transports. They may connect to the Runtime endpoint, but they cannot start, stop, restart, adopt, publish, roll back, or determine readiness for the Runtime.

## 2. Target Runtime

`CanonicalForgeRuntime` is the sole root lifecycle owner. It performs one ordered startup, one ordered shutdown, and one fatal-failure path for the complete application.

After acquiring the single Runtime ownership claim and confirming the selected whole-release authority, startup collects the exact configured Runtime source identity and atomically rotates `system/runtime-generation.json`. This happens before the write claim, Controller Services, SQLite admission, Scheduler, Workers, or MCP Transport. Source collection or snapshot persistence failure is a release-coherence startup failure; startup must stop and release ownership rather than serve with an unknown source baseline.

It alone may:

- acquire the Controller Home Runtime ownership claim;
- initialize SQLite and Controller Services;
- start the in-process Scheduler;
- create the Gateway Adapter and MCP Transport;
- start and fence Workers through the Scheduler/Worker Manager boundary;
- publish the single Runtime readiness result;
- stop the complete Runtime after a fatal core-module failure.

No core module may create a KeepAlive loop, detached restart coordinator, secondary generation, child lifecycle supervisor, component release pointer, or component rollback operation. The canonical `runtime` inspection surface does not own module lifecycle. The OS service manager owns one `forge-runtime` root service, while standalone Recovery may restart that complete service or perform an offline previous whole-release recovery under one cross-process lock.

## 3. Seven phases

| Phase | Required result | Current source assessment |
| --- | --- | --- |
| 1. Establish Canonical Single Runtime | MCP Transport, Gateway Adapter, Controller Services, Scheduler, SQLite, and Worker Manager are started by one Runtime Root | Implemented in the source architecture: `forge-runtime` starts the complete core application in one process |
| 2. Converge lifecycle ownership | Runtime Root is the only in-process core owner; one OS service and one standalone Recovery owner operate only on the complete Runtime | Implemented: public component lifecycle commands, Supervisor, independent Daemon, KeepAlive wrappers, component restart owners, and detached recovery paths are deleted; the Forge service starts one Runtime Root, and standalone Recovery can restart that complete service or perform previous whole-release recovery |
| 3. Simplify readiness | Public Runtime readiness is only `ready: true/false`; module observations are diagnostic evidence | Implemented: Canonical Runtime, status projection, Recovery verification, and public `controller_ready` use one binary Runtime decision |
| 4. Remove ingress and Runtime slots | No Stable Ingress, fixed blue/green ports, runtime slots, mixed generation, adoption, or component cutover | Implemented: Stable Ingress, blue/green slots, slot homes, activation transactions, writer authority, and slot fallback readers are deleted |
| 5. Whole-Runtime publish and rollback | Code, configuration, entrypoint, manifest, SQLite schema/backup, and Worker protocol move as one compatible set | Implemented: one active/previous whole-release authority, local SQLite backup/restore, service startup binding, bounded whole-Runtime restart, and automatic previous-release recovery after restart exhaustion; old bootstrap/slot authority is deleted |
| 6. Complete Worker isolation and fencing | Workers are bounded Runtime-owned children; stale Workers cannot commit control-plane side effects | Implemented: Workers inherit Runtime instance, owner PID, release authority revision/token, release ID, artifact identity, and Worker protocol; write paths import the Canonical Runtime fence directly; durable OperationReceipt recovery matches non-secret Runtime/release identity plus Job/attempt/PID/Lease evidence |
| 7. Delete legacy architecture | Supervisor, Ingress, KeepAlive, slots, component rollout/rollback, and old authority are removed | Implemented in source: Supervisor, Stable Ingress, independent Daemon, KeepAlive, component rollout, slots, activation transactions, writer authority, and public lifecycle commands are deleted |

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
SQLite schema compatibility (distributed metadata only; never database contents)
local pre-upgrade database backup contract under Controller Home
Worker protocol version
migration and rollback metadata
```

Release validation is offline and does not require a second serving Runtime, traffic router, fixed alternate port, or persistent slot identity. `src/runtime/root/release-store.ts` records one atomic active/previous authority and binds each previous release to a verified local SQLite backup under Controller Home. SQLite rows are project execution state: they are not copied into the immutable release, source repository, installer, manifest, or anything distributed to another user.

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
| `src/runtime/supervisor/**` | deleted; architecture checks require the directory to remain absent |
| Stable Ingress router and ingress session/process state | deleted in phase 4; one Runtime endpoint is configured directly |
| MCP KeepAlive/restart commands and implementations | public/hidden entrypoints, the 911-line restart implementation, and the 1,136-line KeepAlive process/tunnel/restart owner are deleted in phase 2; reusable HTTP/stdio transports remain module code only |
| MCP transport and Gateway tool Daemon auto-start | removed in phase 2; readiness and tool responses may observe daemon status but cannot create or recover Controller Services |
| independent daemon entry and component service API | deleted; `runtime-status-client.ts` is read-only observation over Canonical Forge Runtime state |
| `src/cli/controller/runtime-slots.ts` and slot homes | deleted in phase 4; architecture checks require them to remain absent |
| `src/cli/controller/bluegreen-rollout.ts` | deleted; must not return |
| public `controller` lifecycle/blue-green commands and public `supervisor` command | deleted from the supported CLI surface and implementation tree |
| detached restart coordinator and component restart bridges | deleted, including retired stubs and repository lifecycle shell entrypoints |
| standalone Recovery PI/agent repair and repository-write authority | removed in phase 2; Recovery code must never launch an agent in, generate scripts in, move files from, or otherwise mutate a source checkout |
| stable ingress ports and private blue/green ports | deleted; one Runtime endpoint is configured directly |
| component generation and mixed-generation coherence | deleted; one Runtime instance/release identity remains |
| Gateway/MCP component restart, rollout, rollback, green-gate and Supervisor facade operations | removed from direct tools and `rh_status`/`rh_work`; no compatibility facade may trigger lifecycle changes |
| component rollout/rollback operation stores | deleted with the Supervisor implementation; only whole-Runtime release authority remains |
| compatibility authority projections | deleted after one-way migration; no permanent dual-read or dual-write remains |

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

Those directions are historical only. They must not reappear as executable compatibility paths, fallback scripts, durable authority, or release mechanisms.

## 9. Required review questions

Every Runtime refactor review answers:

1. Which of the seven phases owns this work?
2. Does it directly reduce the gap for that phase?
3. Does it add a process, state, owner, authority, or long-term compatibility path?
4. Does it reintroduce component deployment, recovery, or rollback?
5. Does completion move the system toward one Runtime, one Owner, and one release?
6. Which legacy layers still remain?
7. What is the next deletion or convergence step?

## 10. Completed source convergence order

1. `forge-runtime` became the only supported core startup entry.
2. Controller startup and Worker Manager ownership moved into Runtime Root.
3. Public readiness converged to one whole-Runtime boolean decision.
4. Stable Ingress was removed and MCP Transport binds directly to the configured Runtime endpoint.
5. Runtime slots, fixed alternate ports, mixed generations, and component cutover were removed.
6. Whole-Runtime release, database backup, and rollback authority was established.
7. Worker commits were bound to Runtime instance, release identity, Job attempt, and Lease fencing.
8. Supervisor, KeepAlive wrappers, independent Daemon entry, restart coordinator, component rollout/rollback, and compatibility authority were deleted.
9. One stable Forge Runtime service and standalone Recovery watchdog were added without slots: sustained failure triggers bounded whole-Runtime restart, then attested previous-release rollback and verification.

Forge has no blue-green Runtime pair. Candidate canaries execute before an explicitly authorized stop/switch/start activation, and failed activation or later sustained failure uses the single previous whole-release authority. No rollout, service installation, service restart, or live cutover is implied by source implementation work.
