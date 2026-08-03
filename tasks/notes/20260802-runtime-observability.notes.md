# Implementation Notes: 20260802-runtime-observability

> **Status**: Implementation complete; exact-revision bootstrap verification pending
> **Scope**: Runtime health, supervisor probe classification, projection reconciliation, and MCP request diagnostics

## Decisions

- Readiness now exposes `externalEndpoint`, `mcpHandshake`, and `sessionContinuity` as graded observations. `unknown` remains visible without blocking readiness; an explicitly unhealthy external endpoint blocks the effective ready result. With no public endpoint env configured, `controller_ready` reports `unknown` and stays ready for local development.
- Supervisor gateway probe failures retain the existing thresholded recovery budget, while classifying deadline abort (`probe_timeout`), caller preemption abort (`probe_cancelled`), connection refusal, network error, invalid body, HTTP status, and unhealthy responses separately. A preempted probe is not health evidence: `supervisorGatewayHealthDecision(previous, healthy, cancelled=true)` leaves `consecutiveFailures` unchanged so the recovery budget is not consumed.
- `classifyFailure` maps probe timeout/abort messages to the `transient_probe_timeout` recovery class (in `dominantRecoveryClass` priority order).
- Projection health reconciles Task Ledger workflow progress with `runningWorkers` as repository-scoped diagnostic evidence only. Task `running` can span sequential Runs and is not proof of a live Worker; mismatches therefore surface as warnings and never block global readiness or release rollout. Durable Job, queue, Lease, current-attention, and projection-build evidence remain the execution readiness authorities.
- Controller MCP calls carry a trace/request/RPC identity through response metadata (`structuredContent.responseMeta`) and timing/incident audit records. Tool errors and exceptions emit incident records under the existing audit surface.

## Pre-bootstrap verification evidence

The following results were collected before the immutable-release closure and process-runner canary follow-up. They are useful regression evidence, but they do not constitute final verification of the current exact revision.

- `bun run check:type` (tsc) passed; new observation fields are optional, so all existing observation construction points compile unchanged.
- `bun run check:task` passed (typecheck, static architecture, test-governance manifest validation, affected gate).
- `bun run test` (affected gate) passed: 8 selected files, 0 failures.
- Explicit regression runs: `stable-supervisor-hardening`, `stable-supervisor-integration`, `standalone-recovery`, `capability-recovery` all green (103 tests). `control-plane-hardening`, `thin-harness-gateway-routing`, `runtime-cutover-r2`, `runtime-source-isolation`, `mcp-controller` green (99/100; one pre-existing timing-sensitive `verify_task` lease test flakes under concurrent 5-file load but passes in isolation 3/3).
- Full AGENTS.md required checks passed: check-deploy-sql-order, check-architecture-sync (advisory, 0 blocking), check-task-sync, check-task-workflow --strict, inspect-project-state, migrate dry-run, git diff --check.
- New unit coverage (tests/runtime/runtime-observability.test.ts, 11 tests): controller_ready env gating (unknown keeps ready; unhealthy env blocks with `PUBLIC_STABLE_ENDPOINT_UNHEALTHY`), deadline vs preemption probe classification with budget counting, blocking and non-blocking projection/ledger reconciliation (incl. `projectionBlocksReadiness` unchanged for non-blocking mismatch), trace identity across response metadata + timing/incident audit records, and ingress upstream-502 → `MCP_SESSION_MIGRATION_PENDING`.
- `tests/runtime/runtime-observability.test.ts` declared in `tests/test-manifest.v1.json` (module process-runtime, resource temp-isolated).

## Smoke governance (2026-08-02)

- Audit: all five runtime smoke scripts were green except `smoke:runtime-control-plane`, which had drifted after round-two (asserted the retired `event-driven` strategy instead of `event-driven-swr`) and used a 10s daemon-ready budget that cold starts under the node `--loader` runtime cannot meet (measured 14-20s; bun 2-4s). Nothing gated the smoke scripts, so the drift was invisible.
- Fixed `scripts/smoke-runtime-control-plane.ts`: daemon-ready budget 10s -> 30s with the loader warm-up rationale, and both `strategy` assertions aligned to `event-driven-swr`.
- Added `check:smoke` (package.json) aggregating the five smoke scripts, plus `smoke:schedule-engine` and `smoke:tool-surface` aliases; wired `{ label: 'runtime smoke', command: 'bun run check:smoke' }` into the `main` gate (`scripts/run-governed-gate.ts`). The earlier revision passed this gate end to end (~60s); the current exact revision must be rerun after bootstrap.

## Immutable release execution closure follow-up

- Supervisor releases are now assembled in a hidden staging directory and atomically renamed only after all seven declared entrypoints exist and are non-empty.
- The bundled `process-runner.js` must execute a real harmless child command and persist a successful receipt before staging, publishing, rollout, or rollback can proceed.
- `controller_ready` reports and blocks on an incomplete active release closure.
- Final evidence is intentionally pending because the currently active older release lacks `process-runner.js`, so governed checks cannot start until the repaired clean revision is committed and bootstrapped through the Supervisor.

## Compiled Supervisor bootstrap closure

- Bootstrap now selects `standalone-binary` releases without invoking Bun as a parent; legacy script releases retain the Bun fallback.
- Stable Supervisor and managed Daemon/Gateway children propagate the execution mode and invoke compiled entrypoints directly.
- Process Runner detects a compiled release manifest before spawning the runner, preserving script-release compatibility.
- Daemon compiled entry detection accepts both `daemon-entry.ts` and bundled `daemon.js`.
- Focused evidence: `stable-supervisor-hardening.test.ts` 59/59, `stable-supervisor-integration.test.ts` 5/5, and `process-runtime.test.ts` 39/39. A full compiled Supervisor smoke with a deliberately dirty test release remains readiness-blocked by the existing release-revision/source-commit mismatch, as expected for a non-production dirty release.


## Runtime architecture convergence follow-up (2026-08-02)

- Added canonical `bootstrap/runtime-authority.json` and `bootstrap/runtime-config.json` readers/writers with atomic replacement, schema validation, controller-home binding, and explicit `MIGRATION_REQUIRED` refusal for legacy-only state.
- Stable Supervisor rejects malformed canonical authority/config files and rejects a release revision that disagrees with the canonical active authority.
- Supervisor-managed Daemon/Gateway children are no longer detached process-group owners; the Supervisor retains direct lifecycle ownership.
- Lifecycle start refuses an unmanaged Supervisor service instead of spawning a detached coordinator. Activation remains a bounded child operation without a second detached owner.
- Focused evidence: TypeScript check passed; stable-state/bootstrap 15/15, process-runtime 39/39, activation/cutover 54/54, standalone Recovery 16/16, hardening 59/59, and controller-service 5/5.
- Governance checks passed: task gate, deploy SQL order, architecture sync (0 blocking), task sync, strict workflow check, project-state inspection, and migration dry-run. The worktree still reports missing generated workflow runtime manifests; the migration command was intentionally left dry-run.

- `check:main` initially exposed a real Node-loader cold-start defect: the independent process runner used a TypeScript parameter-property constructor and extensionless local imports, so `smoke:runtime-recovery` failed before executing the child command. Replaced the parameter properties with explicit fields and made the two local imports explicit `.ts` URLs.
- Re-run evidence: `bun run check:main` passed, including all five runtime smoke scripts; Recovery smoke confirms `processRecovered: true`, `executionJobCount: 0`, and successful WorkContract/session recovery.
## Manual 502/recovery probe (2026-08-02)

- The failed rollback left `runtime-slots/green/system/runtime-generation.json` and the MCP runtime source bound to candidate revision `183c490dae39ecbe9db349a58a676570b5fabc71`, while Supervisor authority still pointed at rollback revision `bb5f2e7774144737e28a743f54a1336b0ef3f84d`. The mismatch caused repeated daemon readiness timeouts and an unavailable Gateway.
- Recovery did not require rebuilding: booted out the stale LaunchAgent, republished the existing clean `183c...` release as the current Supervisor release, and bootstrapped the generated LaunchAgent. Supervisor, daemon, and Gateway then converged on `183c...`.
- Direct probes after recovery: local ingress `/health` and `/ready` returned HTTP 200; local Gateway `/health` returned HTTP 200; authenticated MCP bearer `initialize`, `tools/list`, and `rh_status` returned HTTP 200; the public health and readiness endpoints returned HTTP 200.
- An unauthenticated MCP request correctly returned HTTP 401. A restart-gateway rescue operation completed with `phase: succeeded`; the stable ingress remained HTTP 200 before and after the controlled restart. No HTTP 502 was observed during this probe.

## Public 530 follow-up (2026-08-02)

- Current Cloudflare tunnel mapping is `mcp.moretea-lab.tech -> http://127.0.0.1:8765`; `cloudflared` is running and its metrics endpoint returns HTTP 200.
- Historical tunnel errors show the 530 condition was caused by the origin being unavailable (`dial tcp 127.0.0.1:8765: connect: connection refused`), not by the tunnel hostname mapping.
- The origin is currently recovered without another restart: public `/health` returned HTTP 200 in three consecutive probes; local ingress and Gateway both returned HTTP 200. No disruptive action was taken because the service was already healthy.

## Latest controlled restart evidence (2026-08-02)

- The prior healthy probe did not establish a durable post-restart guarantee. After an explicit `scripts/controller-runtime.sh restart`, the installed `183c490...` release restarted Supervisor/Ingress and reached a `ready` Daemon, but Gateway readiness failed.
- The active release logged `EACCES` while spawning the source-checkout `src/runtime/execution/process-runtime/process-runner-entry.ts`; local ingress `/health` returned HTTP 503 and the public primary endpoint returned HTTP 503. The source revision `2ff6eda64` contains the release-sibling `process-runner.js` resolver fix, but activating a release built from it is separately gated.

## Recovery and Bootstrap coherence (2026-08-03)

- Staged and installed immutable release `fc722c87dfc26a2189d9179b1ed3abad361ec6c0` through the stable Controller-home Bootstrap. The final Supervisor state is `healthy`, with `green` active and the Daemon/Gateway/Ingress owned by that release.
- Local ingress `/health` and public `https://mcp.moretea-lab.tech/health` returned HTTP 200 after the activation attempt. Authenticated MCP `initialize` and `tools/list` succeeded; the active advanced surface reported 128 tools.
- The activation receipt initially reported a rollback timeout because the generated and installed launchd definitions intentionally point to the fixed `supervisor/bootstrap`, not directly to `supervisor.js`. The service-coherence check treated this valid Bootstrap layout as missing release metadata.
- `src/runtime/supervisor/release-coherence.ts` now validates fixed Bootstrap path, Controller Home, and `bootstrap-manifest.json.sourceCommit` against the current release before projecting generated/installed service metadata. This removes the false `SUPERVISOR_SERVICE_RELEASE_DRIFT` readiness blocker without weakening direct-release mismatch checks.

- After committing the coherence fix, Supervisor install activated `9776f1b871b0f9f256b3b20b744db4538e391f8c`; activation completed with `phase: succeeded`, `serviceCoherence.ok: true`, and all running/generated/installed release descriptors equal.
- Final probes: Supervisor `observedState=healthy`, active slot `green`, local and public health HTTP 200, and `controller_ready.ready=true` with no readiness reasons. The remaining `state=degraded` label is the task-ledger projection warning that no current Issue is selected, not a runtime or gateway failure.
