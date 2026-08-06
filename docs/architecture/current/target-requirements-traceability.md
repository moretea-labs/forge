# Target Architecture Requirements Traceability

> Status: **Runtime Authority**  
> Baseline: **2026-06-25 target architecture migration**

This document maps every major section of the approved target architecture to executable implementation and verification evidence. It is a traceability index, not a second design authority.

Approved input: [`approved-target-architecture.zh-CN.md`](approved-target-architecture.zh-CN.md).

## 1. Overall topology

| Requirement | Status | Evidence |
| --- | --- | --- |
| Thin Gateway | Implemented | `src/runtime/gateway/mcp/`, `src/cli/mcp/server.ts` |
| Global Scheduler | Implemented | `src/runtime/control-plane/global-scheduler/` |
| Per-Repository Actor | Implemented | `src/runtime/control-plane/repo-actor/` |
| Durable Job | Implemented | `src/runtime/execution/jobs/` |
| Isolated Worker | Implemented | `src/runtime/execution/workers/` |
| Evidence Plane | Implemented | `src/runtime/evidence/`, `src/runtime/projections/` |

## 2. Layer responsibility migration

- MCP performs authentication, schema validation, repository routing, bounded projection reads and durable acknowledgement inside the Canonical Runtime.
- Runtime Root owns Controller Services, scheduling, reconciliation, Schedule and Portfolio progression in the same process.
- Repo Actor owns repository-local scheduling decisions and resource acquisition.
- Worker owns commands, checks, Agent execution, integration and compatibility implementations.
- Historical state is not used as a hot queue; active/recent/request indexes and projections are authoritative for observation.

Runtime evidence: `root/runtime.ts`, `root/entry.ts`, `router.ts`, `scheduler.ts`, `actor.ts`, `worker-entry.ts`, `materialized-view.ts`.

## 3. Target process topology

Implemented as one canonical application process plus isolated execution Workers:

```text
repo-harness-runtime (Runtime Root + Controller Services + Scheduler + Gateway/MCP)
repo-harness isolated Worker
```

One Runtime process owns the complete local application. One Worker process executes one bounded Job and is fenced by Runtime/Job/lease identity; Worker failure does not create another Runtime owner.

Verification: `tests/runtime/canonical-single-runtime.test.ts`, `scripts/smoke-mcp-http-runtime.ts`.

## 4. Architecture constitution

| Constitution rule | Implementation |
| --- | --- |
| MCP does not execute long work | Durable router; Workbench is a Job; Controller Context is a materialized read with Worker refresh |
| Persist before execute | `createExecutionJob` precedes Daemon dispatch |
| Idempotent mutations | global `requestId` index plus `semanticKey` conflict detection |
| Task and Run remain separate | legacy lifecycle preserved; Execution Job is a separate system entity |
| One scheduler owner per repository | Repo Actor mailbox and registry |
| Unknown Scope is conservative | `repo-content:*` write Claim |
| Short state locks, long execution Leases | atomic JSON transactions plus renewable Lease records |
| Hot paths use indexes | active/recent/request/run/integration/occurrence/portfolio/finding indexes |
| Execution and observation are isolated | Worker process plus health/projection reads |
| Verification binds exact Revision | Evidence record and release-gate revision checks |
| Conflicts queue instead of failing | explicit `waiting_for_*` Job states |
| External effects need authorization | defense-in-depth governance checks in Gateway, Schedule, Portfolio and Worker |

## 5. Work-mode and Agent strategy

The original Direct Edit, Quick Agent and Issue/Task assessment remains available. Runtime dispatch persists the chosen operation and preserves allowed Agent providers, timeout and browser permissions. Explorer/Implementer/Verifier policy remains a planning concern; deterministic integration and release checks remain program-owned rather than LLM-owned.

Evidence: `src/cli/controller/work-mode.ts`, `src/runtime/gateway/mcp/router.ts`, `src/runtime/execution/workers/executor.ts`.

## 6. Single-repository concurrency

Implemented Claims cover:

- `repo-state`;
- `workspace:<checkoutId>`;
- `worktree:<id>`;
- `path:<glob>`;
- `git-refs:<repoId>`;
- `heavy-check:<repoId>`;
- `integration:<repoId>`;
- `remote:<repoId>`;
- `release:<repoId>`.

Workspace writes serialize. Independent Worktrees may execute concurrently. Integration and Git-ref changes serialize. Unknown writes conflict with repository content. Lease ownership includes Job, Attempt, Worker PID and Fencing Token.

## 7. Multi-repository scheduling

Implemented:

- global Worker, repository, Agent-provider and Heavy Check quotas;
- CPU-load and memory admission;
- P0-P4 priority with Aging;
- persisted repository fairness;
- Portfolio DAG validation;
- stop or compensation Saga policy;
- repository-local failure isolation.

Evidence: `src/runtime/control-plane/global-scheduler/`, `src/runtime/workflow/portfolio/`.

## 8. Schedule architecture

Implemented first-class `Schedule`, `Trigger`, `Occurrence`, `Decision`, `ExecutionJob` and `Outcome` records.

Supported triggers:

- interval;
- manual;
- five-field UTC cron;
- calendar timestamp;
- condition watch;
- repository event;
- dependency checkpoint.

Safety controls include deterministic occurrence IDs, active-occurrence limit, daily budget, cooldown, exponential backoff, failure circuit breaker, stop conditions, default Shadow Mode, dirty-workspace suppression and release-freeze suppression. Automated discoveries become Candidate Findings; they cannot directly create Issue, Task, PRD or Plan.

## 9. State storage

- Business intent stays in repository files: `plans/`, `tasks/`, Issue records and architecture decisions.
- Runtime state stays under Controller Home by `repoId`.
- Evidence, Artifacts, events, receipts, indexes and projections are independently addressable.
- Writes are atomic; event records are append-only; large output is bounded or externalized as an Artifact.

## 10. 502 and latency controls

Implemented internal controls:

- no Agent, Check, command, integration, Workbench or release execution in the Gateway request lifetime;
- `controller_context` returns a materialized snapshot immediately and refreshes in a Worker;
- Local Bridge status and output use bounded snapshot readers without reconciliation or Git commands in Gateway;
- MCP session limit and idle collection;
- initialization, per-session and global POST backpressure;
- explicit 429/503 with retry guidance;
- aligned keep-alive, header and request timeouts;
- bounded logs and indexed history;
- split `/health`, `/ready` and repository health.

External tunnel, platform and physical-network failures remain outside the local process guarantee.

## 11. Verification and release

Implemented layered Evidence and an exclusive Release Gate. The gate checks workspace cleanliness, active Jobs/Runs/Edits/Integrations, Leases, required Tasks, exact-Revision verification, registry/remote/GitHub mapping, Daemon readiness and package metadata. Push, merge, tag, publish and production deployment remain separately authorized.

## 12. Agent control principles

- Controller plans and reviews; Workers execute bounded operations.
- Worker completion is not Task acceptance.
- Verification uses declared acceptance criteria and exact Revision evidence.
- Deterministic integration and release operations are program-owned.
- Automation may return `nothing_to_do`, Shadow decisions or Candidate Findings without manufacturing work.

## 13. Runtime directory migration

The new implementation is organized under:

```text
src/runtime/gateway/
src/runtime/control-plane/
src/runtime/workflow/
src/runtime/execution/
src/runtime/resources/
src/runtime/evidence/
src/runtime/projections/
src/runtime/release/
```

The former 4,700-line MCP implementation is retained as `legacy-tool-service.ts` for compatibility and invoked in Workers. `src/cli/mcp/tools.ts` is a thin facade.

## 14. Documentation governance

`docs/architecture/current/` is the only Runtime Authority. V4-V8 documents remain Historical Design. `plans/` remains a business-intent and implementation-plan catalog, not a runtime queue.

## 15. P0-P5 migration status

All migration phases have executable implementations:

- P0: request-lifetime execution removal and health isolation;
- P1: unified Job, receipts, indexes, evidence and recovery;
- P2: Repo Actor, Claims, Leases, Fencing and integration serialization;
- P3: fair multi-repository scheduling and Portfolio Saga;
- P4: bounded Schedule engine and Candidate Finding governance;
- P5: exact-Revision verification and release gate.

Detailed evidence: [`migration-roadmap.md`](migration-roadmap.md).

## 16. Standard execution flow

```text
Resolve Repository
-> read compact projection
-> classify work mode
-> select/create Issue and Task when required
-> declare Scope and Claims
-> persist requestId and ExecutionJob
-> return Job ID
-> Repo Actor schedules
-> Worker executes with heartbeat and Lease renewal
-> persist Receipt, events, Artifact and Evidence
-> reconcile terminal state
-> integrate serially
-> verify exact Revision
-> accept Task
-> evaluate dependency / release gate / stop
```

No Worker may bypass Scope, persistent Job ownership, Claims, Evidence or verification.
