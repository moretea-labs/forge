# Controller Runtime Operations Runbook

> Status: **Runtime Authority**

## Health

- `GET /health`: Gateway event loop, session pressure and tool surface. Must stay fast.
- `GET /ready`: binary whole-Runtime readiness for the Canonical Forge Runtime.
- `GET /repos/<repoId>/health`: repository projection, queue and Lease state.
- MCP `controller_ready`: equivalent structured readiness.

## Job Inspection

Use `get_job` with the returned Job ID. Include events only for lifecycle diagnosis. Use `get_artifact` for bounded access to oversized results.

Key waiting states are not failures:

- `waiting_for_dependency`
- `waiting_for_workspace`
- `waiting_for_heavy_check`
- `waiting_for_integration`
- `waiting_for_release_barrier`

## Recovery

The Canonical Forge Runtime reconciles running Jobs every five seconds. Operation Receipts distinguish a completed side effect from an uncertain mutation window. A completed receipt closes the Job after restart; an uncertain mutating operation becomes `human_attention_required` and is never replayed blindly. Safe read-only work may be retried while attempts remain. Cancellation terminates the owned Worker when present and releases only the exact Lease/fencing set for that attempt. Stale Workers cannot renew, release or publish against a replacement attempt.

## 502 Diagnosis

1. Check `/health`. A failure here indicates Gateway or transport failure.
2. Check `/ready`. A healthy Gateway with failed readiness indicates Daemon/control-plane degradation.
3. Read the accepted Job by ID. Do not infer failure from a disconnected MCP request.
4. Inspect repository projection for waiting resources.
5. Inspect Job events and Worker heartbeat.
6. Distinguish explicit 429/503 admission pressure from an upstream tunnel 502.

Long work is not retried by resending an arbitrary request ID. Reuse the original request ID to recover the accepted Job.

## Schedule Safety

Create mutation Schedules with Shadow Mode enabled. Review persisted Decisions and Occurrences before enabling execution. Interval, UTC cron, calendar, condition-watch, repository-event, dependency-checkpoint and manual triggers all produce one bounded idempotent Occurrence. Failures use persisted exponential backoff. Schedules cannot push, publish, close remote Issues, deploy, inflate requirements directly or run arbitrary repository commands.

## Release

Request a Release Gate Job. A successful Gate produces `releaseReady: true` and a manifest for the exact current revision. It does not push, tag, publish or deploy.
