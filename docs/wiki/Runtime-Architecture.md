# Runtime Architecture

## Request path

The stable ingress accepts the public MCP connection and routes ordinary traffic to the active Gateway. The Gateway authenticates, validates, and returns bounded responses.

## Durable control path

The Controller Daemon owns repository registration, scheduling, durable jobs, recovery, and process coordination. Long work continues outside the short HTTP request lifecycle.

## Execution path

Repository commands, checks, agents, and isolated tasks run through managed execution with explicit repository scope. Worktrees are used when concurrency or isolation requires them, not by default for every read.

## Stable runtime path

The Stable Supervisor owns immutable releases and blue/green runtime slots. A rollout succeeds only when the release manifest, service definition, slot metadata, Controller Daemon, Gateway, and ingress are coherent.

## Recovery path

Independent recovery is separate from the primary Gateway. It can inspect Supervisor and slot state, verify the full MCP path, attest a fully verified release as known-good, and perform bounded recovery without trusting a failed primary connector.

## External tunnel

Cloudflare or Tailscale terminates outside the Gateway and points at the stable ingress, never directly at a slot backend. Tunnel health and local runtime health must be diagnosed separately.

Detailed contracts: [Architecture](Architecture) and the [current architecture set](https://github.com/moretea-labs/matea/tree/main/docs/architecture/current).
