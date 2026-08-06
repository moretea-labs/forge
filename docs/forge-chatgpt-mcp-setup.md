# Forge ChatGPT MCP Setup

## Setup

```bash
forge mcp setup chatgpt --repo /path/to/project
forge mcp doctor --repo /path/to/project
forge runtime status --controller-home /path/to/controller-home --json
```

Forge runs one canonical `forge-runtime` process. The OS service manager owns startup and automatic restart of that root process. MCP configuration and authentication are authoritative in Controller Home; repository-local `.forge/mcp.policy.json` remains the repository access policy.

Publish only the configured loopback `/mcp` endpoint through a controlled HTTPS tunnel. Do not expose the Local Controller UI.

See [Connect ChatGPT](tutorials/02-connect-chatgpt.md), [Troubleshooting](operations/troubleshooting.md), and [Canonical Runtime Architecture](architecture/current/runtime-architecture-simplification.md).
