# Forge ChatGPT MCP Setup

## Primary Forge Connector

```bash
forge mcp setup chatgpt --repo /path/to/project
forge mcp doctor --repo /path/to/project
forge runtime status --controller-home /absolute/controller-home --json
```

Forge runs one canonical `forge-runtime` process. The OS service manager owns startup and automatic restart of that root process. MCP configuration and authentication are authoritative in Controller Home; repository-local `.forge/mcp.policy.json` remains the repository access policy.

Publish only the configured loopback `/mcp` endpoint through a controlled HTTPS tunnel. Do not expose the Local Controller UI.

## Independent Forge Recovery Connector

The Recovery Connector is a second ChatGPT connector backed by the independently installed Recovery Gateway and Watchdog. It remains available when the primary Forge Runtime is unavailable and exposes only the fixed recovery surface.

Install or update the immutable Recovery release with a dedicated HTTPS endpoint and a dedicated tunnel service:

```bash
forge recovery install \
  --controller-home /absolute/controller-home \
  --public-mcp-url https://mcp.example.com/mcp \
  --recovery-public-url https://recovery.example.com/recovery/mcp \
  --recovery-tunnel-service-label com.example.forge-recovery-tunnel \
  --recovery-tunnel-service-plist /absolute/path/com.example.forge-recovery-tunnel.plist
```

Print the exact connector descriptor without exposing the Gateway bearer token or OAuth passphrase:

```bash
forge recovery connector --controller-home /absolute/controller-home
```

The descriptor reports:

- connector URL: `https://recovery.example.com/recovery/mcp`;
- OAuth authorization-server and protected-resource metadata URLs;
- health URL;
- installed current and previous Recovery release revisions;
- `com.moretea.forge-recovery-gateway` and `com.moretea.forge-recovery-watchdog` service identities;
- whether the connector is ready to add to ChatGPT;
- the fixed Recovery tool list.

Add the reported URL as a separate ChatGPT MCP connector named **Forge Recovery**. During OAuth authorization, enter the local MCP passphrase created by `forge mcp setup chatgpt`. The Recovery Gateway uses a separate bearer token internally; neither the descriptor nor logs return that token.

The Recovery public endpoint and tunnel must be independent from the primary MCP service. Do not route the Recovery URL through the primary Forge Runtime process. The Recovery Gateway accepts `/recovery/mcp`, serves health at `/recovery/health`, and advertises OAuth metadata from the same public origin.

Verify after installation:

```bash
forge recovery status --controller-home /absolute/controller-home
forge recovery verify --controller-home /absolute/controller-home
```

A Recovery upgrade retires stale Recovery launchd services found under the Recovery-owned launchd directory before registering the Forge service labels. It also rewrites `recovery.json` from the current schema, dropping retired ingress, agent-repair, and legacy tunnel compatibility fields.

See [Connect ChatGPT](tutorials/02-connect-chatgpt.md), [Standalone Disaster Recovery](operations/standalone-disaster-recovery.md), [Troubleshooting](operations/troubleshooting.md), and [Canonical Runtime Architecture](architecture/current/runtime-architecture-simplification.md).
