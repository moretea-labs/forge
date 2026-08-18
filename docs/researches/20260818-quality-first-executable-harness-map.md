# Quality-first executable harness: current-HEAD architecture map

Date: 2026-08-18  
Source HEAD: `8540e85583498ef6a21215788b549db48e28fab7`  
Scope: context retrieval, routing, repository command execution, recovery coupling, mutable authorities, and large-file decomposition

This map records current source facts before the quality/performance refactor. It deliberately separates facts, decisions, and unknowns. Repository source and focused measurements are authoritative; the older `tasks/current.md` projection is useful history but is stale for this slice.

## 1. Context retrieval path

### Current facts

`rh_context.search` and the compatibility `controller_context_pack` both call `buildControllerContextPack` in `src/cli/controller/context-pack.ts` through handlers embedded in `src/runtime/gateway/mcp/runtime-tools.ts`.

The first pack already fans in several evidence kinds:

- current Git snapshot;
- explicit known files/directories;
- one multi-query lexical repository scan;
- optional CodeGraph context plus dependency/dependent queries;
- current raw source ranges;
- task checks and bounded impact/coverage hints.

The lexical retriever reads every candidate file at most once for all terms. A short-lived inventory cache avoids repeated Git/file enumeration, and `src/cli/repository/session-cache.ts` already provides repository/session-scoped search, range, Git, and check caches.

However, the Context Pack does not pass MCP session identity to `gitSnapshot`, `searchRepositoryMany`, or `readRepositoryRange`. Batch search also has no session-cache binding. Consequently repeated `rh_context` expansion does not reuse the existing per-session search/range cache.

Materialization remains line-window first: each hit uses 12 lines before and 28 after. CodeGraph returns symbol line ranges, but the pack keeps only the start line and still materializes the fixed window. Small files are not intentionally returned whole, and a long matched function can be cut arbitrarily.

Exact known paths sort ahead of inferred candidates, but all files share one global snippet counter. A caller can therefore select an exact file that receives no snippet after earlier exact files consume `max_snippets`; the omission is recorded but the path has no reserved materialization budget.

Coverage is partially present in `search`, `structuralContext`, `impactContext`, `omitted`, and `contextContract`. It does not expose one explicit inspected/uninspected/cache summary suitable for progressive follow-up decisions.

The public `rh_context` definition still says to use one bounded call before shell exploration, and implementation notes discourage further reads unless evidence is mechanically incomplete. This conflicts with controller-owned semantic sufficiency.

CodeGraph is read-only and reports `stale` when its engine or changed-file list is stale. Current raw reads remain policy checked. Repository-baseline mode overlays dirty checkout paths, while current-checkout changed files are added as candidates from provider metadata. Structural queries remain synchronous sidecar processes and their results are not cached by the Context Pack session.

### Refactor decision

Keep `rh_context` as the primary retrieval surface, but make repeat expansion explicitly valid and cheap. Reuse the existing session cache rather than introducing a durable context state machine. Add symbol-aware materialization and a single coverage/cache projection. Treat stale graph relationships as hints and current source as authority.

## 2. Work/Plan routing path

### Current facts

`src/runtime/control-plane/routing/route-policy.ts` computes `complex` and routes to `goal_workloop`/`bounded_work` when any of several conditions hold. Besides explicit continuity, recovery, isolation, or independent-deliverable needs, the current predicate still includes:

```text
mutation && (expectedFiles > 4 || expectedChangedLines > 200)
```

`requiresInvestigation` is recorded as a reason but is no longer itself a durable trigger. `requiresLongRunningChecks`, recovery, isolation, dependencies, protected paths, and external effects still select durable routing.

Plan and Work scopes carry predicted/allowed paths through multiple projections. Current context retrieval may use task `allowedPaths` as search include globs when a task is explicitly selected, so a pre-investigation contract can narrow discovery.

### Refactor decision

Remove file/line-count complexity as a durable admission criterion. Direct Control may perform repeated retrieval and focused checks. Keep Work for continuity, scheduling, genuinely long asynchronous operations, independent deliverables, explicit resumability, and multi-controller coordination. Model initial likely, inspected, and actual changed scope separately; allowed paths remain an authorization boundary only when policy explicitly declares one, not semantic truth.

## 3. Repository command execution lanes

### Current facts

`src/runtime/execution/process-runtime/command-facade.ts` already exposes conceptual `process_direct`, `process_managed`, and `durable` routes:

- short read-only argv commands use the non-persistent repository executor;
- non-Git ephemeral workspaces can use bounded direct execution;
- build/test and ordinary workspace mutations call `spawnManagedProcess`;
- selected release/remote commands return `durable` for external Controller handling.

The read-only fast path has zero ExecutionJob/LocalJob/Worker/projection side effects. The managed path still creates a Process record, scopes resource claims, acquires Process Runtime leases, persists bounded logs/terminal state, and participates in Process restart reconciliation. Thus most ordinary tests/builds/writes still pay managed persistence and lease costs even when the command completes interactively.

`run_check` similarly uses Process Runtime for ordinary checks and reserves Durable for release/migration-style checks. Existing code and tests already assert no ExecutionJob/LocalJob/Worker side effects, so the obsolete Job layer is not the main remaining fixed cost.

Remote/destructive classification is conservative. A shared idempotent-retry helper refuses non-idempotent retries by default, but the final command-facing `outcome_unknown` contract and explicit no-replay evidence still need end-to-end verification.

### Refactor decision

Reuse the authorized direct repository executor for bounded ordinary local writes, Git operations, builds, tests, typechecks, and scripts. Upgrade to Lightweight Managed only when the caller requests a handle or the command remains running beyond a small interactive budget. Keep full Durable semantics only at explicit remote/release/destructive workflow boundaries. Do not add another process authority.

## 4. Runtime recovery versus command recovery

### Current facts

Canonical Runtime ownership, whole-release activation/rollback, standalone recovery, readiness, and restart live under `src/runtime/root`, `src/runtime/standalone-recovery`, and `src/runtime/recovery`. These mechanisms protect service availability and compatible whole-Runtime releases.

Process Runtime separately persists process state, lease state, logs, exit receipts, terminal cleanup, and startup reconciliation. Because ordinary local builds/tests currently use Process Runtime, command recovery semantics are coupled to the Runtime restart path even when repository state is sufficient for controller reconciliation.

### Refactor decision

Retain single-owner Runtime/release recovery. Remove ordinary Ephemeral Exec from Process recovery membership. Lightweight Managed may preserve a PID/start identity and bounded logs with best-effort restart visibility; ambiguous external effects must return unknown outcome and never be replayed automatically.

## 5. Mutable authority inventory

### Current facts

The relevant mutable authorities/projections include:

| Concern | Current source | Current role |
|---|---|---|
| repository contents and branch | Git/worktree | source and integration truth |
| direct edit batch | Edit Session | patch revision, savepoints, validation receipts |
| durable workflow | WorkContract | durable objective/scope/controller lifecycle |
| live work access | WorkHandle | session-scoped execution capability |
| command lifecycle | Process record + active index | PID, logs, terminal state, recovery membership |
| resource exclusion | Lease store | scoped write/check concurrency and fencing |
| validation | check receipts + Work verification snapshot | evidence and exact revision/scope binding |
| controller checkout view | session/checkout projections | routing/read model |
| complete Runtime release | release authority + known-good/backup evidence | whole-Runtime activation/rollback |

Several of these are valid authorities for different concerns, but WorkHandle, Work verification snapshots, completion receipts, checkout projections, and Process/Lease projections overlap enough that consumers must reconcile multiple mutable records. Exact redundancy and safe deletion points remain phase-5 unknowns until callers/tests are traced.

### Refactor decision

Use Git, Edit Session, Process handle, and validation result for ordinary coding. Instantiate Work only for real durable workflows and durable Process state only for explicit durable/external execution. Remove internal compatibility projections only after callers migrate and invariants have focused tests.

## 6. Largest source files at baseline

Measured with `wc -l` on current HEAD:

| File | Lines | Primary decomposition direction |
|---|---:|---|
| `src/runtime/gateway/mcp/runtime-tools.ts` | 6,621 | definitions, context, work, status, plugin/workflow/repository handlers, response shaping |
| `src/cli/mcp/legacy-tool-service.ts` | 5,520 | compatibility groups; remove retired handlers before splitting retained ones |
| `src/runtime/plugins/browser-adapter.ts` | 3,726 | manifest/session/action/navigation/media concerns, only with sibling/browser regression evidence |
| `src/cli/local-bridge/server.ts` | 3,238 | HTTP routes by product area |
| `src/runtime/standalone-recovery/core.ts` | 2,472 | verification, restart, activation, rollback, known-good/audit |
| `src/runtime/gateway/mcp/execution-tools.ts` | 2,234 | session/work lifecycle, execute, validate, finalize, result handlers |
| `src/runtime/execution/process-runtime/runtime.ts` | 1,848 | spawn, monitor, handle/log access, persistence, recovery/leases |
| `src/runtime/control-plane/facade/goal-workloop.ts` | 1,504 | domain transitions, persistence, verification/delivery projections |
| `src/runtime/control-plane/facade/work-contract-store.ts` | 1,147 | domain validation, persistence, read models |
| `src/cli/repositories/command-executor.ts` | 1,066 | authorization/classification, spawn/output, repository snapshot |
| `src/cli/controller/context-pack.ts` | 908 | planning, retrieval, ranking, materialization, coverage/response |

The decomposition goal is lower coupling and independent testability, not line-count-only movement. New core modules should generally stay within 200–500 lines; any file remaining above 700–800 lines needs a cohesive reason.

## 7. Baseline performance and evidence gaps

Current instrumentation covers Git snapshot cache hits, session-cache hit/miss/bytes/scan avoidance, MCP phase timings, Process durable side-effect counts, and route/session concurrency. The existing benchmark emphasizes concurrency, registration, and check reuse rather than cold/hot `rh_context` expansion or direct-versus-managed ordinary command overhead.

Required new measurements:

- cold broad Context Pack latency and scanned files;
- hot follow-up Context Pack latency, cache hits, bytes/scans avoided;
- symbol versus fallback materialization counts;
- ordinary command harness overhead excluding child duration;
- managed-handle admission overhead;
- durable external boundary behavior;
- before/after largest-file counts.

## 8. Candidate compatibility/dead layers

These are candidates, not yet deletion decisions:

- compatibility-only `controller_context_pack` behavior once `rh_context` owns the progressive contract;
- legacy tool registrations in `src/cli/mcp/legacy-tool-service.ts` with no supported caller;
- Work/checkout/verification projections that duplicate authoritative Git/Edit/Process evidence;
- Process restart records for command classes moved to Ephemeral Exec;
- obsolete routing fields whose only effect is expected-size admission.

Each candidate requires caller search, current MCP schema evidence, migration decision, and focused regression coverage before removal.

## 9. Ordered implementation

1. Correct context instructions, reserve exact-known materialization, expose explicit coverage/cache evidence, and wire session identity.
2. Split Context Pack responsibilities, add symbol-aware small-file/function/type materialization, cache CodeGraph/follow-up work, and improve changed-file/relevance overlays.
3. Make Ephemeral Exec the ordinary local default; retain lightweight handles for long commands and explicit Durable external effects.
4. Remove size-based Work/Plan admission and separate predicted, inspected, and changed scope.
5. Trace and reduce duplicate mutable authorities/compatibility projections.
6. Decompose the largest mixed-responsibility files, beginning with modules changed by phases 1–5 and preserving browser/device behavior.
7. Run a fresh requirement/changed-symbol impact pass, focused gates, required Forge checks, latency benchmarks, and line-count comparison.
