# Implementation

This page maps the public Forge model to the current source tree. It is an implementation guide, not a substitute for the versioned architecture contracts.

## 1. MCP ingress and stable surface

Primary code:

```text
adapters/mcp/server.ts
adapters/mcp/toolset-names.ts
adapters/mcp/tool-mapping/repository-tools.ts
adapters/mcp/transports/http.ts
adapters/mcp/transports/session-registry.ts
adapters/mcp/runtime-gateway/
```

`toolset-names.ts` defines the bounded default connector surface. The six facade tools come from `src/runtime/control-plane/facade/types.ts`; repository, patch, check, Process, plugin-dispatch, and result tools bring the current default to 20.

The HTTP transport owns authentication and protocol-era routing. MCP 2026-07-28 is the canonical public path: `createMcpHandler` serves each modern request without `Mcp-Session-Id`. `McpSessionRegistry` is retained only for explicit 2025-era compatibility, where it owns session capacity, active-request protection, stream leases, replacement, and close accounting. Durable Work/Process/ControllerRound authority never comes from either transport form. Controller capability rotation and legacy-owner upgrades are Runtime recovery mechanics; ordinary model-facing Work operations neither expose nor require `controller_claim`. Legacy tool-surface mismatches still return a recoverable reinitialize response; modern requests resolve the current Runtime schema per request.

## 2. Repository registry and execution identity

Primary code:

```text
src/cli/repositories/registry.ts
src/cli/repositories/ephemeral-workspace.ts
src/runtime/control-plane/execution/execution-identity.ts
```

Registered work is resolved to `repoId` plus `checkoutId`. Git top-level/common-directory checks prevent a caller from supplying a different checkout through `cwd`. `ephemeral-workspace.ts` represents the separate explicit authority for an existing unregistered local directory. `src/cli/repositories/structured-git.ts` partitions porcelain status once; `src/runtime/projections/git-status-sampler.ts` uses that parser for its sampled projection rather than maintaining an independent classification.

## 3. Context and source access

Primary code:

```text
src/cli/controller/context-pack.ts
src/cli/repository/inspector.ts
src/runtime/repository/session-cache.ts
```

`rh_context` is the normal code-location/context router. Repository observations are bounded and cached by session/repository identity where valid. Clean Git snapshots avoid redundant `git diff --stat` subprocesses because `git status` already proves that no unstaged diff can exist.

Structural CodeGraph context is optional augmentation for call/dependency questions; it is not another mandatory top-level search abstraction.

## 4. Direct Edit

Primary code:

```text
src/cli/editing/edit-session.ts
adapters/mcp/tool-mapping/repository-tools.ts
```

A bounded patch can be applied directly to the selected checkout with file fingerprints, revisions, savepoints, change budgets, and focused verification. Direct Edit is the default for understood small work; a Plan or worktree is not a prerequisite.

## 5. Command policy and ephemeral workspaces

Primary code:

```text
src/cli/repositories/command-classifier.ts
src/cli/repositories/command-executor.ts
src/runtime/execution/process-runtime/command-facade.ts
```

The classifier distinguishes readonly, workspace write, remote write, and destructive behavior. Typed argv preserves argument boundaries without shell reparsing. Explicit unregistered workspaces can execute bounded local operations directly, but destructive commands still follow authorization policy.

The MCP result envelope distinguishes “not authorized/executed” from “process executed and failed.” A blocked `rm` therefore returns authorization-required state rather than a fabricated exit-code failure, and successful ephemeral mutations are not labeled as readonly.

`src/cli/commands/setup-execution.ts` is the single synchronous CLI setup/adoption owner for temporary process environment overlays and mapping bounded child-process results to setup steps. `init.ts`, `init-hook.ts`, and `global-runtime.ts` import this owner directly instead of maintaining their own `process.env` mutation and process-step wrappers. This setup convenience layer does not own Runtime or Work execution authority.

## 6. Unified Process Runtime

Primary code:

```text
src/runtime/execution/process-runtime/runtime.ts
src/runtime/execution/process-runtime/store.ts
src/runtime/execution/process-runtime/interactive-admission.ts
src/runtime/shared/process-identity.ts
adapters/mcp/runtime-gateway/process-tools.ts
```

`spawnManagedProcess` creates one Process record and one physical child execution. Exact PID/start-time/executable identity protects later lifecycle operations. Known-long processes can return handles immediately; short commands may complete during a bounded interactive window. Process startup captures command/start-time together and reuses the running-state persistence result instead of repeating store writes/reads on the hot path.

## 7. Resource claims, leases, and concurrency

Primary code:

```text
src/runtime/execution/process-runtime/resource-claims.ts
src/runtime/resources/claims/
src/runtime/resources/leases/
src/runtime/control-plane/repo-actor/
```

Claims describe the resource, not the conversation. Unrelated repositories and independent worktrees do not need a global lock. The same checkout remains a single-writer resource. Lease fencing prevents stale processes from continuing to mutate state after ownership changes.

## 8. Checks and reusable evidence

Primary code:

```text
src/runtime/execution/process-runtime/check-facade.ts
adapters/mcp/runtime-gateway/persisted-check-process.ts
src/runtime/evidence/
src/runtime/projections/
```

Equivalent checks can single-flight, coalesce subscribers, and reuse successful evidence when their content/environment contract matches. Invalidated revisions run physically again. Evidence and large result artifacts remain addressable without making hot status payloads unbounded.

## 9. Durable Work, scheduler, and isolation

Primary code:

```text
src/runtime/control-plane/facade/work-contract-store.ts
src/runtime/control-plane/repo-actor/
src/runtime/scheduler/
src/runtime/execution/workers/
src/runtime/control-plane/facade/goal-workloop.ts
```

Durable Work stores objectives, scope, checks, lifecycle, and evidence when the task actually needs recovery or a longer lifecycle. The scheduler controls global capacity; repository actors decide repository-local safety. Isolated worktrees and workers are mechanisms selected for concurrency/risk, not default ceremony for every code edit.

## 10. Canonical Runtime root

Primary code:

```text
src/runtime/root/
src/runtime/control-plane/persistence/sqlite-store.ts
src/runtime/root/write-fence.ts
```

The Runtime Root owns lifecycle and readiness. SQLite stores durable Controller facts, while release/write fencing ensures only the active whole-release authority can write Runtime-owned state.

## 11. Recovery and releases

Primary code and docs:

```text
src/runtime/root/release-store.ts
src/runtime/health/
docs/architecture/../architecture/CURRENT.md
docs/architecture/../architecture/CURRENT.md
```

The primary Runtime cannot be the only authority deciding its own recovery. Standalone Recovery observes the Runtime independently and may perform bounded whole-release restart/rollback only under its own evidence and lock contract.

## 12. Verification

Important regression suites include:

```text
tests/unit/fix-mcp-session-lifecycle.test.ts
tests/cli/mcp-runtime-proxy-routing.test.ts
tests/cli/repository-mcp-command.test.ts
tests/runtime/process-runtime.test.ts
scripts/benchmark-route-session-concurrency.ts
```

The route/session benchmark covers cold/warm context, Direct Edit claims, Process admission/start, check completion, cross-repository and cross-checkout concurrency, same-checkout contention, check coalescing/reuse/invalidation, and Runtime recovery reads. Correctness and latency are tracked separately: expected same-checkout contention is not a concurrency failure.

## Related pages

- [Architecture](Architecture)
- [Runtime Architecture](Runtime-Architecture)
- [Work Lifecycle](Work-Lifecycle)
- [Security Model](Security-Model)
- [Releases and Upgrades](Releases-and-Upgrades)
