# Support

repo-harness is currently a release candidate. Support is best-effort and focused on reproducible installation, repository safety, ChatGPT connectivity, and release-blocking defects.

## Before asking for help

Run:

```bash
repo-harness --version
repo-harness doctor
repo-harness status --json
repo-harness repo list --json
```

Redact tokens, OAuth material, private repository names, absolute home paths, email addresses, and proprietary source before sharing output.

## Where to ask

- Reproducible bugs: use the **Bug report** issue template.
- Documentation errors: use the **Documentation** template.
- Setup or usage questions: use the **Support question** template.
- Feature proposals: use the **Feature request** template.
- Vulnerabilities: follow [SECURITY.md](SECURITY.md), never a public issue.

GitHub Discussions should become the long-term home for open-ended usage questions after it is enabled. Issues should remain actionable and tied to a reproducible problem or a concrete documentation gap.

## Useful details

Include the operating system, Node and Bun versions, installation method, exact command, expected result, actual result, and the smallest redacted log excerpt that demonstrates the problem.
