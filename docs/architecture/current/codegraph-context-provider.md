# CodeGraph Context Provider

Status: reviewed for Phase 1 implementation  
Source baseline: `a49465096c4e2532da37ab2f9d10dca2238217ac`  
Scope: Controller Context Plane only

## Problem

Forge already installs and diagnoses `@colbymchenry/codegraph`, and the repository already has a local `.codegraph/codegraph.db`. However, ChatGPT/Controller planning still relies on token search plus bounded raw file reads. CodeGraph is not available as a policy-bounded Controller read capability, so `-plan` and `-debug` cannot use symbol, call-graph, dependency, or impact data directly.

The missing capability is not another top-level MCP tool. It is a Context Plane provider that can add structural evidence to the existing `rh_context` / `controller_context_pack` path.

## Constraints

1. The default workflow remains unchanged. No explicit mode directive still uses the existing automatic Direct-first routing.
2. `-plan`, `-debug`, and `-campaign` are opt-in routing instructions. CodeGraph must not add latency to ordinary Direct edits by default.
3. Forge continues to support Node.js `>=20.10.0`.
4. CodeGraph's embedded SDK requires Node.js `>=22.5` to open its SQLite database through `node:sqlite`.
5. CodeGraph's CLI/MCP server uses its own bundled runtime and may auto-sync the index. Planning must not silently mutate source files or silently refresh derived indexes.
6. Source reads remain governed by the existing repository/path policy. A graph hit is discovery evidence, not permission to read a denied path.
7. The existing five facade tools remain the preferred host surface. Do not add a `codegraph_*` top-level Forge tool family.
8. If CodeGraph is absent, stale, incompatible, or unavailable, Context Pack must fail open to the existing bounded text search when structural context is optional, and fail clearly when structural context was explicitly required.

## Decision

Add a `CodeGraphReadProvider` to the Context Plane, backed by a self-contained CodeGraph sidecar running on CodeGraph's bundled Node runtime.

The Forge Controller process never imports and opens CodeGraph directly on Node 20. Instead it launches a small packaged sidecar with the matching platform bundle runtime and communicates through a bounded JSON protocol.

The sidecar opens CodeGraph with:

```text
CodeGraph.open(projectRoot, { sync: false, readOnly: true })
```

It never calls:

- `init` / `initSync`
- `indexAll` / `indexFiles`
- `sync`
- `watch`
- `optimize`
- `clear`
- `uninitialize`

This keeps structural planning read-only with respect to both the repository and the derived CodeGraph index.

## Runtime layout

```text
ChatGPT
  -> rh_context / controller_context_pack
  -> Context Pack builder
       -> bounded text search + raw repository reads
       -> CodeGraphReadProvider (only when requested)
            -> CodeGraph sidecar
                 -> bundled CodeGraph Node runtime
                 -> CodeGraph.open(... readOnly=true, sync=false)
                 -> .codegraph/codegraph.db
```

The sidecar is a provider implementation detail. It is not a second Forge Runtime and does not own Controller state, Work, scheduling, repository mutation, or recovery.

## Provider contract

Phase 1 provider operations:

- `status`
  - initialized
  - provider/runtime availability
  - index last indexed time
  - index build version/extraction version
  - stale-engine signal
  - changed-file signal from CodeGraph when available
- `search`
  - symbol/name search
  - bounded node metadata only
- `context`
  - task/query relevant subgraph via CodeGraph structural context
  - bounded nodes and edges
- `impact`
  - impact radius from a resolved node
- `file_dependencies`
  - dependencies and dependents for explicit files

Later operations may add callers/callees/usages and affected-test calculation, but Phase 1 should not expand before the Context Pack integration is proven useful.

Every request includes the canonical repository root chosen by Repository Registry. The sidecar must reject attempts to substitute an arbitrary root after startup.

## Context Pack integration

Extend `ControllerContextPackOptions` with a structural context policy:

```text
structuralContext = off | auto | required
```

Default is `off` to preserve current Direct performance and behavior.

Expected mode usage:

- ordinary Direct: `off`
- explicit `-debug`: `auto`
- explicit `-plan`: `required` when a CodeGraph index is present; otherwise return a clear degraded-plan warning and use bounded text search
- Campaign planning/review: `auto` or `required` depending on the campaign contract

When enabled, graph results augment candidate ranking. They do not replace raw source reads. Important files selected through CodeGraph still pass through `resolveMcpPath` and `readRepositoryRange` before implementation.

Context Pack gains a bounded `structuralContext` section containing:

- provider: `codegraph`
- requested mode
- status: `ready | unavailable | stale | degraded`
- index freshness/build metadata
- query terms used
- selected structural entry points
- related/impact file paths
- graph truncation metadata
- fallback reason when graph data was not used

Candidate reasons should distinguish graph evidence, for example:

- `codegraph:search:<symbol>`
- `codegraph:context`
- `codegraph:impact:<node-id>`
- `codegraph:dependent:<path>`

## Freshness policy

Read-only planning never auto-syncs CodeGraph.

If the provider reports changed files, stale extraction, or an index built by an older extraction engine:

1. mark structural context stale/degraded;
2. do not silently run `sync` or `index`;
3. use direct repository reads for affected files;
4. optionally recommend an explicit CodeGraph refresh action outside the read-only planning step.

A later typed maintenance action may perform refresh. That action is separate from planning and may write only derived `.codegraph` state, never source files.

## Packaging and platform behavior

The provider locates the matching optional platform package:

```text
@colbymchenry/codegraph-<platform>-<arch>
```

and uses its bundled `node` / `node.exe` to launch the packaged sidecar.

If the platform package is missing, provider status is `unavailable` with remediation to reinstall CodeGraph with optional dependencies enabled. Forge must remain usable without CodeGraph.

The sidecar code ships inside Forge's existing published `src/` or `scripts/` package surface; no new external service or daemon is required for Phase 1.

## Security and policy

- Structural queries are repository-scoped and read-only.
- Sidecar stdin accepts typed JSON requests, not shell commands.
- Sidecar output is bounded before returning to the host.
- Telemetry is disabled for provider subprocesses (`CODEGRAPH_TELEMETRY=0`, `DO_NOT_TRACK=1`).
- No network capability is required.
- No arbitrary executable path is accepted from the user.
- No arbitrary repository root is accepted from the user after Controller selection.
- Graph-selected paths are rechecked through Forge read policy before raw code is returned.
- Errors return bounded diagnostics and never dump database contents.

## Performance policy

Phase 1 uses an on-demand sidecar request path and records timing for:

- process startup
- CodeGraph open
- graph query
- Context Pack merge

Do not introduce a persistent sidecar pool until measurements show startup/open dominates p95 planning latency. If pooling is later justified, use bounded per-repository LRU instances with explicit close/eviction and no file watcher.

This avoids adding a new always-running process before benchmark evidence exists.

## Phase 1 implementation steps

1. Add the read-only sidecar and host provider with availability/freshness reporting.
2. Add unit tests proving no mutation operations are exposed by the provider protocol.
3. Add `structural_context` to `controller_context_pack`; default remains `off`.
4. Merge CodeGraph structural candidates with existing text-search candidates while retaining policy checks and raw snippets.
5. Update `SKILL.md` so explicit `-plan` requests structural context and explicit `-debug` prefers it when available. Do not change automatic Direct routing.
6. Add focused tests for unavailable provider fallback, stale-index warnings, graph candidate ranking, denied-path rechecks, and output bounds.
7. Run a live Forge CodeGraph query and record evidence before declaring CodeGraph integration ready.

## Acceptance criteria

Phase 1 is accepted only when all of the following are true:

- Node.js 20.10 remains the public Forge baseline.
- Default Direct workflow and Route Policy are unchanged.
- `controller_context_pack` with no structural option performs no CodeGraph process work.
- `structural_context=auto` degrades cleanly when CodeGraph is unavailable.
- `structural_context=required` reports a clear blocker/degraded state instead of silently pretending structural evidence exists.
- Sidecar opens the index read-only with sync disabled.
- A query cannot invoke CodeGraph mutation APIs.
- CodeGraph-selected files still obey Forge path policy before raw source is returned.
- Context Pack output remains bounded.
- Typecheck and targeted Context Pack/provider tests pass.
- A real query against Forge's `.codegraph` index returns structural evidence.
- No second Forge Runtime, rollout slot, or hidden managed browser/process authority is introduced.

## Architecture review

Review result: approved for Phase 1.

Reasons:

- Reuses the existing Context Plane instead of widening the top-level tool surface.
- Preserves the Node 20 public contract by isolating the SDK runtime requirement.
- Separates derived-index maintenance from read-only planning.
- Keeps Direct fast by making structural context opt-in.
- Preserves Forge path policy as the final authority for raw code access.
- Provides a measurable migration path: on-demand sidecar first, pooling only after benchmark evidence.

Rejected alternatives:

1. Import CodeGraph directly into Controller: rejected because it raises the effective Node runtime requirement to 22.5+.
2. Use `codegraph serve --mcp` directly for Plan reads: rejected for Phase 1 because its normal lifecycle includes connect-time catch-up and watcher/auto-sync behavior, which blurs the read-only planning boundary.
3. Add new Forge top-level `codegraph_*` MCP tools: rejected because the existing five-facade architecture should remain the preferred host surface.
4. Parse CodeGraph CLI human-readable output: rejected because the SDK provides a typed API and CLI text is a weaker protocol contract.
5. Auto-sync before every Plan: rejected because derived-state mutation must be explicit and should not inflate planning latency without evidence.
