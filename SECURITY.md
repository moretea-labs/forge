# Security policy

## Supported versions

Until the first stable release, security fixes are applied to the latest `1.4.0-rc.x` line and `main`. Older prereleases and historical tags are not supported.

| Version | Supported |
| --- | --- |
| latest `1.4.0-rc.x` | Yes |
| `main` | Yes, for verification before release |
| older prereleases and historical tags | No |

## Reporting a vulnerability

Use GitHub's private vulnerability reporting flow from the repository **Security** tab. Include:

- the affected version or commit;
- the smallest safe reproduction;
- impact and required preconditions;
- whether credentials, remote writes, destructive actions, sandbox escapes, or privilege boundaries are involved;
- suggested mitigations, when known.

Do not include exploit details, credentials, tokens, private repository data, or unredacted host paths in a public issue. If private reporting is unavailable, open a public issue containing only a request for a private maintainer contact channel and no vulnerability details.

## Scope

Security reports are especially useful for:

- authorization or repository-scope bypasses;
- remote or destructive actions occurring without explicit authorization;
- secret leakage through logs, artifacts, packages, or public exports;
- command injection, path traversal, unsafe worktree cleanup, or symlink attacks;
- MCP authentication, OAuth, Supervisor, Gateway, Worker, or plugin boundary failures;
- release provenance or package-content tampering.

A normal validation failure, unsupported platform, stale documentation, or unavailable optional provider is usually a bug rather than a vulnerability unless it crosses a security boundary.

## Disclosure

Please allow maintainers time to reproduce, fix, and prepare an advisory before public disclosure. The project will credit reporters who request attribution and will avoid publishing sensitive reproduction details that create unnecessary risk.
