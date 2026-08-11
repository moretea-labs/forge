# Forge residual runtime / execution issues (2026-08-11)

> **Status**: Closed baseline record; historical sections below are retained only as evidence.
> **Purpose**: Single repository-readable handoff for future ChatGPT / repo-harness sessions. Read this before opening new performance/runtime work so already-fixed items are not rediscovered.
> **Scope**: Runtime/MCP execution latency, false serialization, tool-surface coherence, Desktop Operator hot paths, and operational baseline state found during the 2026-08-10/11 optimization sessions.
> **Authority note**: This is a source-tree issue ledger, not permission to activate/roll out a Runtime release. The user explicitly requires **no Runtime rollout**; stage/verify inactive candidates only unless that constraint is changed.

## Final closeout (2026-08-11)

- Live Registry identity is correct and stable: `repo_123b7cf58b6b17b5cbe46a56` maps to canonical root `/Users/greyson/DevProjects/forge`, canonical remote `github.com/moretea-labs/matea`, and GitHub routing `moretea-labs/matea`. Forge is the product/package name; `matea` is the GitHub repository and historical source name. No registry remap is needed.
- The deployed Runtime is healthy with the bounded 19-tool default surface. The Recovery watchdog has zero counted Runtime restarts/failures and no rollback or recovery exhaustion. Historical single-tick degraded audit entries lacked failed-probe provenance; source now persists a bounded (32), deduplicated probe record with component attribution before recording the audit event, without changing the existing recovery budget.
- Typed readonly claim coverage and the real multi-repository/different-checkout acceptance show no source/Git false serialization. Ambiguous shell, Python, and Node commands remain conservative by design.
- Normal Direct completion is reconciled to its exact commit receipt; maintenance only candidates interrupted or unresolved sessions and never auto-removes unique uncommitted changes. This was verified by the existing lifecycle tests and maintenance audit, not replaced with a new cleanup owner.
- The normal Process create/terminal path now maintains its active recovery index incrementally. Full rebuild remains the corruption/recovery fallback, so historical Process volume no longer imposes a normal-path directory scan.
- The self-host source repository intentionally has no tracked `.ai/harness/workflow-contract.json`; the package asset is authoritative and downstream adoption generates the runtime copy. The strict checker therefore reports only the documented bootstrap advisory, not a missing source contract.
- Test-line budget remains `42200`; redundant runner/environment tests were removed rather than raising the limit. The replacement recovery-index and watchdog diagnostic coverage keeps the manifest within budget.

Do not reopen a historical item below without new reproduction evidence. No Runtime rollout is implied by this source closeout.

## Current baseline snapshot

- Repository: `repo_123b7cf58b6b17b5cbe46a56` (`/Users/greyson/DevProjects/forge`).
- The in-progress single-`ps` change was started from source around `1d04859b`; while this ledger was being written, `main` advanced concurrently to `088864ba` (`docs(lessons): scope restart budgets to releases`). Re-read/review the three dirty single-`ps` files against current `main` before committing them.
- Active Runtime is still release `1786407449264-6e0dd52179b3104ca24ff9b1ecf952c8fc344344`; active MCP reports **19/19** tools.
- Inactive candidate `1786419530424-1d04859bdee73f6e4d3aad43c875d09007b3d0fa` was successfully staged and validated only; it was **not published or activated**.
- Desktop Operator external registration is live at revision **11**. Stable provider health at last check: `ready`, Accessibility=`true`, Screen Recording=`true`, activeSessionCount=`0`.
- Unrelated local state must not be swept into commits: `auth/` is untracked.

## P0 — Client/server MCP tool-surface coherence is still broken on the active Runtime

**Status:** fixed/strengthened in source candidate; active Runtime still reproduces the problem.

### Evidence

- Active server truth is 19/19 tools.
- ChatGPT connector discovery in existing sessions still advertises hidden/legacy atomics such as `list_issues`, `get_project_board`, `search_repository`, etc.; calling them returns `TOOL_NOT_FOUND`.
- Conversely, server-supported process lifecycle tools have intermittently been missing from client discovery.
- This causes wasted tool-selection round trips and pushes other sessions toward shell fallbacks.

### Relevant source work

- `c1b44e8b fix(mcp): fence sessions by tool surface`
- `ef217778 feat(mcp): expose bounded typed plugin execution`
- Source default surface is now intended to be **20 tools**, adding only `plugin_action_execute`; plugin action schemas are loaded through `rh_context(capability_id=plugin.<plugin>.<action>)`.

### Acceptance

1. A newly connected ChatGPT session sees exactly the server-advertised bounded surface.
2. Existing session/tool-list change handling cannot invoke tools absent from current server fingerprint.
3. Server-supported bounded process/plugin tools are discoverable without reconnect hacks.
4. No `TOOL_NOT_FOUND` caused solely by stale client schema during normal session lifetime.

## P0 — Legacy shell/localbridge plugin operations still acquire false repository write locks

**Status:** partially fixed in source; still reproduced on active Runtime and old call paths.

### Evidence

Observed host/localbridge requests such as:

- `bash -lc -> osascript -> Chrome/Vivaldi`
- `bash -lc -> bun -e -> submitAssistantPluginAction(...)`
- `bash -lc -> curl localhost local-bridge -> Gmail/plugin self-test`

have acquired combinations of:

- `workspace:<checkout> write`
- `git-index:<checkout> exclusive`
- `git-refs:<repo> exclusive`

even though they do not mutate Forge source/Git. These claims blocked unrelated source edits and benchmarks. One localbridge self-test also failed in its shell/curl/python plumbing, demonstrating that the fallback is both slower and more fragile than typed plugin execution.

### Relevant source work

- `84ecef84 perf(runtime): avoid false host-operation serialization`
  - respects single-quoted JS when detecting shell substitutions;
  - recognizes strict browser AppleScript wrappers as host/browser operations.
- `ef217778` provides the intended typed plugin dispatcher so Browser/Desktop/Gmail/etc. do not need repository-command shell wrappers.

### Acceptance

1. Normal Browser/Desktop/Gmail typed actions execute through plugin capability claims, not repo workspace/Git claims.
2. Host/localbridge diagnostics that do not touch repository state cannot block source writers.
3. Mixed/ambiguous shell remains fail-closed; do not teach the shell classifier arbitrary JavaScript semantics.

## P1 — Runtime authority fencing can still block ordinary source-tree writes

**Status:** reproduced on the active Runtime; root cause not yet isolated.

### Evidence

While persisting this ledger, a repository-scoped Python write request was admitted but failed with `PROCESS_LEASE_CONFLICT: runtime-authority@runtime-fence`. The same source checkout has also accepted normal direct/safe-patch writes at other times, so this is intermittent rather than a blanket policy.

### Direction / acceptance

1. Determine whether the blocker was a legitimate concurrent release/runtime authority transition or an over-broad fence applied to ordinary source writes.
2. Normal bounded repository edits must not be blocked by Runtime release authority unless they truly conflict with an active source/release transition.
3. Preserve fail-closed fencing for actual Runtime activation/release mutation; do not weaken release authority to improve latency.
4. Add a regression that distinguishes source-workspace claims from runtime-release authority claims.

## P1 — Process admission/start has ~60–90 ms fixed tax

**Status:** in progress; uncommitted single-`ps` optimization exists in the working tree and has correctness tests, but clean A/B benchmark is still required before commit.

### Baseline benchmark (7 iterations, isolated temp repositories)

- durable Process admission/persistence: **60.12 ms p50 / 62.10 ms p95**
- tiny Process start+complete: **89.95 ms p50 / 91.87 ms p95**
- simple Check completion: **101.41 ms p50**
- two-repository concurrency: successRate=1, contentionRate=0
- same-repository/different-checkout concurrency: successRate=1, contentionRate=0
- check coalescing, cross-checkout reuse, dirty invalidation: all succeeded

### Root cause under active investigation

`captureIdentity()` currently obtains process identity through OS process inspection. The old implementation synchronously spawned two `ps` processes per managed Process (`command` and `lstart`). The in-progress change adds one combined identity probe so the same fencing identity can be captured with one `ps`, retaining compatibility fallback for custom probes.

### Current validation of the uncommitted change

- `tests/runtime/process-runtime.test.ts`: **65/65 pass**
- `bun x tsc --noEmit`: pass
- Added regression verifies process identity matching prefers one combined probe.
- First post-change benchmark was contaminated/truncated by concurrent host/localbridge tests; do **not** claim a speedup until a clean same-machine A/B is recorded.

### Acceptance

1. Preserve `processStartTime`, executable fingerprint, PID/fencing semantics and recovery behavior.
2. Demonstrate a clean same-command 7x A/B with lower Process admission/start p50 without concurrency/correctness regression.
3. Commit only after benchmark evidence is trustworthy.

## P1 — Process active-index maintenance is O(N) in historical Process count

**Status:** confirmed design debt; not yet fixed.

### Evidence

- `createProcessRecord()` writes the record and calls `rebuildActiveIndex()`.
- `rebuildActiveIndex()` scans every Process JSON record under the repository Process root to discover active records.
- terminal completion can rebuild the index again.
- The real Forge Controller Home currently contains a very large historical Process population; therefore Process creation/completion cost can grow with history even when only a few processes are active.

### Direction

Replace normal create/terminal hot-path full-directory rebuilds with safe incremental index maintenance/CAS, while retaining full rebuild as corruption/recovery fallback. Do not introduce a second process authority.

### Acceptance

1. Normal Process create/terminal paths are O(1) or O(active) with respect to historical records.
2. Crash/corruption recovery can still rebuild from authoritative Process records.
3. Concurrency tests prove no lost active Process IDs.
4. Benchmark both fresh and history-heavy Controller Homes.

## P1 — External plugin live identity preflight was repeated on every action

**Status:** fixed in source; pending active Runtime adoption.

### Evidence / fix

- Active external adapter previously performed a provider `manifest` RPC before every action and could hit the exact `EXTERNAL_PLUGIN_TIMEOUT` at 2000 ms even when the provider socket itself was responsive.
- `285e3e0e perf(runtime): reuse fresh external provider validation` reuses a recently validated provider identity for a bounded 5-second window rather than repeating manifest RPC on every hot action.
- Focused external-adapter tests passed 17/17 when implemented.

### Acceptance

Validate after a future permitted Runtime activation that repeated Desktop/plugin actions no longer pay redundant manifest preflight while provider identity remains fail-closed on staleness/change.

## P1 — Fixed interactive wait should remain duration-aware

**Status:** source fix exists; verify after future active Runtime adoption.

Older behavior imposed fixed synchronous windows (roughly 800 ms for checks / 2 s for generic diagnostics) before returning a managed handle. Source commit `c1b44e8b` includes duration-aware Process admission logic so known long-running operations can return handles earlier while tiny predictable work remains direct.

### Acceptance

- history/policy-predicted long work returns a handle promptly;
- tiny work still completes inline where beneficial;
- unknown work gets only a short bounded probation;
- no return to retired ExecutionJob routing.

## P2 — Cold Git observation is the main remaining context-read cost

**Status:** measured; optimize only after Process fixed costs.

Baseline 7x benchmark:

- cold context read: **29.44 ms p50 / 39.17 ms p95**, almost entirely Git observation/projection;
- warm context read: **0.12 ms p50**.

Warm path is already effectively free. Prefer reducing how often cold observation is needed through precise invalidation/generation signals rather than adding another cache layer.

## P2 — Legacy macOS Automation permission cleanup is incomplete

**Status:** operational cleanup remaining; Desktop stable identity must be preserved.

- Accessibility legacy rows were disabled; stable `Forge Desktop Operator` remains enabled.
- Screen Recording legacy `bun`/`forge-runtime` rows were disabled; stable app remains enabled and screenshot still works.
- Automation contains historical `bootstrap`, `bun`, and multiple `forge-runtime` principals. Some visible children were audited/disabled, but not every collapsed historical `forge-runtime` group was safely scrolled/verified.
- Do not edit the TCC database and do not run `tccutil reset`. Preserve the stable signed app grant.

## Resolved / do not reopen without regression evidence

- Desktop socket server health no longer blocks behind a slow AX action (`ff650fd`).
- Desktop locks are scoped per session/UI/browser rather than one global action lock (`67e9e40`).
- AX traversal deduplicates cycles/self-links (`6d91310`).
- Focused Desktop observe skips per-node action names and CGWindow enumeration by default (`92b3820`): live Finder 355-node median improved from 98.45 ms to 87.17 ms (~13%); Chrome small subtree improved ~21%.
- Desktop coordinate fallback now fails closed on stale refs after activation (`305137e`); live Finder AXPress E2E passed.
- Desktop focused observe registration schema (`include_actions`, `include_windows`) is live at external registration revision 11 (`1d04859b`).
- Current multi-repository and same-repo/different-checkout Process concurrency benchmark shows 100% success with zero contention; concurrency architecture is not the current primary bottleneck.

## Historical recommended execution order

1. Finish clean A/B for the in-progress combined process-identity probe; commit only if evidence is positive.
2. Remove O(N) Process active-index rebuild from normal create/terminal hot path.
3. Re-run route/session benchmark and compare Process admission/start, concurrency, check reuse.
4. Only then optimize cold Git observation.
5. Separately verify tool-surface and typed-plugin fixes when Runtime activation is permitted; **do not rollout under the current user constraint**.
6. Continue macOS Automation cleanup only with selector-bound UI actions and readback; preserve stable Desktop Operator grants.

## Source history / context

Earlier baseline analysis documented the pre-optimization state (large tool surface, source-coherence/runtime-governance debt, incomplete concurrency/check-reuse validation). The later hourly optimization summary documented the transition to the 19-tool coherent active baseline and identified shell-wrapped plugin claims, schema-cache drift, fixed waits, Process startup, and cold Git observation as the residual latency set. This ledger supersedes those snapshots for future implementation work; use the older notes only as historical comparison.
