# Forge Runtime Implementation Status

> Status: **Runtime Authority**  
> Baseline: **Canonical Forge Runtime — 2026-08-06**

## Completion Statement

The **Canonical Single Runtime vertical slice** is implemented in executable code:

```text
forge-runtime
  -> MCP Transport
  -> Controller Services
  -> Scheduler and Repository Actors
  -> Process Runtime and Workers
  -> Evidence, Artifact, and Projection planes
```

One Runtime Root owns lifecycle, readiness, scheduling, process fencing, and the active whole-release identity. Standalone Recovery owns independent observation, bounded restart, and active/previous whole-release rollback. Supervisor, runtime slots, independent Daemon authority, component rollout, KeepAlive commands, and compatibility configuration authority are deleted.

## Capability Matrix

| Capability | Status | Runtime evidence |
| --- | --- | --- |
| Thin MCP Gateway | Implemented | `src/runtime/gateway/mcp/router.ts`, `src/cli/mcp/server.ts`, `src/cli/mcp/transports/http.ts` |
| Thin Harness V1 Fast Path | Implemented | `src/runtime/execution/thin-harness/` router, fast executor, receipts, typed batch, lightweight lanes; eligible short repository commands skip Local Job / ExecutionJob; docs in `thin-harness-v1.md` |
| Deterministic MCP transport lifecycle | Implemented | global `McpSessionRegistry`, stream leases, active-POST protection, capacity-aware `/ready`, and recoverable tool-surface fencing that keeps the stale transport alive until replacement initialize supersedes it |
| Unified Process Runtime | Implemented | `src/runtime/execution/process-runtime/`; repository commands and checks spawn once, return stable Process handles, preserve output/completion state, and attach later status/wait/log/cancel calls without re-execution |
| Independent daemon lifecycle | Deleted | `runtime-status-client.ts` is read-only observation over Canonical Forge Runtime state and cannot start, replace, recover, or fence Workers |
| Canonical Single Runtime | Implemented in source; live activation separately authorized | `src/runtime/root/` starts Controller Services, SQLite, Scheduler, Gateway Adapter, and MCP Transport under one lifecycle owner |
| Legacy Supervisor/Ingress/slot lifecycle | Deleted | Supervisor, Stable Ingress, slots, bootstrap authority, restart coordinator, component rollout/rollback, and repository lifecycle scripts are absent and guarded against reintroduction |
| Isolated Worker processes | Implemented | `src/runtime/execution/workers/worker-entry.ts`, Scheduler process spawning |
| Per-Repository Actor | Implemented | `src/runtime/control-plane/repo-actor/actor.ts`, actor registry and repository mailbox lock |
| Resource Claims | Implemented | `src/runtime/gateway/mcp/resource-policy.ts`, `resources/claims/conflicts.ts` |
| Renewable Leases and fencing tokens | Implemented | `src/runtime/resources/leases/store.ts` |
| Zombie Worker exclusion | Implemented | attempt/PID/exact-Lease ownership on heartbeat, renewal, release and terminal writes |
| Workspace single writer | Implemented | Workspace Claim conflicts and eligible automatic Worktree placement |
| Concurrent Worktrees with serialized integration | Implemented | unique Worktree Claims plus exclusive Integration/Git-ref Claims |
| Global fair scheduler | Implemented | priority aging, persisted repository fairness, global/repository quotas |
| Provider and host budgets | Implemented | Worker, Agent provider, Heavy Check, memory and CPU-load admission limits |
| Durable reconciliation | Implemented | heartbeat, deadline, Operation Receipt recovery, safe retry and ambiguous-mutation stop |
| Startup recovery before readiness | Implemented in Canonical Runtime | SQLite, Controller Services and in-process Scheduler initialize before MCP end-to-end probe; any fatal core failure makes the one Runtime readiness false and stops the complete Runtime |
| Canonical repository command input | Implemented | typed argv is validated and direct-spawned without shell reparsing; legacy strings use one explicit compatibility shell boundary |
| Active/recent/request indexes | Implemented | Execution Job, Agent Run, Task-to-Run, pending integration, Local Job, Occurrence, Portfolio and Finding indexes |
| Schedule, Trigger, Decision and Occurrence | Implemented | interval/manual/UTC cron/calendar/condition/event/dependency triggers, bounded Occurrence and persisted Decision |
| Schedule safety policy | Implemented | Shadow Mode, max-active, daily budget, cooldown, exponential backoff, failure circuit breaker and stop conditions |
| Candidate Finding governance | Implemented | semantic dedupe, evidence, observation count and explicit human promotion |
| Personal-assistant plugin manifests and registry | Implemented | `src/runtime/plugins/`, Controller Home `plugins/`, MCP and Local Controller discovery |
| Portfolio DAG and Saga | Implemented | dependency-cycle rejection, deterministic stop and compensation under `src/runtime/workflow/portfolio/` |
| Evidence Plane | Implemented | unified append-only events, exact-revision evidence, Operation Receipts and bounded Artifacts |
| Materialized projections | Implemented | dirty-marker invalidation, indexed runtime projections and non-blocking Controller Context refresh |
| Release Freeze and Gate | Implemented | exclusive `release:<repoId>` Lease and deterministic exact-revision release manifest |
| External side-effect authorization | Implemented | Gateway/Portfolio/Schedule/Worker defense-in-depth policy |
| Whole-Runtime readiness | Implemented in the Canonical Runtime source path | Public readiness is one `ready: boolean`; database, Scheduler, release coherence, MCP transport and repository checks are diagnostic evidence rather than independent lifecycle states |
| Legacy compatibility | Implemented | stable MCP facade, unchanged compatibility fingerprint, Local Job projection into Execution Job |
| Work-only execution contract convergence | Implemented for Work-backed Tasks | `WorkContract` owns objective/scope/check/risk/status/phase and completion receipt; linked Task fields are read projections, PlanStep retains `workId`, and receipt/revision/cleanup gates fail closed |
| Node/Bun process portability | Implemented | project TypeScript Loader and bounded Worker/child process execution; Bun remains the supported package/test runtime |

## Public Contract and Tool Surface

The normal ChatGPT-facing MCP surface is a bounded **19-tool** schema. The five preferred orchestration facades are `rh_status`, `rh_access`, `rh_inbox`, `rh_context`, and `rh_work`. Repository selection, `repository_command_execute`, bounded source read/patch, focused checks, typed plugin dispatch, Process lifecycle, and bounded result access complete the default surface defined by `src/cli/mcp/toolset-names.ts`.

The Runtime keeps internal atomic handlers and an exhaustive `full` compatibility profile without advertising them to ordinary ChatGPT discovery. `core` remains a compatibility label for the same bounded default surface. Request/Full Access changes execution authorization, not tool discovery.

Small understood work is Direct-first. Repository commands and checks use Unified Process Runtime and return one stable Process lifecycle; known-long calls can return a handle immediately, while later `process_get`, `process_wait`, `process_logs`, and `process_cancel` attach to that same physical execution. Durable Work, isolated worktrees, or workers are introduced when recovery, dependency tracking, isolation, parallelism, or a longer lifecycle actually requires them.

Tool names and input schemas are fingerprinted. A stale MCP session receives `MCP_TOOL_SURFACE_CHANGED` with a reinitialize instruction while its transport remains available for the host to observe the reset. Replacement initialize then supersedes and closes the old session; schema rotation must not unregister the Forge namespace from the host conversation.

Capability descriptors identify domain group, operation class, risk, facade route, and schema source. Plugin completeness is separate from the core Runtime baseline: optional plugin health does not redefine repository execution or Runtime readiness unless the requested operation explicitly depends on that plugin.

## Runtime Truth

Controller Home owns runtime state:

```text
repositories/<repoId>/
  execution-jobs/
  plugins/
  leases/
  schedules/
    records/
    occurrences/
    decisions/
    indexes/
  findings/
  artifacts/
  evidence/
  events/
  projections/
  runs/
  edit-sessions/

indexes/execution-jobs/
scheduler/state.json
portfolio/workflows/
```

Repository files under `plans/`, `tasks/` and Issue storage remain business intent and audit material. They are not scanned as a hot execution queue.

## Compatibility Boundary

The following remain supported:

- original Issue and Task lifecycle;
- Task/Run separation and retry history;
- Direct Edit sessions;
- Local Bridge API and UI;
- repository registry and GitHub mapping;
- Agent Run and Worktree integration records;
- legacy MCP schemas and stored-state readers;
- historical plans and architecture documents for audit.

`src/cli/mcp/tools.ts` is now a thin stable facade. `legacy-tool-service.ts` contains compatibility implementations invoked inside isolated Workers when work is durable. No product capability was removed to reduce source size or latency.

## Validation Authority

Completion is guarded by:

- strict TypeScript checking across `src`, `scripts` and `tests`;
- architecture invariant checks;
- MCP compatibility fingerprint checks;
- recovery, fencing and ambiguous-side-effect smoke tests;
- Schedule trigger/Decision/backoff smoke tests;
- Scheduler → Repo Actor → isolated Worker → Evidence process smoke;
- HTTP Gateway `/health`, `/ready` and repository-health smoke;
- package and source-manifest verification.

Release readiness requires Bun-native tests, TypeScript checking, MCP surface checks, public-document validation, tracked-file hygiene, and package export verification in the release environment.
