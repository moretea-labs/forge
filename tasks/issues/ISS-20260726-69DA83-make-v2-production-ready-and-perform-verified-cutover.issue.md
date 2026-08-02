---
id: "ISS-20260726-69DA83"
kind: "bug"
status: "cancelled"
updated_at: "2026-08-02T05:46:44.376Z"
source: "repo-harness-controller-v8"
---

# Make V2 production-ready and perform verified cutover

Superseded by ISS-20260802-539E7F. This Issue is based on the retired long-lived blue/green slot, multi-writer authority and slot-local configuration model. Its useful requirements—isolated candidate validation, soak/performance evidence, uninterrupted last-known-good traffic and guarded production cutover—are preserved in the new architecture under T5, T8 and T9. No implementation should continue from this contract.

## Goals

- Eliminate the direct root causes of the previous V2 cutover failure.
- Prove V2 MCP, Controller, Scheduler, Worker, Local Bridge and repository operations on isolated ports.
- Demonstrate V2 performance is not worse than the current stable runtime and improves targeted hot paths.
- Keep the current stable release serving traffic throughout candidate validation.
- Cut over only after all release gates pass and verify the external ChatGPT connector remains callable.

## Non-goals

- Further redesign of standalone recovery or watchdog quorum.
- Grok recovery wrapper improvements.
- SSH or Tailscale architecture changes.
- Unrelated iOS, browser, task-ledger or workflow features.
- Merge to main or push before successful runtime cutover verification.

## Acceptance Criteria

- [ ] Candidate writer authority is correct after activation and produces no WRITER_FENCED loop.
- [ ] Blue and green slots use distinct MCP and local-controller ports with no bind conflict.
- [ ] Rollout operation cannot report succeeded before stable ingress, authenticated MCP initialize/tools/list/read-only call and external connector verification pass.
- [ ] Candidate runs for at least 30 minutes under repeated MCP and durable-job smoke load without 502, process leak, restart loop or queue stall.
- [ ] Measured p50/p95 latency and throughput are recorded against old stable; no critical regression and at least one targeted performance improvement is demonstrated.
- [ ] Cutover preserves the old release as an immediately usable rollback target and the primary connector remains callable after switch.

## GitHub

- Not published.

## Tasks

### T1 — Repair V2 cutover-critical defects

- Status: `ready`
- Objective: Use incident evidence from the failed 7cb1585e rollout to fix writer-authority handoff, passive candidate lease reconciliation, slot-local port isolation, authenticated readiness semantics, and rollout transaction terminal-state ordering. Add focused regression and failure-injection tests. Do not touch broad standalone recovery enhancements.
- Depends on: none
- Allowed paths: `src/runtime/supervisor/**`, `src/runtime/resources/leases/**`, `src/cli/controller/stable-state/**`, `src/cli/controller/bluegreen-rollout.ts`, `src/cli/commands/supervisor.ts`, `src/cli/controller/runtime-slots.ts`, `src/cli/controller/lifecycle.ts`, `src/cli/mcp/**`, `tests/runtime/**`, `tests/cli/**`, `docs/architecture/current/**`, `tasks/issues/**`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:mcp-compatibility`, `package:check:controller-v8`
- Execution hint: agent / codex

### T2 — Prove V2 functionality, performance and soak stability

- Status: `planned`
- Objective: Build an immutable V2 candidate and run it without production cutover using isolated slot ports or an equivalent shadow harness. Exercise MCP initialize/tools/list/read-only calls with real auth, repository reads, durable commands, scheduler/worker completion, Local Bridge, restart of candidate components and repeated requests. Benchmark against old stable and run a minimum 30-minute bounded soak. Fix only defects revealed by these tests.
- Depends on: `T1`
- Allowed paths: `src/**`, `scripts/**`, `tests/**`, `docs/researches/**`, `docs/operations/**`, `package.json`, `tasks/issues/**`
- Checks: `package:check:ci`, `package:check:release-readiness`
- Execution hint: agent / codex

### T3 — Perform guarded V2 cutover and verify production

- Status: `planned`
- Objective: After T1 and T2 evidence pass on the exact immutable candidate, execute one blue-green cutover while retaining the old stable release. Verify stable ingress, authenticated MCP, external primary connector, tool surface, repository read and durable command completion from the active V2. Observe a bounded post-cutover stability window. Roll back immediately on any failed gate. Do not merge or push as part of cutover.
- Depends on: `T2`
- Allowed paths: `src/runtime/supervisor/**`, `src/cli/controller/**`, `scripts/**`, `docs/operations/**`, `tasks/issues/**`
- Checks: not defined
- Execution hint: agent / codex

## Related Artifacts

- `ISS-20260802-539E7F`
- `superseded: long-lived blue/green V2 cutover contract`
- `preserved acceptance: candidate soak, performance comparison, external connector verification`
