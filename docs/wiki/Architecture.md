# Architecture

repo-harness separates short authenticated requests from durable repository work. The major boundaries are:

- MCP Gateway and Local Bridge for authentication, validation, routing, and bounded responses;
- Controller Daemon and Scheduler for recovery, fairness, dependencies, and process ownership;
- repository-scoped actors, claims, leases, and fencing for conflict control;
- isolated Process Runtime execution and managed worktrees;
- evidence and materialized projections for resumable review.

The current versioned design is maintained in:

- [System overview](https://github.com/moretea-labs/repo-harness-controller-runtime/blob/main/docs/architecture/current/system-overview.md)
- [Architecture invariants](https://github.com/moretea-labs/repo-harness-controller-runtime/blob/main/docs/architecture/current/architecture-invariants.md)
- [Runtime directory map](https://github.com/moretea-labs/repo-harness-controller-runtime/blob/main/docs/architecture/current/runtime-directory-map.md)
- [Job and Run lifecycle](https://github.com/moretea-labs/repo-harness-controller-runtime/blob/main/docs/architecture/current/job-and-run-lifecycle.md)
- [Verification and release gates](https://github.com/moretea-labs/repo-harness-controller-runtime/blob/main/docs/architecture/current/verification-and-release-gates.md)

Historical snapshots explain prior designs but are not current runtime contracts.
