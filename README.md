# Matea

<p align="center">
  <img src="docs/images/matea-banner.svg" alt="Matea — local-first action assistant" width="1280">
</p>

<p align="center"><strong>Your local-first action assistant for software work.</strong></p>

<p align="center"><a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a></p>

Matea gives ChatGPT a durable local workspace for understanding projects, carrying out bounded actions, and returning reviewable evidence. It focuses on software repositories today, while its assistant model can grow into connected work across browsers, services, devices, and personal workflows.

## What Matea does

- **Understands project context** from repositories, documentation, task state, and prior evidence.
- **Acts with boundaries** through reviewed patches, isolated worktrees, checks, and explicit gates for remote or destructive operations.
- **Remembers durable work** in repository-bound plans, runs, handoffs, and verification records instead of relying on one chat transcript.
- **Connects ChatGPT to local execution** through MCP, a CLI, and a local runtime.
- **Extends through tools and assistants** such as coding agents, browsers, GitHub, and optional plugins without bypassing policy or review.

## Release status

Matea is preparing `1.4.0-rc.6`. The npm package `@moretea-labs/matea` is **not public yet**, so source installation is the currently verified path and registry commands below describe the upcoming release.

## Quick start

Requirements: Git, Node.js 20.10 or newer, npm, and a writable home directory. Bun 1.0+ is optional and recommended for source development and the full test suite.

```bash
git clone https://github.com/moretea-labs/matea.git
cd matea
npm ci --ignore-scripts --no-audit --no-fund
npm install -g . --omit=optional --no-audit --no-fund

matea --version
matea init --target both
matea doctor
```

Register or adopt a repository:

```bash
matea adopt --repo /path/to/your-project --dry-run
matea adopt --repo /path/to/your-project
matea repo list --json
```

When the npm RC is published:

```bash
npm install -g @moretea-labs/matea@next
# or, from the same npm package:
bun add -g @moretea-labs/matea@next
```

Bun consumes the same npm package; it does not have a separate publication or version line.

## Compatibility

The `repo-harness` and `repo-harness-hook` commands remain compatibility aliases during the Matea 1.x migration. Existing `.repo-harness` runtime directories and protocol identifiers are intentionally preserved so the product rename does not invalidate local state or integrations.

## Connect ChatGPT

1. [Install and start](docs/tutorials/01-install-and-start.md)
2. [Connect ChatGPT](docs/tutorials/02-connect-chatgpt.md)
3. [Complete the first repository task](docs/tutorials/03-first-repository-task.md)

The connector uses a stable HTTPS `/mcp` endpoint. The maintained tutorials cover authentication, local binding, Tailscale Funnel, Cloudflare, and troubleshooting.

## Documentation

- [Documentation index](docs/README.md)
- [Public usage guide](docs/public-usage-guide.md)
- [Features and setup levels](docs/operations/features.md)
- [Platform support](docs/operations/platform-support.md)
- [Troubleshooting](docs/operations/troubleshooting.md)
- [Release process](docs/operations/releasing.md)
- [Architecture Wiki](https://github.com/moretea-labs/matea/wiki) and [versioned Wiki source](docs/wiki/Home.md)

Architecture, lifecycle design, recovery, and operator details live in the Wiki and versioned docs rather than the primary README.

## Project status and support

Matea remains in release-candidate hardening. Interfaces may change before `1.4.0`, and stable publication will only occur from an immutable revision that passes the published release gate.

- Bugs and documentation: [GitHub Issues](https://github.com/moretea-labs/matea/issues)
- Usage questions: [SUPPORT.md](SUPPORT.md)
- Security reports: [SECURITY.md](SECURITY.md)
- Contributions: [CONTRIBUTING.md](CONTRIBUTING.md)
- Release history: [CHANGELOG.md](CHANGELOG.md)

## License and attribution

Licensed under the [MIT License](LICENSE). Matea began as a derivative of `AncientTwo/repo-harness` and has since developed into a substantially modified, independently maintained product. The upstream copyright and permission notice remain part of the distribution; see [NOTICE](NOTICE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
