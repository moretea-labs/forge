# Projection Refresh and Process Runtime Routing Closeout

Issue: `ISS-20260727-197BBE`  
WorkContract: `work_9f013aa521c04d40b1287ab74494a956`

## Scope

This closeout intentionally addresses only two stability defects:

1. repository projection refresh could remain dirty indefinitely;
2. registered read and local Git tools could be routed to the retired ExecutionJob path.

It does not introduce another control plane or revive ExecutionJob creation.

## Root cause: projection refresh

The scheduler assembled projection refresh candidates only while iterating waiting legacy ExecutionJobs. A healthy scheduler with an empty execution queue therefore never refreshed a dirty repository. The dirty marker also carried a random nonce instead of the canonical source revision, had no pending/running/failed lifecycle or retry evidence, and refresh exceptions were discarded. Readiness consequently compared a stale projection to a non-revision nonce and could remain degraded after the runtime itself was healthy.

## Projection state-machine repair

The repository-scoped refresh request now records canonical source revision, status, owner, attempt count, retry time, and failure evidence. A repository lock provides a single writer. Newer source revisions supersede older work, stale owners can be reclaimed, failed work is retried with bounded backoff, and the generated projection is persisted before a matching request is cleared. Full and short Git SHA forms are normalized for comparison. The scheduler scans enabled repositories independently of ExecutionJob dispatch, so queue depth zero no longer blocks convergence.

## Root cause: tool routing

Gateway routing relied on incomplete hand-maintained sets. Any registered tool omitted from those sets fell through to a default durable classification, which then returned `EXECUTION_JOB_RETIRED`. A second pre-route treated Gateway isolation and `openWorldHint` as ownership boundaries, so even registered read-only runtime diagnostics could be sent to the retired path.

## Routing repair

The registered MCP definition is authoritative. Registered read-only tools always use their real handler. Structured local Git mutations use the existing direct/Process Runtime path. Ordinary checks use Process Runtime, while only explicitly listed external-Controller operations retain ownership fencing. `openWorldHint` no longer implies Controller ownership. Unknown tools return `TOOL_NOT_FOUND`, and the durable-job compatibility predicate delegates to the same classifier instead of duplicating policy.

## Verification intent

Focused tests cover queue-empty refresh, successful dirty clearing, readiness recovery, failure evidence and retry, revision supersession, stale-owner recovery, concurrent idempotency, SHA normalization, direct project reads, isolated runtime reads, structured Git mutations, managed checks, Work ownership fencing, terminal receipts, and unknown-tool rejection. Required repository gates are executed through Process Runtime before merge and V8 is executed on merged `main`.
