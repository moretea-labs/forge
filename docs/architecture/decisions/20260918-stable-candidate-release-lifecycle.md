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

`Recovery/state/release-sessions/<id>.json` is the current bounded storage path
for the ReleaseSession transaction journal; that path is not authority. The
ReleaseSession domain owns semantic phase progression and a per-record revision
CAS, while the executing Recovery provider holds the existing mutation lock for
physical operations. A stateless ReleaseCoordinator derives the next action
from the persisted phase and has no second daemon, scheduler, Work, or durable
coordinator state. Only one non-terminal ReleaseSession may exist per Forge
instance. An interrupted `source_frozen` preparation resumes that same session
when the frozen source and Stable A identity still match.

ReleaseSession separates wire compatibility from semantic authority. One-way migration also reconciles historical legacy `soaking` records without guesswork: Candidate B is terminalized as `known_good` only when exact durable lineage proves it became a later Stable A, or current RuntimeReleaseAuthority `previous` references that exact release identity; missing or branched proof fails closed. Its
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
or port. `cutover_attempting` permits exactly one fenced production cutover;
verified return to exact A terminalizes `rolled_back` and is never retried.
Successful cutover enters `soaking`; only the existing full verification +
performance observation + recoverable release/SQLite/service bundle attestation
may terminalize `known_good`. The state machine records redacted receipt ids and
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
- private writer environment cannot cross service or child boundaries;
- stale or missing known-good bundle material cannot protect a release;
- ReleaseSession cannot advance past static/candidate gates or a stale CAS;
- terminal Process observation and full maintenance both reconcile any exact leftover workspace lease; `completed_unknown` cannot permanently fence a checkout;
- final live release testing remains a separate, one-shot governed operation.
