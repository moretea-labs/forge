# Single-Owner Runtime Architecture and Deletion Map

> **Status: Runtime Authority — Approved Target Architecture**
>
> **Scope:** process ownership, runtime authority/configuration, immutable release activation, and standalone Recovery.
>
> **Current implementation status:** transition. The execution control plane described by `system-overview.md` is implemented, but the installed lifecycle still contains blue/green slots, nested KeepAlive ownership, and compatibility fallbacks. This document is the target and migration contract; it must not be read as evidence that the cutover is complete.

## 1. Decision

The Controller Runtime converges to one local authority and one primary runtime instance. A fixed operating-system bootstrap starts one immutable Supervisor release. The Supervisor owns the primary ingress, Controller Daemon, and Gateway children. Recovery is an independent, immutable service family with its own state boundary and public tunnel. No ordinary runtime release, repository worktree, Gateway child, or Recovery process may become a second lifecycle owner.

The supported lifecycle is:

```text
macOS launchd (exactly five services)
├── repo-harness Supervisor
│   ├── stable ingress child (public loopback bind and last-known-good routing)
│   ├── Controller Daemon (scheduler and repository actors)
│   └── Gateway (MCP HTTP/stdio host and optional local UI)
├── primary cloudflared (primary public URL -> stable ingress)
├── Recovery Gateway (loopback-only bounded Recovery MCP)
├── Recovery Watchdog (local/primary/Recovery probes and bounded decisions)
└── recovery cloudflared (Recovery public URL -> Recovery Gateway)
```

The five launchd services are:

| Service | Owner | Boundary | Restart rule |
| --- | --- | --- | --- |
| `repo-harness Supervisor` | launchd | Fixed bootstrap plus immutable Supervisor release | Restart on abnormal exit; explicit authorized unload remains stopped |
| `primary cloudflared` | launchd | Primary public endpoint only | Restart only its own tunnel; never starts or stops the Gateway |
| `Recovery Gateway` | launchd | Recovery loopback endpoint only | Restart on abnormal exit; explicit authorized unload remains stopped |
| `Recovery Watchdog` | launchd | Recovery observation and bounded action dispatch | Restart on abnormal exit; persisted cooldowns prevent noisy loops |
| `recovery cloudflared` | launchd | Recovery public endpoint only | Restart only its own tunnel; never changes primary authority |

`launchd` owns service restart. The Supervisor does **not** supervise Recovery Gateway, Recovery Watchdog, or either cloudflared service. `cloudflared` does **not** supervise a Gateway. The Supervisor is the only process allowed to create or terminate the primary ingress, Daemon, and Gateway children.

## 2. Current implementation versus target

### Current implementation facts

The current source already has useful building blocks:

- `src/runtime/supervisor/` provides a stable lifecycle parent, control socket, operation store, process identity checks, and structured readiness.
- `src/runtime/control-plane/daemon-entry.ts` provides a separately runnable Daemon.
- `src/cli/mcp/keepalive.ts` and `src/cli/mcp/restart.ts` still combine Gateway serving, tunnel management, detached restart behavior, and compatibility lifecycle logic.
- `src/cli/controller/runtime-slots.ts`, `src/cli/controller/bluegreen-rollout.ts`, and slot-local homes implement the current blue/green model.
- `src/runtime/bootstrap/activation-transaction.ts` and stable-state writer fencing provide partial transaction and claim primitives.
- `src/runtime/standalone-recovery/` and `scripts/install-standalone-recovery.ts` provide a Recovery source and installer, but the installed artifact/lifecycle contract is still being hardened.

The current implementation may report a healthy local runtime while the installed Supervisor release and mutable runtime source identify different revisions. It also has root, slot, and repository-local configuration readers. Those are migration evidence, not approved future authority.

### Target facts

After cutover:

- the launchd plist contains only a fixed bootstrap path and stable Controller Home; it never points at a repository worktree or a mutable runtime source root;
- the Supervisor release contains all code required to start the Supervisor, ingress, Daemon, and Gateway children, with a manifest and exact digest;
- one committed primary authority record selects one active release and one generation;
- one primary runtime config record supplies service topology and endpoint policy;
- a candidate and a previous release may exist temporarily, but there is no persistent blue/green slot identity;
- Gateway serving has no KeepAlive child manager and no tunnel lifecycle;
- Recovery binaries can cold-start without the repository checkout, Primary Gateway, Controller Daemon, active runtime, or Bun;
- Recovery state is never used as a primary authority projection and Recovery actions cannot mint, adopt, or write a primary writer claim.

## 3. Ownership and write boundaries

| Concern | Sole owner | Allowed writes | Forbidden writes |
| --- | --- | --- | --- |
| launchd registration and service restart | OS service manager plus explicit installer | service definitions and load/unload state | runtime authority, release selection |
| primary release publication/cutover | Supervisor release transaction | candidate/previous manifests, authority CAS, ingress route | arbitrary repository files, Recovery state |
| primary process lifecycle | Supervisor | child spawn, identity-scoped stop, health projection | Recovery process lifecycle, tunnel process lifecycle |
| primary authority | Supervisor activation transaction | one committed authority record and atomic projections | Daemon/Gateway/Recovery direct authority mutation |
| primary runtime config | Controller Home installer/config writer | one canonical config record | slot/root/repository-local business overrides |
| ingress route | stable ingress child, using committed authority | route observation and per-request read | release selection or authority mutation |
| scheduling and repository actors | Controller Daemon | durable execution state under Controller Home | root runtime authority, release selection |
| MCP request handling | Gateway | sessions, schema, bounded acknowledgements, runtime observations | child process supervision, tunnel start/stop, authority mutation |
| primary public endpoint | primary cloudflared service | its own service/process state | Gateway/Daemon/Recovery lifecycle |
| Recovery endpoint | Recovery Gateway | Recovery-local state and audit records | primary Controller Home authority/config |
| Recovery decisions | Recovery Watchdog | Recovery state, bounded Supervisor operation request | direct shell, SSH, arbitrary command, primary authority |
| Recovery public endpoint | recovery cloudflared service | its own service/process state | primary tunnel or primary authority |
| evidence and audit | owning component, append-only | receipts and observations scoped to owner | last-writer-wins replacement of another owner’s state |

A process may write only records carrying its captured owner identity, generation, and fencing token. Late health, shutdown, callback, and `finally` paths use the same write fence. An unproven PID is observed and preserved; it is never sufficient authorization for cleanup or takeover.

## 4. Canonical state and configuration

### 4.1 Primary authority

The canonical primary record is:

```text
<controllerHome>/bootstrap/runtime-authority.json
```

It is the only committed primary authority. Its minimum schema is:

```json
{
  "schemaVersion": 1,
  "authorityTerm": "wa-<monotonic-decimal>",
  "activationId": "<idempotency-key>",
  "generation": "<new-per-activation>",
  "active": {
    "releasePath": "<immutable-release-directory>",
    "releaseRevision": "<exact-commit-or-build-revision>",
    "sourceCommit": "<source-identity-recorded-at-build>",
    "manifestHash": "<sha256>",
    "publishedAt": "<timestamp>"
  },
  "previous": {
    "releasePath": "<immutable-release-directory>",
    "releaseRevision": "<exact-revision>",
    "manifestHash": "<sha256>",
    "rollbackUntil": "<timestamp>"
  },
  "ingress": { "host": "127.0.0.1", "port": 8765 },
  "operationId": "<optional-in-flight-operation>"
}
```

`previous` is rollback evidence, not a second active owner. A prepared transaction, operation receipt, audit record, Supervisor observation, slot manifest left by migration, and runtime-generation projection are not authority. Reconciliation rebuilds projections from this record; it never repairs authority by editing a projection alone.

`authorityTerm`, Supervisor `ownerEpoch`, runtime `generation`, operation `operationId`, and resource lease fencing tokens are distinct. None may be substituted for another. Authority terms are monotonic and are never reused after a reservation crash.

### 4.2 Primary runtime config

The canonical primary config is:

```text
<controllerHome>/bootstrap/runtime-config.json
```

It contains only service topology and policy required by the Supervisor and its children:

```json
{
  "schemaVersion": 1,
  "controllerHome": "<canonical-home>",
  "ingress": { "host": "127.0.0.1", "port": 8765 },
  "daemon": { "port": 8786 },
  "gateway": { "host": "127.0.0.1", "port": 8795, "auth": "oauth" },
  "primaryPublicEndpoint": "<optional-normalized-url>",
  "primaryTunnelService": "<launchd-label>",
  "toolset": "advanced",
  "accessMode": "full-access"
}
```

The config does not contain arbitrary command strings, repository-specific runtime overrides, slot names, or mutable source paths. Token stores and repository durable state remain under their established Controller Home boundaries, but they are selected by this config and no longer discovered through root/slot/repository fallback precedence.

### 4.3 Projections and transaction records

The Supervisor may persist observations, operation receipts, activation journals, incidents, launch quarantine, and append-only audit records below `supervisor/`. Those records are scoped by the authority term and activation ID and cannot become a competing authority. Temporary transaction directories are deleted or archived after commit/abort according to the release retention policy.

Compatibility projections such as `active-slot.json`, `bootstrap/writer-authority.json`, slot `generation.json`, and legacy `runtime-generation.json` are migration inputs only. They are rewritten from `runtime-authority.json` during the one-way migration, then removed after the rollback window closes.

### 4.4 Recovery boundary

Recovery owns a separate home, denoted `<recoveryHome>`, and exactly one durable state boundary:

```text
<recoveryHome>/config.json
<recoveryHome>/state/recovery-state.json
<recoveryHome>/audit/
<recoveryHome>/releases/<release-id>/
<recoveryHome>/current -> <release-id>
```

`recovery-state.json` contains the Recovery binary/config identity, failure window, first/last observation times, classified evidence, rollback-used flag, cooldowns, last decision, and watchdog writer identity. It never contains or mirrors a primary writer claim. Corrupt, expired, identity-mismatched, or concurrently owned Recovery state resets to a new degraded observation; it never reuses old failure counters.

## 5. Immutable release and activation contract

Every published primary and Recovery release is self-contained, non-empty, manifest-addressed, and installed below a versioned directory. A `current` pointer is activated only after the complete release closure and harmless process-runner receipt pass. Publication uses hidden staging plus atomic directory rename; an interrupted install leaves the prior current release usable and does not create a partially valid release.

A primary activation follows this order:

1. Acquire the local authority lock and read the committed authority, config, operation, and current release manifest.
2. Validate the expected old `(authorityTerm, activationId, generation, releaseRevision, sourceCommit, manifestHash)` tuple. A mismatch refuses the transaction.
3. Reserve a new monotonic authority term and write a prepared transaction record. Do not change committed authority or ingress.
4. Start candidate Supervisor children from the immutable candidate release with the prepared claim. Candidate state is transaction-scoped.
5. Require Daemon, Gateway, stable ingress, control socket, authenticated MCP read-only, generation, and exact release/source coherence before cutover.
6. Reacquire the lock and CAS the unchanged committed tuple. If it changed, abort only the candidate transaction.
7. Atomically commit `runtime-authority.json` and ingress projection, fence the old claim, and verify post-cutover control, ingress, and MCP readiness.
8. Retain the former active release as `previous` for the bounded rollback window. Stop and reclaim the candidate/old processes only with matching process identity and claim.

Rollback is a new operation and a new authority term. It requires exact previous path, revision, manifest hash, open rollback window, healthy standby evidence, no conflicting operation, and independent post-rollback verification. Missing evidence produces `degraded` or `quarantined`; it never mutates authority.

## 6. Availability and safety invariants

1. **One primary authority:** exactly one committed primary writer claim exists for a Controller Home.
2. **One primary instance:** at most one committed primary generation serves traffic; stale children are fenced and terminated or isolated deterministically.
3. **Last-known-good continuity:** ingress stays on the committed release until candidate readiness and CAS commit pass. Candidate failure cannot remove current traffic.
4. **No nested lifecycle owner:** Gateway, Daemon, ingress, tunnel, and Recovery processes cannot create a competing KeepAlive/restart loop.
5. **Exact identity:** PID, process start time, executable fingerprint, Controller Home, service label, owner epoch, writer term, generation, release revision, and source identity must agree before a process is managed.
6. **Captured release identity binding:** Supervisor-managed children receive a spawn-time binding (`releasePath`, `releaseRevision`, `sourceCommit`, optional `manifestHash`) and must not re-derive identity from ambient Git HEAD. See ADR [`../decisions/20260803-release-identity-binding-and-exit-policy.md`](../decisions/20260803-release-identity-binding-and-exit-policy.md).
7. **Failure-domain separation:** child readiness and incomplete managed pairs degrade inside the Supervisor; they must not exit the Supervisor process and thrash the OS service manager. launchd/systemd restarts only abnormal Supervisor exits.
8. **No stale durable writes:** every mutable write checks a captured claim and expected identity/CAS; stale callbacks return `WRITER_FENCED` or append evidence only.
9. **Independent Recovery:** Primary Gateway, Daemon, active release, repository checkout, and primary tunnel failure do not remove Recovery reachability. Recovery failure does not restart or mutate the primary runtime.
10. **Bounded Recovery action:** Recovery exposes only verify, request registered Supervisor restart, eligible rollback request, and cleanup actions with operation ownership, rate limits, audit, and re-verification. It cannot execute arbitrary shell, SSH, or provisioning.
11. **Honest observations:** missing primary endpoint is `unknown`; missing independent Recovery endpoint/service is `unavailable`; malformed or normalized-equal endpoints are failed configuration. These states are never coerced to healthy.
12. **Explicit stop semantics:** abnormal service exit may restart through launchd; an authorized unload must remain stopped until explicitly loaded again.
13. **One-way migration:** unsupported legacy state reports `MIGRATION_REQUIRED`; it is not guessed through silent fallback.
14. **Release closure:** no service starts, publishes, rolls out, or rolls back from an incomplete or unverified immutable release.

## 7. One-way migration contract

Migration is a bounded, transactional cutover from the current installed lifecycle. It is not a permanent dual-read/dual-write compatibility mode.

1. **Inventory and freeze:** record all active PIDs, service labels, source/release identities, root/slot config paths, tunnel processes, and Recovery artifacts. Stop new rollout/restart requests.
2. **Bootstrap:** install a fixed launchd Supervisor bootstrap that references only the stable Controller Home and immutable Supervisor release. Do not use the current checkout as a service executable.
3. **Canonicalize:** under the authority lock, validate the current active release and convert surviving state into `runtime-authority.json` and `runtime-config.json`. Preserve raw legacy inputs as migration evidence only.
4. **Quiesce:** identity-safely stop detached KeepAlive, `mcp serve`, Local Controller, old Daemon, old Supervisor, slot processes, and repo-local launch agents. Never stop an unproven PID.
5. **Activate:** start the Supervisor from the new immutable release; it starts ingress, Daemon, and Gateway children, verifies complete readiness, and publishes one committed generation.
6. **Separate tunnels:** load primary and Recovery cloudflared services independently. Each service has one endpoint and one local upstream; neither is launched by Gateway KeepAlive.
7. **Exercise faults:** run cold start without the worktree, crash/restart each service, candidate failure, interrupted install, port conflict, stale callback, primary tunnel failure, Recovery tunnel failure, and explicit unload.
8. **Close window:** after exact-revision and rollback evidence is recorded, remove old launchd templates, slot directories, fallback readers/writers, detached restart coordinator, and duplicate Issues or narrow them explicitly.
9. **Finalize governance:** update `tasks/current.md`, task notes, architecture status, release evidence, and the deletion receipts. No remote push is implied by this migration.

If any canonicalization or identity check fails, the system stops with `MIGRATION_REQUIRED` and leaves the last-known-good service/state untouched.

## 8. Deletion and replacement map

The following map is the implementation boundary for T2–T9. A row marked **delete** is not removed until its replacement has passed the specified cutover and rollback-window evidence.

| Current component or path | Disposition | Replacement / owner | Task |
| --- | --- | --- | --- |
| `src/runtime/supervisor/installer.ts` mutable source-root launchd/systemd templates | replace, then delete old template branch | fixed bootstrap + immutable Supervisor manifest | T2 |
| `src/runtime/supervisor/entry.ts` runtime-source fallback to checkout | narrow, then delete fallback | release-bound Supervisor entry | T2/T7 |
| `src/cli/controller/runtime-slots.ts` and slot-local authority discovery | migrate, then delete | candidate/previous release records in one authority file | T3/T5/T7 |
| `src/cli/controller/bluegreen-rollout.ts` persistent blue/green orchestration | replace, then delete | single candidate transaction and last-known-good ingress | T5/T7 |
| `src/cli/controller/stable-state/stable-home.ts` dual root/slot home resolution | replace, then delete | one canonical Controller Home + transaction directory | T3/T7 |
| `src/cli/controller/stable-state/writer-authority.ts` as a second projection | merge, then delete compatibility projection | `bootstrap/runtime-authority.json` term/token claim | T3/T7 |
| `src/runtime/bootstrap/stable-bootstrap.ts` active-slot compatibility projection | simplify, then delete projection writes | authority transaction and ingress pointer commit | T3/T5/T7 |
| `src/runtime/bootstrap/activation-transaction.ts` slot-specific commit paths | retain primitives, remove slot branches | release activation transaction | T5/T7 |
| `src/runtime/supervisor/process-manager.ts` slot/KeepAlive process kinds | simplify | Supervisor children only: ingress, Daemon, Gateway | T4/T7 |
| `src/cli/controller/lifecycle.ts` detached KeepAlive lifecycle and repo-local fallback | replace, then delete | Supervisor-owned child lifecycle | T4/T7 |
| `src/cli/controller/restart-coordinator.ts` detached Gateway ancestry replacement | replace, then delete | durable Supervisor restart operation | T4/T7 |
| `src/cli/mcp/keepalive.ts` tunnel spawning and nested MCP lifecycle | split, then delete lifecycle half | Gateway server plus launchd cloudflared services | T4/T6/T7 |
| `src/cli/mcp/restart.ts` PID/launch-agent fallback restart | replace, then delete fallback | typed Supervisor operation client | T4/T7 |
| `src/cli/mcp/auth.ts` root/blue/green token search | narrow, then delete fallback search | canonical runtime config/token boundary | T3/T7 |
| `src/runtime/supervisor/bridge.ts` compatibility restart/lifecycle bridge | replace, then delete legacy branch | stable Supervisor control client | T4/T7 |
| `src/runtime/standalone-recovery/*` flat/in-process Recovery lifecycle assumptions | replace in place | self-contained versioned Recovery Gateway/Watchdog artifacts | T6 |
| `scripts/install-standalone-recovery.ts` flat binary installation | replace | staged immutable Recovery release + atomic `current` activation | T6 |
| `scripts/load-standalone-recovery.sh` shared/implicit service assumptions | replace | two explicit Recovery launchd services plus dedicated tunnel | T6 |
| `scripts/controller-runtime.sh` and repo-local service restart helpers | narrow, then delete runtime mutation paths | fixed bootstrap and Supervisor operation client | T2/T4/T7 |
| `scripts/controller-ngrok-rotation.sh` primary tunnel lifecycle | replace, then delete | primary cloudflared service contract | T6/T7 |
| repository-local `.repo-harness/mcp.*` runtime config fallback | read for migration, then delete | Controller Home `runtime-config.json` | T3/T7 |
| `<controllerHome>/runtime-slots/{blue,green}` service/config trees | retain only migration evidence, then delete | release directories plus one transaction workspace | T3/T5/T7 |
| legacy launchd labels and plist templates discovered by `findRepoLaunchAgents` | boot out after identity audit, then delete discovery fallback | five declared service labels | T4/T7 |
| compatibility Issues that overlap lifecycle ownership | supersede or narrow with receipts | `ISS-20260802-539E7F` implementation authority; `ISS-20260802-27931A` Recovery delivery line | T1/T9 |

This table is exhaustive for the lifecycle boundary. Execution-plane compatibility (`Issue`, `Task`, `Run`, Edit Session, Job, Agent, repository, and MCP facade records) remains supported unless a later architecture decision explicitly changes it.

## 9. Sequenced implementation gates

| Gate | Required result | Owner task |
| --- | --- | --- |
| G1 | This target, ownership table, canonical schemas, invariants, migration contract, and deletion map are linked from the current architecture index. | T1 |
| G2 | Fixed bootstrap and self-contained Supervisor release pass clean install, manifest, interrupted-install, and cold-start checks. | T2 |
| G3 | One authority/config boundary is active; stale root/slot projections are rejected or migrated one-way. | T3 |
| G4 | Supervisor is the only primary child lifecycle owner; Gateway KeepAlive and detached restart fallbacks are gone from the supported path. | T4 |
| G5 | Candidate activation preserves last-known-good ingress and rollback is a new-term transaction. | T5 |
| G6 | Recovery artifacts, state, services, and tunnel are independent and can cold-start without Primary or Bun. | T6 |
| G7 | Legacy readers, writers, services, and slot state are deleted only after rollback-window receipts. | T7 |
| G8 | Fault injection covers every service boundary and release phase; no gate accepts port/PID health alone. | T8 |
| G9 | A real clean-revision migration, reboot, explicit unload, and governance sync produce exact receipts. | T9 |

Until G9 passes, architecture status remains **transition** and `tasks/current.md` must not claim unattended Recovery readiness.

## 10. Related authority documents

- [System Overview](system-overview.md) — execution control plane and current process facts.
- [Stable External Runtime Supervisor](stable-external-runtime-supervisor.md) — current Supervisor implementation and transition notes.
- [Failure Recovery](failure-recovery.md) — failure evidence and recovery invariants.
- [Verification and Release Gates](verification-and-release-gates.md) — exact-revision and release evidence.
- [Architecture Governance Contract](governance.md) — authority hierarchy and update rules.
- [Migration Roadmap](migration-roadmap.md) — ordered convergence record.
- `tasks/issues/ISS-20260802-539E7F-repo-harness.issue.md` — implementation authority.
- `tasks/issues/ISS-20260802-27931A-issue.issue.md` — Recovery delivery line.
