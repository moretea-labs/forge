# repo-harness Controller Runtime

<p align="center">
  <img src="docs/images/repo-harness-banner.svg" alt="repo-harness Controller Runtime" width="1280">
</p>

<p align="center">
  <strong>A local-first, reviewable repository execution bridge for ChatGPT.</strong>
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a>
</p>

repo-harness lets ChatGPT inspect repositories, make bounded edits, run checks, manage longer tasks, and return evidence without treating a chat transcript as the source of truth. Work stays associated with the repository and can be resumed after a disconnected request or a new conversation.

## What it provides

- **Bounded repository tools** for reading files, searching code, applying reviewed patches, and using structured Git operations.
- **Resumable work** with repository-bound plans, task state, execution records, and review evidence.
- **Safer execution** through isolated worktrees, path limits, checks, and explicit gates for remote or destructive actions.
- **ChatGPT integration** through an MCP endpoint, plus a local CLI and controller UI for diagnosis and review.
- **Optional coding agents and plugins** for larger implementations and external services; they remain subordinate to the repository workflow.

## Release status

The repository is preparing `1.4.0-rc.6` as the next trustworthy release candidate. The npm package `@moretea-labs/repo-harness-controller` is **not public yet**, so registry install commands are documented for the upcoming release but are not presented as currently available.

Until the first npm publication, install from a reviewed checkout.

## Quick start

Requirements: Git, Node.js 20.10 or newer, npm, and a writable home directory. Bun 1.0+ is optional and recommended for source development and the full test suite.

```bash
git clone https://github.com/moretea-labs/repo-harness-controller-runtime.git
cd repo-harness-controller-runtime
npm ci --ignore-scripts --no-audit --no-fund
npm install -g . --omit=optional --no-audit --no-fund

repo-harness --version
repo-harness init --target both
repo-harness doctor
```

Register or adopt a repository:

```bash
repo-harness adopt --repo /path/to/your-project --dry-run
repo-harness adopt --repo /path/to/your-project
repo-harness repo list --json
```

When the npm RC is published, the equivalent package installs will be:

```bash
npm install -g @moretea-labs/repo-harness-controller@next
# or, from the same npm package:
bun add -g @moretea-labs/repo-harness-controller@next
```

Bun is an alternative package client and runtime; it does not require a separate repo-harness publication.

## Connect ChatGPT

Start with the maintained connector tutorial:

1. [Install and start](docs/tutorials/01-install-and-start.md)
2. [Connect ChatGPT](docs/tutorials/02-connect-chatgpt.md)
3. [Complete the first repository task](docs/tutorials/03-first-repository-task.md)

The connector uses a stable HTTPS `/mcp` endpoint. The detailed guide covers local binding, authentication, Tailscale Funnel, Cloudflare, and troubleshooting without expanding those operational details in this README.

## Documentation

- [Documentation index](docs/README.md)
- [Public usage guide](docs/public-usage-guide.md)
- [Features and setup levels](docs/operations/features.md)
- [Platform support](docs/operations/platform-support.md)
- [Troubleshooting](docs/operations/troubleshooting.md)
- [Release process](docs/operations/releasing.md)
- [Architecture Wiki](https://github.com/moretea-labs/repo-harness-controller-runtime/wiki) with [versioned Wiki source](docs/wiki/Home.md)

The README is intentionally user-focused. Architecture, lifecycle design, invariants, recovery, and operator material belong in the Wiki and versioned docs.

## Project status and support

This project is still in release-candidate hardening. Interfaces may change before `1.4.0`, and the stable release will only be cut from an immutable revision that passes the published release gate.

- Bugs and documentation problems: [GitHub Issues](https://github.com/moretea-labs/repo-harness-controller-runtime/issues)
- Usage questions: [SUPPORT.md](SUPPORT.md)
- Security reports: [SECURITY.md](SECURITY.md)
- Contributions: [CONTRIBUTING.md](CONTRIBUTING.md)
- Release history: [CHANGELOG.md](CHANGELOG.md)

## License and attribution

Licensed under the [MIT License](LICENSE). This project is derived from `AncientTwo/repo-harness` and contains substantial modifications by Moretea Labs contributors; see [NOTICE](NOTICE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
