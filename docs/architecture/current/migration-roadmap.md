# Target Architecture Migration Record

> Status: **Active Migration Record**
> Completion baseline: 2026-06-25
> Lifecycle convergence baseline: 2026-08-02

The execution-plane phases below remain completed. The lifecycle itself is now a separate active convergence track governed by [`runtime-architecture-simplification.md`](runtime-architecture-simplification.md). It is not complete until its G1–G9 gates pass; current runtime health must not be interpreted as evidence that the five-service cutover has happened.

## P0 — Single-Owner Runtime Convergence

Active target:

- fixed launchd bootstrap starts an immutable Supervisor release;
- exactly five OS services exist: Supervisor, Recovery Gateway, Recovery Watchdog, primary tunnel, and Recovery tunnel;
- Supervisor children are only stable ingress, Controller Daemon, and Gateway;
- one `bootstrap/runtime-authority.json` and one `bootstrap/runtime-config.json` own primary lifecycle truth;
- candidate/previous release activation preserves last-known-good ingress;
- Recovery has an independent immutable release, state boundary, and tunnel;
- legacy blue/green, nested KeepAlive, detached restart, and root/slot fallback paths are deleted after verified cutover.

The implementation authority and deletion receipts are tracked by `ISS-20260802-539E7F`; the Recovery delivery line is tracked by `ISS-20260802-27931A`. The migration is one-way and fail-closed: unsupported legacy state reports `MIGRATION_REQUIRED` rather than selecting a fallback.

## P0 — Stabilize and Remove Request-Lifetime Execution

Completed:

- long and mutating MCP calls are persisted as durable Jobs and acknowledged immediately;
- Gateway session, body size, initialization and POST concurrency are bounded;
- overload produces explicit 429/503 responses instead of unbounded request accumulation;
- repository commands, checks, Edit verification, Agent dispatch and integration run outside Gateway;
- `/health`, `/ready` and repository health remain available during Worker execution;
- synchronous legacy code is confined to isolated Workers where compatibility requires it.

## P1 — Unified Execution Model

Completed:

- common `ExecutionJob` state machine;
- global request-id dedupe and semantic conflict detection;
- active/recent/request indexes;
- durable Operation Receipts before side effects;
- Job/Run separation, deadlines, attempts, heartbeat and reconciliation;
- append-only entity events;
- bounded result bodies and addressable Artifacts;
- ambiguous mutation recovery stops for human review instead of replaying blindly.

## P2 — Repository Actor and Resource Scheduling

Completed:

- one logical Actor mailbox per repository;
- Claims for Workspace, Worktree, paths, Git refs, checks, integration, remote and release resources;
- renewable Leases with monotonically increasing fencing tokens;
- attempt/PID/Lease ownership that rejects zombie Workers;
- conservative unknown write scope;
- Workspace single writer and eligible automatic Worktree placement;
- serial Integration and release barriers.

## P3 — Multi-Repository Control Plane

Completed:

- global Worker and Agent limits;
- Heavy Check and provider quotas;
- memory and CPU-load admission;
- priority plus aging fairness persisted across restart;
- per-repository actor isolation;
- cross-repository Portfolio DAG;
- deterministic stop/compensation Saga semantics;
- repository identity and remote-mapping diagnostics.

## P4 — Schedule Engine

Completed:

- first-class Schedule, Trigger, Decision and Occurrence records;
- interval, manual, UTC cron, calendar, condition-watch, repository-event and dependency-checkpoint triggers;
- deterministic occurrence-window identity and active/recent indexes;
- maximum active occurrences, cooldown, daily budget and persisted exponential backoff;
- consecutive-failure circuit breaker and external-blocker stops;
- dirty Workspace and release-freeze suppression;
- Shadow Mode default;
- Candidate Finding semantic dedupe and explicit human promotion;
- one bounded Job per executable Occurrence;
- unattended external-side-effect prohibition.

Operational rule: new mutation Schedules still begin in Shadow Mode as a rollout policy, not because the engine is incomplete.

## P5 — Verification and Release Gate

Completed:

- exact-revision Evidence records and environment fingerprints;
- stale revision rejection;
- Artifact references for large output;
- exclusive Release Freeze Lease;
- active Job/Run/Edit/Integration and repository-identity checks;
- exact-revision Task Verification requirements;
- deterministic release-ready manifest;
- explicit human authorization boundary for push, merge, publish and deployment.

## Maintenance Gate

Future changes must preserve architecture invariants, add an ADR before weakening a boundary, update the current architecture documents and extend focused checks for every new Job, Claim, Trigger, recovery path or release condition.
