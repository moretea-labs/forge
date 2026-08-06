# Security Model

## Trust boundaries

Forge distinguishes ChatGPT, the public MCP ingress, the local Controller, repository workspaces, external services, optional plugins, and the independent recovery channel. A successful connection at one boundary does not authorize effects at another.

## Repository scope

Normal work is limited to a registered repository and checkout. Outside-repository filesystem access requires a separate capability or grant.

## Effect classes

- Read-only inspection
- Local repository changes
- Remote writes
- Destructive operations
- Secret or credential access

Remote, destructive, and secret-bearing actions stay explicitly gated even when local repository access is configured for fewer prompts.

## Secret handling

Tokens, OAuth material, private paths, and proprietary source must not enter public logs, artifacts, docs, packages, or issue reports. Public export and release checks scan for unsafe content but do not replace careful review.

## Runtime and release integrity

Stable releases are immutable and identified by full Git revision plus manifest hash. Rollback uses exact known-good evidence. Ambiguous source ownership, stale activation, dirty source, or release drift fails closed.

## Reporting vulnerabilities

Use GitHub private vulnerability reporting. See the repository [Security Policy](https://github.com/moretea-labs/forge/blob/main/SECURITY.md).
