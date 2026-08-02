# Single-owner runtime recovery contract

Status: accepted
Date: 2026-08-02

## Ownership

Supervisor is the only primary runtime lifecycle owner and the only writer of
`bootstrap/runtime-authority.json` and `bootstrap/runtime-config.json`. The
runtime consists of Supervisor, Recovery Gateway, Recovery Watchdog, primary
cloudflared, and recovery cloudflared. Ingress, Controller Daemon, and Gateway
are Supervisor children; Recovery is an independently usable, fail-closed
observer and operator of the recovery surface, not a second primary writer.

`runtime-authority.json` is the only durable route pointer. Stable ingress has
no active-slot file or in-memory pointer of its own: each request observes the
canonical authority and reports `x-runtime-authority-term` and
`x-runtime-authority-revision`.

## Revision and identity binding

The authority transaction carries:

- `authorityTerm` and activation transaction identity;
- `configRevision` and the SHA-256 `configHash` of the canonical runtime
  config;
- `active.instanceId`, release revision, release path, and manifest hash;
- optional `previous.instanceId` with the same release identity fields;
- writer epoch and fencing token evidence.

Bootstrap revision, Supervisor release revision, and active runtime revision
are distinct values. Readers reject missing or mismatched config bindings,
release instance identity, manifest identity, Controller Home, or writer
fencing evidence. A legacy pointer is migration-required, never a fallback.

## Readiness and commit fencing

A candidate release may run only bounded readiness probes before commit. It may
not schedule work, run workers, reconcile state, or perform cleanup. Supervisor
commits a new authority transaction only after readiness succeeds; the commit
issues the writer epoch/fencing claim. Only after commit may the candidate
obtain active-writer capability. Ingress switches routing only after the
committed candidate has restarted with that claim and passed readiness.

## Connection draining

A cutover marks the previous runtime draining before changing the authority
term. Existing SSE, MCP sessions, and long-lived HTTP connections retain their
backend route until completion or the bounded drain deadline. New requests
observe the committed authority and route to the active runtime. At deadline,
Supervisor closes remaining previous-runtime connections, records the deadline
and count in the operation evidence, and retires the previous release only
after its children and writer claim are confirmed stopped. Session migration
replays the original MCP initialize request and preserves the external session
identifier; migration failures return `MCP_SESSION_MIGRATION_PENDING` without
silently creating a new session.

## Recovery boundary

Recovery uses separate credentials, token rotation, rate limits, and audit
records. It may inspect the canonical authority and select only a registered,
complete, independently attested known-good release under the Supervisor-owned
release root. A recovery rollback creates a new operation and authority
transaction; directory existence, PID, port, or a stale previous pointer is
never sufficient evidence.
