# ADR: Single-Owner Runtime Lifecycle

- **Status:** Accepted target amendment
- **Date:** 2026-08-02
- **Scope:** Controller Runtime process ownership, primary authority/configuration, immutable release activation, and standalone Recovery
- **Authority:** [`../current/runtime-architecture-simplification.md`](../current/runtime-architecture-simplification.md)
- **Implementation authority:** `tasks/issues/ISS-20260802-539E7F-repo-harness.issue.md`
- **Recovery delivery line:** `tasks/issues/ISS-20260802-27931A-issue.issue.md`

## Decision

Converge the local runtime to one Supervisor-owned primary instance and exactly five OS services:

1. Supervisor;
2. Recovery Gateway;
3. Recovery Watchdog;
4. primary cloudflared tunnel;
5. Recovery cloudflared tunnel.

Stable ingress, Controller Daemon, and Gateway are Supervisor children. Gateway KeepAlive, detached restart coordinators, persistent blue/green slots, root/slot fallback configuration, and repo-local lifecycle launch agents are migration compatibility only and are deleted after verified cutover and rollback-window closure.

Primary lifecycle truth is one `bootstrap/runtime-authority.json` plus one `bootstrap/runtime-config.json` under Controller Home. Recovery has an independent release directory, config, state boundary, audit directory, and tunnel. Recovery observes and requests bounded operations; it never writes primary authority or runs arbitrary commands.

## Rationale

The previous model had multiple lifecycle owners and several projections that could disagree: Supervisor, Gateway KeepAlive, detached restart coordination, blue/green slot state, root configuration, and repository-local configuration. A healthy port or live PID could therefore hide release/source drift or stale ownership. A single Supervisor-owned instance gives each mutation one owner, while candidate/previous release records retain last-known-good routing without persistent slot identity.

Recovery must remain reachable when the primary runtime is unavailable, so it cannot be a Supervisor child or share primary tunnel state. OS service ownership is deliberately below both lifecycle families: launchd restarts abnormal exits, and explicit unload remains a stop.

## Consequences

- Every activation and rollback requires an immutable, complete manifest and exact identity/CAS evidence.
- Last-known-good ingress remains unchanged until candidate readiness and post-cutover verification pass.
- Legacy state is migrated one-way; unsupported state returns `MIGRATION_REQUIRED` rather than silently selecting a fallback.
- Current implementation remains transitional until the G1–G9 gates in the target document pass.
- Execution-plane compatibility records and MCP facade contracts remain unchanged by this decision.
