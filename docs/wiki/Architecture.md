# Architecture

This page is a short map. Start with [Runtime Architecture](Runtime-Architecture) for the operational view and use the versioned documents below for exact contracts.

## Major boundaries

- The public MCP ingress authenticates and routes bounded requests.
- The Controller owns durable scheduling, repository selection, recovery, and process ownership.
- Repository work is fenced by explicit repository and checkout identity.
- Long-running execution is isolated from the request path and returns durable evidence.
- Stable runtime releases are immutable and activated only when source, manifest, service definition, and running processes agree.
- Independent recovery remains separate from the primary Gateway.

## Authoritative documents

- [System overview](https://github.com/moretea-labs/forge/blob/main/docs/architecture/current/system-overview.md)
- [Architecture invariants](https://github.com/moretea-labs/forge/blob/main/docs/architecture/current/architecture-invariants.md)
- [Entity model](https://github.com/moretea-labs/forge/blob/main/docs/architecture/current/entity-model.md)
- [Job and Run lifecycle](https://github.com/moretea-labs/forge/blob/main/docs/architecture/current/job-and-run-lifecycle.md)
- [Runtime directory map](https://github.com/moretea-labs/forge/blob/main/docs/architecture/current/runtime-directory-map.md)
- [Verification and release gates](https://github.com/moretea-labs/forge/blob/main/docs/architecture/current/verification-and-release-gates.md)

Historical snapshots explain prior designs but are not current runtime contracts.
