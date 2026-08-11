# Runtime Architecture

## One Runtime authority

The Canonical Forge Runtime is one local MCP application and one lifecycle owner. Its Runtime Root owns MCP transport, Controller services, persistent control-plane state, Process Runtime coordination, readiness, and the active whole-release identity. There is no second active Daemon/Gateway authority, blue-green runtime slot, or component-by-component rollout authority.

## Request path

Authenticated MCP requests enter the in-process transport and Gateway adapter. The Gateway validates schema and repository targeting, returns bounded results, and chooses the shortest valid path:

- bounded read or eligible ephemeral action -> Direct completion;
- repository command or check -> Unified Process Runtime;
- genuinely long-lived/dependency-aware objective -> durable Work/Scheduler path;
- hard external/destructive boundary -> explicit authorization or refusal.

The HTTP request does not become the owner of long-running execution.

## Stable client surface

The normal ChatGPT connector exposes 19 tools, including five preferred facades. Internal atomic handlers and the exhaustive compatibility profile remain available to Forge itself without widening normal discovery.

Tool schema is fenced by a fingerprint. When a connected client carries a stale fingerprint, Forge returns a bounded schema-change error and requests reinitialization. The stale transport is preserved until the replacement initialize supersedes it; closing the transport before the host sees the reset would turn a recoverable schema change into namespace loss.

## Process Runtime

A managed Process has one stable process record and exact process identity. The Runtime records spawn state, output paths, completion state, resource claims, and lease references. `process_get`, `process_wait`, `process_logs`, and `process_cancel` attach to the same Process and never mean “run the command again.”

Short predictable commands may finish inside a small interactive window. Known-long commands return their handle immediately. Process startup avoids duplicate persistence and identity probes on the hot path where the same evidence can be captured once.

## Repository and checkout fencing

Registered execution binds to immutable repository and checkout identity. Claims model the actual resource being touched: unrelated repositories and worktrees can progress concurrently; the same workspace writer conflicts. Ephemeral unregistered workspaces use a separate bounded authority and never masquerade as a registered repository.

## Check reuse

Check identity includes the relevant repository/check-out scope, content revision, check definition, environment/toolchain fingerprint, timeout contract, and reuse scope. Matching callers become subscribers to the same physical execution or valid result. Dirty content invalidates the reuse contract.

## Runtime service and releases

One OS-managed Forge Runtime service reads the active whole-release authority and starts exactly one Runtime Root. Candidate verification happens before an explicitly authorized activation. Runtime/source coherence is a release fact, not something ordinary repository commands are allowed to rewrite.

## Recovery path

Standalone Recovery is independent from the primary MCP endpoint. It verifies Runtime ownership, release coherence, authenticated MCP behavior, and optional external reachability. Sustained local failure can trigger bounded whole-Runtime restart attempts; if those are exhausted, an independently attested previous whole release and its SQLite backup may be restored under the Recovery lock.

## External tunnel

Cloudflare or Tailscale terminates outside the Runtime and points at the configured loopback endpoint. Tunnel health and local Runtime health are separate evidence classes. A tunnel outage alone cannot authorize Runtime rollback.

Detailed code boundaries are in [Implementation](Implementation); normative contracts live in the [current architecture set](https://github.com/moretea-labs/forge/tree/main/docs/architecture/current).
