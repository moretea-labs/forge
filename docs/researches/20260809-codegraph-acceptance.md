# CodeGraph Acceptance — 2026-08-09

## Result

The repository has a real persisted CodeGraph index at `.codegraph/`; it is not a grep wrapper and it is not shared across Git worktrees. The main checkout was incrementally synchronized before the acceptance queries.

- CodeGraph: `1.0.1`, extraction version `24`, SQLite WAL backend.
- Main checkout after the final full rebuild and incremental sync: 1,064 files, 22,895 nodes, 93,284 edges, zero Git-visible pending changes.
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

## Immutable Runtime acceptance

The first live activation of the mode slice exposed a real packaging fault: the compiled Runtime could resolve neither `@colbymchenry/codegraph-darwin-arm64` nor its library from the immutable release. Release `1786280473908-e2183a517d3a66c7d39fc159c32e33ea512d0b17` corrected that boundary by carrying the matching CodeGraph Node executable, read-only sidecar, and complete compiled library tree with independent SHA-256 identities.

The live query then exposed a separate CodeGraph 1.0.1 consistency issue: the SDK indexes nested repositories below ignored `_ops/` paths but reports those same paths, plus local `.repo-harness/` browser state, as perpetual change drift during read-only scans. Forge now treats only Git-visible paths as index staleness. The ignored entries remain explicit as `ignoredChangedFileCount`; graph-selected files still pass through Forge path policy before raw source can be returned. A forced rebuild followed by incremental sync left 50 ignored operational entries, zero visible added/modified/removed files, and a `ready` provider result.

Code-bearing acceptance Runtime release `1786280892083-68df28b833316ef9a977df7ebee2d058fec071d6` passed whole-Runtime Recovery verification with release authority revision 58, 123 tools, and tool fingerprint `5c9b35942d343362e752a3e41bf249c7d8e1c1c0e1bedea44e193c3cb3cb50be`. Its CodeGraph artifact identities are:

- Node: `sha256:1ee75375e33b94fc34b3b19aede049e11dae90efb63b374dc96d6bdace70c4b8`
- sidecar: `sha256:8ffc75690e645d943ecb941830237929f8f46844d1f3768666a766fad347e38d`
- library: `sha256:27800e55dc8834d44f36fcaddc45e40602fda0e08f1a6fa3c6b01771e26b3351`

One authenticated local MCP session exercised all required routing cases against that release:

- default and small tasks: `direct_edit` / `direct` / `execute`, with structural lookup off;
- large task: `bounded_work` / `bounded` / `execute`;
- explicit Plan: `bounded_work` / `plan` / `plan_only`, CodeGraph `ready`, required context satisfied, 8 entry points and 8 related files;
- explicit Debug: `bounded_work` / `debug` / `diagnose_first`, CodeGraph `ready`, required context satisfied, 8 entry points and 10 related files.
