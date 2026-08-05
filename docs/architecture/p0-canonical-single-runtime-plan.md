# P0 Canonical Single Runtime Plan

- **Plan ID:** `p0-canonical-single-runtime-phase0-phase1-20260805`
- **Work ID:** `work_53aa637f3dd24751af7ef9c928473310`
- **Source revision:** `647f3851c2d64fe58cb922ec50946dd7871a384d`
- **Scope key:** `runtime-root-p0`
- **Status:** approved/executing

## Goal

Deliver one mergeable vertical slice in which one `repo-harness-runtime` process owns explicit configuration, release coherence, Controller Home ownership, SQLite initialization, Controller Services, Scheduler, Gateway Adapter, authenticated MCP Transport, whole-system readiness, and ordered shutdown.

## Resolved decisions

1. Phase 0 uses one SQLite-backed Work admission policy at the existing WorkContract write boundary. It is not a new scheduler, queue, daemon, or lifecycle state machine.
2. The exclusive policy allows only the claimed P0 Work ID and read-only diagnostics. Scheduler dispatch and workflow advancement are paused while the policy is active; cleanup/reconciliation may still run.
3. The canonical MCP path is `MCP HTTP -> in-process Gateway Adapter -> Controller Services -> SQLite`; it never calls `ensureControllerDaemon` and has no internal Gateway/Controller TCP port.
4. Runtime ownership is one process-lifetime Controller Home claim. A live owner rejects a second Runtime; stale owner records can be replaced without port or cwd inference.
5. Scheduler tick failures are fatal in canonical mode. Runtime Root records the reason and stops the complete Runtime instead of restarting a component.
6. Runtime readiness exposes one `ready: boolean`; database, Scheduler, release coherence, and authenticated MCP end-to-end observations are diagnostic evidence only. Optional plugins, tunnel, and worker count are not core checks.
7. `repo-harness-runtime` is the sole canonical lifecycle entrypoint. The `runtime` CLI namespace is read-only and contains no start, stop, restart, doctor, detached coordinator, or independent Daemon ownership path.

## Execution steps

1. **Phase 0 admission isolation** — persist exclusive Work policy in SQLite; enforce create/continue at WorkContract store; prevent Scheduler dispatch/workflow ticks; test persistence and P0 exception.
2. **Runtime Root** — validate explicit config and complete release manifest; acquire Controller Home ownership; initialize SQLite and Controller Services; start strict in-process Scheduler.
3. **MCP vertical path** — start bearer-authenticated MCP listener; support initialize, tools/list, and `controller_ready`; ensure the call reads SQLite through Controller Services.
4. **Readiness and shutdown** — run authenticated self-probe, derive readiness, monitor Scheduler/Transport fatal errors, and perform ordered complete shutdown.
5. **Lifecycle namespace convergence** — expose `repo-harness-runtime` as the only start entry; keep `runtime status` as an instance-bound read-only projection and remove legacy lifecycle commands from that namespace.
6. **Verification and delivery** — focused tests, type check, runtime architecture check, commit, merge to `main`, delete branch, clean worktree.

## Checks

- `bun test tests/runtime/canonical-single-runtime.test.ts`
- `npm run check:type`
- `npm run check:runtime-architecture`
- `npm run test:core`

## Stop/replan conditions

- Stop if implementation requires another resident process, internal fixed TCP port, new durable lifecycle state machine, or dual SQLite authority.
- Replan if the existing WorkContract boundary cannot block create/continue centrally, or if the MCP SDK cannot provide an in-process authenticated end-to-end path.

## Legacy deletion map

| Legacy layer | Temporary role | Delete phase |
| --- | --- | --- |
| `src/cli/controller/lifecycle.ts` Supervisor/component manager | no longer reachable from canonical `runtime` or public `controller` lifecycle commands; remaining internal legacy callers only | Phase 2 then Phase 7 |
| `src/cli/commands/supervisor.ts` | public registration removed; retained only as internal legacy implementation/test inventory | Phase 2 then Phase 7 |
| MCP KeepAlive and MCP restart paths | public/hidden CLI entrypoints removed and `src/cli/mcp/restart.ts` deleted; KeepAlive implementation remains deletion inventory | Phase 2 then Phase 7 |
| Daemon auto-start in legacy HTTP transport | legacy `mcp serve` compatibility only; remove after Controller Services are fully Runtime-owned | Phase 2 |
| Controller Daemon/local bridge internal port | legacy tools not yet migrated | Phase 2 |
| standalone Recovery autonomous PI/agent repair | removed; Recovery may not launch a coding agent or mutate a source checkout | Phase 2 complete for this authority |
| Stable Ingress and blue/green runtime slots | legacy release activation | Phase 4 |
| Component rollout/rollback and writer slot authority | compatibility until whole-release updater | Phase 5 then Phase 7 |
| Legacy health/readiness combinations | compatibility output | Phase 3 |
