# Implementation Notes: 20260802-runtime-observability

> **Status**: Implementation complete; exact-revision bootstrap verification pending
> **Scope**: Runtime health, supervisor probe classification, projection reconciliation, and MCP request diagnostics

## Decisions

- Readiness now exposes `externalEndpoint`, `mcpHandshake`, and `sessionContinuity` as graded observations. `unknown` remains visible without blocking readiness; an explicitly unhealthy external endpoint blocks the effective ready result. With no public endpoint env configured, `controller_ready` reports `unknown` and stays ready for local development.
- Supervisor gateway probe failures retain the existing thresholded recovery budget, while classifying deadline abort (`probe_timeout`), caller preemption abort (`probe_cancelled`), connection refusal, network error, invalid body, HTTP status, and unhealthy responses separately. A preempted probe is not health evidence: `supervisorGatewayHealthDecision(previous, healthy, cancelled=true)` leaves `consecutiveFailures` unchanged so the recovery budget is not consumed.
- `classifyFailure` maps probe timeout/abort messages to the `transient_probe_timeout` recovery class (in `dominantRecoveryClass` priority order).
- Projection health can reconcile active Task Ledger work with `runningWorkers`. A ledger-running/zero-worker gap is a bounded readiness blocker and all mismatches are returned as diagnostic evidence; non-blocking mismatches surface as warnings without changing `projectionBlocksReadiness`.
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