# Route and Session Concurrency

Status: current architecture

This document records the invariants implemented for `ISS-20260803-90E84B` / `PLAN-ROUTE-SESSION-CONCURRENCY`. Runtime state in the controller-home SQLite control plane remains authoritative. Issue and Task files are historical/import/export artifacts and are not runtime write authority.

## Identity and projection isolation

Every context or projection result is accepted only when its immutable identity agrees with the active request identity. The cache/projection identity includes:

- repository ID;
- checkout ID and worktree identity;
- observed Git source identity, including HEAD/source revision;
- projection identity and generation.

A late result from a previous repository, checkout, source identity, branch observation, or projection generation is discarded. Payload identity and `sourceIdentity` disagreement fails closed. Session default repository state never overrides an explicit repository ID. Registry branch data is advisory; Git HEAD observation is authoritative for source fencing.

The T1 source-identity fencing introduced before this change remains mandatory. No shared mutable cache was added; Gateway contention metrics use bounded process-local aggregation and hashed low-cardinality dimensions only.

## Typed diagnostic runtime resolution

All persisted diagnostic/check launch paths use one typed runtime resolver. The resolver returns:

- executable;
- argv;
- runtime kind;
- source revision;
- immutable-release flag;
- a diagnostic explanation.

Runtime kinds are `compiled_bun_release`, `bun_source`, `node_source`, and `package_launcher`. Runtime identity is established by an explicit runtime kind, an immutable standalone marker, the Bun virtual filesystem identity, an explicit package/global launcher entry, or the Bun/Node executable identity. File extensions are not used to guess launch semantics.

Package/global shims and paths containing spaces remain separate argv entries. A package launcher requires an explicit launcher entry. Source and compiled runtimes therefore use the same resolver contract instead of separate argv fallback chains.

If runtime identity cannot be resolved, the controller creates a short persistent Process that exits terminally and reports `DIAGNOSTIC_RUNTIME_UNRESOLVED`. The request cannot remain `running` or `validating` after resolver failure.

## Gateway bounded-latency boundary

Gateway synchronous work is limited to bounded identity resolution, registry/control-plane reads, routing, and admission. Heavy operations are Process-managed:

- workflow watchdog;
- runtime maintenance status;
- cleanup preview;
- runtime performance diagnostics, including process and temporary-directory scans;
- capability recovery probe;
- persisted check execution.

The Gateway waits at most five seconds for an inline diagnostic result. The Process execution timeout remains independent. After the interactive budget expires, the response contains the durable Process reference and polling pointers. Process status, cancellation, timeout, terminal receipts, and restart reconciliation remain persisted and truthful.

A diagnostic for one repository cannot occupy another repository session's request path. The routing regression starts a delayed Process for repository A while repository B continues a bounded board read.

## Authoritative checkout mutation lease

Direct Edit and durable execution use the same execution lease store and conflict rules. Mutation claims are explicitly scoped by repository and checkout; cwd, session defaults, and stale registry branch values cannot create an unscoped mutation owner.

The authoritative owner identity contains:

- repository ID;
- checkout ID;
- worktree ID;
- branch;
- principal ID;
- controller instance ID;
- controller generation.

A SHA-256 owner identity digest is persisted with every lease and is included in renew, assert, rollback, and release fencing. A stale controller instance or generation cannot renew or release a live owner's lease. Terminal, cancelled, failed, timeout, snapshot-failure, and restart cleanup paths release only leases whose owner, lease ID, fencing token, and identity digest match.

Conflict semantics are checkout-local:

- two writers for the same checkout serialize;
- different checkouts in the same repository can proceed in parallel;
- different repositories can proceed in parallel;
- read-only requests do not acquire the mutation lease.

## Bounded lock acquisition and metrics

Gateway-reachable controller locks never sleep synchronously. `tryAcquireControllerLock` performs one acquisition attempt. The compatibility synchronous API returns `LOCK_HELD` immediately on contention, even when an obsolete caller supplies a long wait budget. The asynchronous API yields to the event loop and caps its total wait at five seconds.

Metrics record wall-clock, queue, lock wait, storage, Git observation, worker/process, projection, execution, and serialization phases. Aggregation dimensions are operation class plus hashed repository/checkout buckets. Full paths, secrets, request payloads, principals, branch names, and user input are not recorded. Aggregation is bounded to 256 buckets and 512 samples per bucket.

## Operational consequences

A contention response is an admission result, not a hidden blocking wait. Callers may retry durably or hand off to a Process/worker. A persistent Process reference is the continuation point for heavy diagnostics and checks. Restart recovery reads persisted state and never reconstructs ownership from cwd or session defaults.

The reproducible capacity baseline and threshold derivation are documented in `docs/operations/route-session-concurrency-baseline.md` and materialized as `docs/operations/route-session-concurrency-baseline.json`.
