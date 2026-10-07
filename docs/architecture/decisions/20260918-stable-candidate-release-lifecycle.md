# ADR: Stable A / Candidate B and ReleaseSession authority

- **Status:** Accepted source architecture; authority boundary refined 2026-09-20; live cutover remains a separate release operation
- **Date:** 2026-09-18
- **Authority:** [`../CURRENT.md`](../CURRENT.md) and executable Runtime/Recovery contracts

## Decision

Forge self-hosting has two lanes during a release session:

```text
Stable A (fixed known-good package Runtime)
  source read/edit/build/static verification + Recovery control
  remains running and is never upgraded by the session

Candidate B (one isolated Controller Home)
  copied SQLite snapshot + independent token/config/port/service label
  portable immutable release materialized once and tree-hashed
  all candidate canaries on the exact artifact later promoted to A

ReleaseSession (release domain)
  sole durable normal-release lifecycle authority
  durable receipt/fence journal
  final semantic routing decision: B or still-healthy A

Standalone Recovery provider
  physical Candidate B preparation and verification
  fenced Runtime activation / rollback
  Watchdog health recovery only
```

Candidate B never shares A's Controller Home, `control-plane.sqlite`, release
authority, token file, TCP port, service label, Runtime incarnation, Supervisor
socket or writer claim. B is not a second production authority: its Home is a
bounded test clone. New compiled release manifests are deployment-portable and
omit Controller Home; deployment binding belongs to release authority/service
contract instead. The exact verified B artifact is promoted byte-for-byte into
A's immutable release store. A remains the execution plane until an approved
ReleaseSession reaches one final cutover.

No source build, static gate, architecture review or ordinary test may stop or
activate Stable A. After the source batch is accepted, ReleaseSession may boot
and restart only isolated Candidate B while A remains continuously available.
The sole production cutover happens only after B passes Recovery, MCP,
Scheduler, Supervisor and controller canaries. Final certification then covers
A→B→C continuation, failed startup, Recovery interruption, Runtime restart,
MCP reconnection, stale Supervisor writer and return-to-A rollback.

## Incarnation and writer fence

`runtime-incarnation.json` is the Controller-Home durable writer epoch. Runtime
ownership acquires it monotonically with `runtimeInstanceId`, PID and
`fencingGeneration`; a child claim contains the same generation. A write is
valid only when owner, incarnation and whole-release authority all match.
Crash/hard-stop replacement advances the generation, making every old Runtime,
Scheduler worker, Gateway request and process writer stale without relying on
their `close()` handlers.

Supervisor's Unix socket has only ephemeral owner evidence containing the same
incarnation. A live socket is a hard writer conflict. A non-connectable socket
can be reconciled only as stale evidence for a different incarnation; the
historical `WORKFLOW_SUPERVISOR_WRITER_ALREADY_PRESENT` condition is therefore
an acceptance case, not a fallback branch.

Every service/Recovery/child boundary starts from the shared private-authority
environment sanitizer. It strips `FORGE_CONTROLLER_*`, `FORGE_RUNTIME_*`,
`FORGE_RELEASE_*`, `FORGE_SUPERVISOR_*`, `FORGE_WRITER_*` (including
`FORGE_WRITER_SLOT`) and related process identity. The exact selected release
contract may then add its own values. No ambient host claim is inherited.

## Recovery bundle and known-good

Known-good schema v2 means all of the following validate together:

1. immutable release manifest identity;
2. Recovery-owned SQLite `VACUUM INTO` snapshot with SHA-256 and inspection
   counts/schema;
3. a hashed declarative Runtime service-contract snapshot.

The bundle lives below `Recovery/bundles/known-good/<attestationId>`. Recovery
creates its data before atomically publishing the known-good record, then
prunes unreferenced bundles only after publication. A crash leaves at most an
orphan for the same Recovery owner to clean; it never publishes a metadata-only
known-good record. Release retention uses this exact validator. Legacy schema-1
records remain audit history only and have no retention or rollback authority.

## ReleaseSession state

`Recovery/state/release-sessions/<id>.json` is the durable storage path for the
ReleaseSession transaction journal; that path is not a second authority. The
ReleaseSession domain owns semantic phase progression and a per-record revision
CAS, while the executing Recovery provider holds the existing mutation lock for
physical operations. Authority decisions read the complete journal through a
process-local cache that is invalidated by atomic session writes and directory
changes; bounded inventories are diagnostic/projection surfaces only and may
never decide whether an active or prior-attempt session exists. Terminal session
records remain durable evidence, while their Candidate B homes are physically
retired once; an already-absent home is an idempotent no-op and is not emitted as
a fresh cleanup event. A stateless ReleaseCoordinator derives the next action
from the persisted phase and has no second daemon, scheduler, Work, or durable
coordinator state. Only one non-terminal ReleaseSession may exist per Forge
instance. An interrupted `source_frozen` preparation resumes that same session
when the frozen source and Stable A identity still match.

Recovery's own bundle handoff acquires that same exclusive operation lock before
changing the immutable release pointer and holds it through activation verification
or exact rollback. New Gateway requests are fenced during this interval and the
admission marker is cleared on every exit. Open read-only MCP streams are transport
connections, not in-flight mutation evidence; HTTP request counts cannot add a
second quiescence gate. The existing service handoff still proves the previous
process has stopped and the exact replacement is serving before acceptance.

ReleaseSession separates wire compatibility from semantic authority. One-way migration also reconciles historical legacy `soaking` records without guesswork: Candidate B is terminalized as `known_good` only when exact durable lineage proves it became a later Stable A, or current RuntimeReleaseAuthority `previous` references that exact release identity; missing proof fails closed. Multiple later ReleaseSession attempts that all name the same exact Candidate B as Stable A are corroborating acceptance evidence, not branches. Successor proof is derived from one pre-migration inventory snapshot, so rewrite order cannot manufacture or erase acceptance evidence. Its
storage `schemaVersion` remains 1 so the immediately previous Recovery release
can still inventory the record after an exact rollback; current code requires
`semanticEpoch=2`. The migration boundary rewrites legacy epoch-1/epoch-less
records once and thereafter steady-state code consumes only epoch 2. The
`transaction` field is additive on the wire and ignored by the prior reader.
RuntimeReleaseAuthority schema 2 is the physical active/previous pointer plus
rollback SQLite artifact only; it carries no ReleaseSession transaction state.

```text
source_frozen → built → static_verified → candidate_booted
  → candidate_verified → cutover_eligible → cutover_attempting
  → cutover_committed → soaking → known_good
                         ↘ rolled_back / failed
```

`static_verified` requires type, runtime-architecture, architecture-sync and
bootstrap receipts from the frozen source revision. `candidate_verified`
requires Recovery restart, MCP, Scheduler, Supervisor and controller receipts
from isolated B. `cutover_eligible` is impossible while A and B collide on Home
or port. Before the first production activation, a transient failure to obtain a
fresh Stable A verification leaves the same ReleaseSession `cutover_eligible` so
the exact candidate can be retried after observation recovers; proven Stable A
identity drift is a real precondition failure. `cutover_attempting` permits
exactly one fenced production cutover; verified return to exact A terminalizes
`rolled_back` and is never retried. If observation is interrupted after the
rollback authority commit but before the ReleaseSession phase write,
reconciliation requires the exact `release-session-rollback:<sessionId>:`
authority operation plus matching Stable A, candidate and transaction identities;
it then records `rolled_back` without replaying the rollback effect.
Physical service handoff follows the same effect rule: a launchd/systemd helper
error or timeout is not itself authority that the requested stop/start failed.
Recovery performs bounded observation of the exact service identity and may
continue the same fenced transaction only when the physical effect is proven;
otherwise that transaction fails. Before stopping Stable A, Recovery may build
the rollback SQLite snapshot while A is still serving, but only under a
long-lived SQLite `data_version` observer. Any commit by another SQLite
connection during or after that speculative snapshot invalidates it; after
quiescence the release store discards it and falls back to the stopped-state
snapshot. Recovery also computes the bounded SHA-256 of that snapshot while A
is still serving. RuntimeReleaseAuthority persists this whole-database identity;
on rollback, a fresh live `VACUUM INTO` snapshot is compared against it. Only an
identical whole-database snapshot may be restored from the cutover backup. Any
SQLite change, including domain tables outside `control_plane_audit`, preserves
the newer live database while the Runtime release rolls back. Legacy backups
without whole-database identity also preserve live state. This optimization
therefore removes normal-path database copy/hash cost from the outage window
without weakening rollback or losing post-cutover durable state.

During the stop/start critical section, readiness convergence is intentionally
narrow: canonical Runtime owner/status, exact release/artifact authority and the
local `/ready` endpoint. Recovery Gateway/watchdog/tunnel probes, Connector
transport probes, execution canaries, known-good inspection and MCP protocol
verification are not activation-readiness inputs. After Runtime readiness,
Recovery rebinds the persistent Connector and then runs strict whole-Runtime
verification exactly once. There is no second readiness polling phase after
Connector rebinding. Once the physical candidate authority is published, the
ReleaseSession rollback transaction is durably captured before Candidate B is
started, so every later start/Connector/acceptance failure already has exact
Stable A rollback identity. Recovery never replays a cutover merely because a
helper response was lost.
Automatic source reconciliation is also revision-bounded: once an immutable
source revision has any terminal ReleaseSession, the daemon will not create a
second automatic ReleaseSession for that same revision. Explicit human release
operations remain available, and a changed source revision becomes eligible for
a new automatic attempt. This rule is derived from ReleaseSession history; it
introduces no retry ledger or second release authority.

Successful cutover enters `soaking` as soon as the canonical live Runtime observation proves the expected release/artifact identity is running, ready and non-stale. Cutover reconciliation does not rerun the expensive full verification suite after activation. Only the existing full verification + performance observation + recoverable release/SQLite/service bundle attestation may terminalize `known_good`. A definitive runaway-CPU rejection is an acceptance
failure, so Recovery executes the existing exact Stable A rollback transaction
instead of leaving Candidate B in `soaking` for repeated performance sampling.
Transient/unknown observations remain non-terminal and may be reconciled against
the same ReleaseSession. The state machine records redacted receipt ids and
summaries, never tokens, raw database payloads or browser messages.

## Persistent-state contract

| State | Semantic owner / writer | Terminal & retention | Recovery |
| --- | --- | --- | --- |
| `runtime-incarnation.json` | Canonical Runtime ownership acquisition | latest epoch; superseded generations remain stale | next owner CAS-reconciles |
| Supervisor socket owner evidence | Canonical Runtime/Supervisor composition | deleted with socket; ephemeral | probe then remove only stale non-connectable socket |
| known-good bundle | Standalone Recovery | bounded live attestations; prune only after state commit | validate release + DB + service contract offline |
| RuntimeReleaseAuthority | Runtime Root physical release store | schema 2; active/previous release identity and previous SQLite backup only | physical publish/rollback; no release-phase or transaction intent |
| ReleaseSession | Release domain / stateless ReleaseCoordinator | wire schema 1 + current semantic epoch 2; `known_good`, `rolled_back`, `failed`; bounded session retention is physical cleanup | revision CAS resumes the same session; Recovery provider executes physical effects |
| Candidate B Home | ReleaseSession semantic authority / Recovery physical provider | explicit terminal cleanup only after evidence retention | no deletion/rebuild of A; B can be inspected independently |
| Process Runtime terminal lease | Process Runtime lease authority | terminal evidence and lease release are separate idempotent phases | terminal observation/wait/cancel and full maintenance retry exact lease release until settled |

All bundle and session data is local Controller state. It contains no secrets:
the service contract records a token *path*, while each B token is an independently generated private credential and is never copied from A. SQLite data follows the Controller Home's existing privacy/backup policy.

## Verification

- Ordinary repository Work terminalizes at accepted source delivery and cannot depend on Runtime staging, activation, soak or known-good;
- release-level gates execute once for the frozen ReleaseSession candidate rather than once per contributing Work;
- Candidate lane derivation/build cannot mutate A; Candidate boot/restart touches only B's isolated service/Home;
- byte-identical release-tree identity is required for B→A promotion; no production rebuild is allowed;
- stale Runtime generation and release claims cannot write;
- every Recovery restart/release transition proves service, Runtime owner, TCP listener and Supervisor writer quiescence before authority may change;
- Recovery restart/cutover readiness polling is bounded to fenced Runtime identity plus local readiness; strict whole-Runtime verification remains a single post-Connector acceptance gate;
- the normal cutover prebuilds and hashes its rollback SQLite snapshot while Stable A is live and reuses it only when one SQLite-wide `data_version` observer proves no intervening commit; otherwise stopped-state backup remains the fail-closed fallback;
- rollback restores the cutover SQLite snapshot only when whole-snapshot SHA-256 matches a fresh live snapshot; any database-wide change preserves live SQLite, while `auditEventCount` remains compatibility/diagnostic evidence only;
- ReleaseSession captures exact rollback transaction identity immediately after the physical authority publish and before Candidate B starts;
- private writer environment cannot cross service or child boundaries;
- stale or missing known-good bundle material cannot protect a release;
- ReleaseSession cannot advance past static/candidate gates or a stale CAS;
- no-op automatic reconciliation does not fork a Recovery worker, and terminal source revisions are not autonomously replayed;
- definitive runaway-CPU rejection restores Stable A through the existing ReleaseSession rollback authority rather than repeating soak measurement;
- terminal Process observation and full maintenance both reconcile any exact leftover workspace lease; `completed_unknown` cannot permanently fence a checkout;
- final live release testing remains a separate, one-shot governed operation.
