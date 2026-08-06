# Support

Forge is currently in release-candidate hardening. Support is best-effort and focused on reproducible installation, first-run setup, repository safety, ChatGPT connectivity, Runtime recovery, and release-blocking defects.

## Before asking for help

Run:

```bash
forge --version
forge setup status
forge doctor
forge status --json
forge repo list --json
```

Forge does not provide previous-product command aliases. Redact tokens, OAuth material, private repository names, absolute home paths, email addresses, and proprietary source before sharing output.

## Where to ask

- Reproducible bugs: use the **Bug report** issue template.
- Documentation errors: use the **Documentation** template.
- Setup or usage questions: use the **Support question** template or GitHub Discussions.
- Feature proposals: use the **Feature request** template.
- Vulnerabilities: follow [SECURITY.md](SECURITY.md), never a public issue.

Issues should remain actionable and tied to a reproducible problem or a concrete documentation gap. Discussions are better for open-ended workflow questions and usage patterns.

## Useful details

Include the operating system, Node and Bun versions, installation method, exact command, expected result, actual result, and the smallest redacted log excerpt that demonstrates the problem. For Runtime incidents, also include local Forge Runtime readiness, standalone Recovery status, restart-attempt and rollback evidence, the public MCP result, and whether the external tunnel was reachable.
