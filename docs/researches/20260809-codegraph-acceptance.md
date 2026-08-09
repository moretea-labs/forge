# CodeGraph Acceptance — 2026-08-09

## Result

The repository has a real persisted CodeGraph index at `.codegraph/`; it is not a grep wrapper and it is not shared across Git worktrees. The main checkout was incrementally synchronized before the acceptance queries.

- CodeGraph: `1.0.1`, extraction version `24`, SQLite WAL backend.
- Main checkout after sync: 1,064 files, 22,889 nodes, 92,035 edges, zero pending changes.
- Incremental sync: 84 changed files (22 added, 62 modified), 2,883 parsed nodes in 2.4 seconds.
- Persistent index path: `/Users/greyson/DevProjects/forge/.codegraph`.

## Required structural queries

### `GlobalScheduler.tick` callers and callees

`codegraph callers "GlobalScheduler.tick"` resolved the production caller `GlobalScheduler.run` at `src/runtime/control-plane/global-scheduler/scheduler.ts:868` and the focused runtime-cleanup test. `codegraph callees` resolved 20 outbound relationships, including persistence, ExecutionJob reconciliation, repository enumeration, Git status sampling, Work admission, schedule/portfolio ticks, resource pressure, dispatch ranking, RepoActor claim, and latency tracing.

### `cleanupEditSession` callers

`codegraph callers cleanupEditSession` resolved the sole production mutation owner `applyRuntimeMaintenance` in `src/runtime/recovery/maintenance-executor.ts:721`, plus its containing file node. This matches the intended Recovery-only stale-session cleanup boundary.

### complete Runtime → Gateway → `controller_ready`

`codegraph node src/runtime/root/runtime.ts` and the targeted exploration resolved the complete startup route:

1. `CanonicalForgeRuntime.start` creates the MCP transport with `createRuntimeGatewayServer`.
2. The startup probe lists tools, requires `controller_ready`, and invokes it over the real MCP transport.
3. Gateway `callRuntimeTool` dispatches `controller_ready` to `controllerReadiness`.
4. `controllerReadiness` calls `controllerReadinessEvidence` and derives the single whole-Runtime decision from database, controller services, scheduler, workers, release/source coherence, and MCP evidence.

### plugin Store → external provider

The structural query resolved `submitAssistantPluginAction` → `executeAssistantPluginAction` → `resolvePluginAdapter` → `adapter.executeAction`. For an external registration, `createExternalPluginAdapter` supplies that adapter and reaches `callExternalUnixSocket`; the Store retains validation, authorization/confirmation, receipt, Work lineage, manifest sync, and event evidence around the external provider call.

## Independent worktree revision view

A temporary detached worktree at commit `7dea37164fcb1571e212c1a208984bb129ae3c90` was indexed independently while main was at `da2bd9175a184140df23c300eb293df002c5d0e5` with the current uncommitted mode slice visible only to main's index.

- Detached worktree index: 640 files, 14,776 nodes, 62,307 edges, zero pending changes.
- Its `GlobalScheduler.tick` caller query still resolved the production scheduler edge.
- Its query for `ExplicitTaskMode` returned no results.
- The main index returned `ExplicitTaskMode` and `parseExplicitTaskMode` from the current checkout.

The temporary worktree and its private `.codegraph/` database were removed through `git worktree remove`; no acceptance branch or worktree remains. Historical Forge-managed worktrees were not touched.

## Mode integration

Explicit Plan and Debug assessments require structural context. `controller_context` now invokes the existing bounded `buildControllerContextPack(... structuralContext: "required")` path and returns its CodeGraph metadata, entry points, related files, current raw snippets, and degraded status when the graph cannot satisfy the requirement. Direct work keeps structural lookup off by default.
