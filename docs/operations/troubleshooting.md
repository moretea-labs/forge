# Installation and Connection Troubleshooting

## `forge` is not found after installation

Reopen the terminal first. With npm, inspect the global prefix with `npm config get prefix`; its executable directory must be on `PATH`. With Bun, ensure the Bun bin directory is on `PATH`.

Verify the runtimes:

```bash
node --version
npm --version
bun --version   # optional
forge --version
```

## Doctor reports missing Git or Node

Install Git and Node.js 20.10 or newer, then open a new terminal. Node is required even when the package was installed with Bun because the published launcher uses Node.

## Native Windows stops at a shell-owned step

Use WSL2 for repository adoption, Bash hooks, source release checks, or shell lifecycle scripts. Native Windows intentionally skips the Bash skill-sync and automatic CodeGraph steps.

## MCP works locally but ChatGPT cannot connect

`http://127.0.0.1:8765/mcp` is local-only. ChatGPT needs a stable public HTTPS URL ending in `/mcp`. Check the tunnel, the exact path, and `forge mcp doctor`. Do not expose the local Controller UI port publicly.

## MCP config seems to be in the wrong place

Current service-level MCP config lives under Controller Home, not as the primary repo-local source:

- `controllerHome/mcp/mcp.local.json`
- `controllerHome/mcp/mcp.tokens.json`
- `controllerHome/mcp/mcp.oauth.json`
- `controllerHome/mcp/mcp.oauth-tokens.json`
- `controllerHome/mcp/mcp.runtime.json`

Controller Home is the sole authority for service-level MCP configuration. Repository-scoped `.forge/mcp.policy.json` remains the repository access policy; repository-local service configuration is unsupported. Rerun `forge mcp setup chatgpt --repo /path/to/your-project`, then verify the active endpoint and server name from Controller Home.

## Only some tools appear in ChatGPT

The default controller uses a stable repair-capable schema (normally 100–128 tools). Request/Full Access never changes that schema. Compare `expectedToolCount`, `actualToolCount`, `missingTools`, `unexpectedTools`, and the fingerprint from `rh_status` or `controller_ready`. Reconnect only when the Connector snapshot itself is stale, not after a permission change.

## Runtime storage is not ready or the Local UI looks stale

Do not delete `.ai/harness`, `.forge`, or Controller Home state as a first response. Start with bounded diagnostics:

```bash
forge mcp doctor --repo /path/to/your-project
forge repo list --json
```

If you are using the operator surfaces, inspect the runtime-maintenance path before restarting or replaying writes. The self-healing and reliability docs describe the safe recovery flow:

- `runtime_maintenance_status`
- `runtime_maintenance_apply`
- [Self-healing loop](../forge-runtime-self-healing-loop.md)
- [Controller reliability runbook](controller-reliability-runbook.md)

A `502`, reconnect, or truncated response does not prove a durable write failed. Confirm the Job, Run, or evidence summary before retrying the mutation.

## Agent delegation is unavailable

Core Direct Edit and repository workflows still work. Install and authenticate Codex or Claude, then restart MCP with the dev runner explicitly enabled. Do not enable agent flags in the basic setup unless the CLI is present.

## Repository paths behave differently between Windows and WSL2

Do not share one active checkout between native Windows and WSL2. Clone inside the environment that runs Forge and register that path. This avoids file-mode, line-ending, symlink, and performance problems.

## Release checks fail on personal paths or logs

Remove tracked runtime state, absolute home paths, credentials, logs, PID files, and generated artifacts. Do not add broad allowlist entries to silence genuine findings.
