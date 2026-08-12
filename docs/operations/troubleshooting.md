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

Node.js 20.10 or newer is a base requirement even when the package was installed with Bun. Git is **not** a base installation requirement; install Git when you enable repository/software-work features. If plain `forge setup` is blocked only by an unselected Codex/Claude/CodeGraph check, update Forge—the controller-first setup path should filter unrelated host tooling.

## Native Windows stops at a shell-owned step

Use WSL2 for repository adoption, Bash hooks, source release checks, or shell lifecycle scripts. Native Windows intentionally skips the Bash skill-sync and automatic CodeGraph steps.

## MCP works locally but ChatGPT cannot connect

`http://127.0.0.1:8765/mcp` is intentionally local-only. Run `forge setup next` and inspect the selected remote provider.

- **OpenAI Secure MCP Tunnel:** run `tunnel-client runtimes status forge --json`; do not claim success unless the runtime is running, healthy, and ready. Keep `CONTROL_PLANE_API_KEY` outside Forge state.
- **Cloudflare/Tailscale/existing HTTPS:** verify the stable `/mcp` address and OAuth discovery with `forge mcp doctor` plus the provider's own status tools.

Do not expose the local Utility Console port publicly.

## MCP config seems to be in the wrong place

Current service-level MCP config lives under Controller Home, not as the primary repo-local source:

- `controllerHome/mcp/mcp.local.json`
- `controllerHome/mcp/mcp.tokens.json`
- `controllerHome/mcp/mcp.oauth.json`
- `controllerHome/mcp/mcp.oauth-tokens.json`
- `controllerHome/mcp/mcp.runtime.json`

Controller Home is the sole authority for service-level MCP configuration. Repository-scoped `.forge/mcp.policy.json` remains repository access policy. For the normal ChatGPT path rerun `forge mcp setup chatgpt --user-level` or simply `forge setup next`; repository-scoped setup remains a compatibility path.

## Only some tools appear in ChatGPT

The default controller intentionally exposes a bounded stable facade rather than every atomic internal handler. Request/Full Access changes authorization, not the tool schema. Compare the current fingerprint and missing/unexpected tools from `rh_status`; refresh/recreate the ChatGPT app only when the connector snapshot itself is stale or tool definitions changed.

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

## Codex or Claude controller entry is unavailable

Forge has no internal agent that must be repaired. If Codex/Claude was not selected, ignore its absence. If it was explicitly selected as a controller entry, install/authenticate that client and run `forge mcp setup codex --scope user --profile controller` or `forge mcp setup claude --scope user --profile controller`, then continue with `forge setup next`.

## Repository paths behave differently between Windows and WSL2

Do not share one active checkout between native Windows and WSL2. Clone inside the environment that runs Forge and register that path. This avoids file-mode, line-ending, symlink, and performance problems.

## Release checks fail on personal paths or logs

Remove tracked runtime state, absolute home paths, credentials, logs, PID files, and generated artifacts. Do not add broad allowlist entries to silence genuine findings.
