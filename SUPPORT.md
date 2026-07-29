# Support

Matea is currently a release candidate. Support is best-effort and focused on reproducible installation, repository safety, ChatGPT connectivity, runtime recovery, and release-blocking defects.

## Before asking for help

Run:

```bash
matea --version
matea doctor
matea status --json
matea repo list --json
```

The legacy `repo-harness` command is still accepted during the 1.x compatibility period. Redact tokens, OAuth material, private repository names, absolute home paths, email addresses, and proprietary source before sharing output.

## Where to ask

- Reproducible bugs: use the **Bug report** issue template.
- Documentation errors: use the **Documentation** template.
- Setup or usage questions: use the **Support question** template or GitHub Discussions.
- Feature proposals: use the **Feature request** template.
- Vulnerabilities: follow [SECURITY.md](SECURITY.md), never a public issue.

Issues should remain actionable and tied to a reproducible problem or a concrete documentation gap. Discussions are better for open-ended workflow questions and usage patterns.

## Useful details

Include the operating system, Node and Bun versions, installation method, exact command, expected result, actual result, and the smallest redacted log excerpt that demonstrates the problem. For runtime incidents, also say whether the local health endpoint, public MCP endpoint, and independent recovery path were reachable.
