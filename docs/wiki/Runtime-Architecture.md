# Runtime Architecture

## Request path

The canonical Forge Runtime exposes the authenticated MCP endpoint directly through its in-process transport and Gateway adapter. Requests are authenticated, validated, and bounded before entering repository-scoped control logic.

## Durable control path

The same Runtime Root initializes Controller services, SQLite, the Scheduler, projections, and Worker management. Durable Work and evidence continue outside the short HTTP request lifecycle without a second Daemon owner.

## Execution path

Repository commands, checks, Agents, and isolated tasks run through managed execution with explicit repository scope and Runtime/release fencing. Worktrees are used when concurrency or isolation requires them.

## Runtime service and releases

One OS-managed Forge Runtime service reads the atomic active whole-release authority and starts exactly one Runtime Root. Forge has no blue-green slots, alternate active port, mixed generation, or component rollout. Candidate canaries run before an explicitly authorized stop/switch/start activation.

## Recovery path

Standalone Recovery is independent from the primary MCP endpoint. It verifies local Runtime ownership, release coherence, authenticated MCP behavior, and optional external reachability. Sustained local failure triggers bounded whole-Runtime restart attempts; after they are exhausted, an independently attested previous whole release and its SQLite backup may be restored, restarted, and verified under one Recovery lock.

## External tunnel

Cloudflare or Tailscale terminates outside the Runtime and points at its configured loopback endpoint. Tunnel health and local Runtime health remain separate evidence classes; a tunnel outage cannot authorize a Runtime rollback.

Detailed contracts: [Architecture](Architecture) and the [current architecture set](https://github.com/moretea-labs/forge/tree/main/docs/architecture/current).
