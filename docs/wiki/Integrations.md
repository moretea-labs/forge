# Integrations

Integrations extend Matea without changing the core repository-safety model. Each integration has its own authorization and readiness checks.

## ChatGPT MCP

The primary connector uses a stable HTTPS `/mcp` endpoint. Verify initialize, initialized notification, tools/list, a read-only call, and session close—not merely TCP reachability.

## Coding agents

Codex, Claude, and GitHub Copilot can implement bounded tasks when available. Agent output remains subject to repository scope, diff review, tests, and integration rules.

## GitHub

GitHub operations cover issues, pull requests, checks, repository settings, Wiki synchronization, and releases. Remote writes remain explicit and should reference the exact local revision being published.

## Browser and local system

Browser and local-system plugins are optional controller capabilities. They use separate grants and do not turn repository access into unrestricted machine access.

## Google Workspace and personal workflows

Gmail, Calendar, Contacts, and related assistant routines remain connector-specific. Credentials and personal data are not stored in repository source.

## Apple tooling

Simulator and App Store Connect workflows use dedicated capabilities and authorization. They are distinct from generic shell or repository execution.

See the [documentation hub](https://github.com/moretea-labs/matea/blob/main/docs/README.md) for maintained integration guides.
