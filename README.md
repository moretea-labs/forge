# Forge

<p align="center">
  <img src="docs/images/forge-banner.svg" alt="Forge — local-first action assistant" width="1280">
</p>

<p align="center"><strong>Your local-first action assistant for software work.</strong></p>
<p align="center"><a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a></p>

Forge connects ChatGPT to your real local development environment so it can inspect current project state, make bounded changes, run checks, manage long-running commands, and return reviewable evidence instead of relying only on chat memory.

## What Forge can do

- **Work with real local repositories** — register multiple repositories once, then bind every operation to an explicit repository and checkout.
- **Keep small work lightweight** — understood, bounded changes use the Direct path; inspection alone does not force a Plan, Issue, Agent, or worktree.
- **Manage long commands without re-running them** — builds and tests use one stable Process lifecycle that can be queried, waited on, inspected, or cancelled.
- **Run independent work concurrently** — unrelated repositories can progress in parallel; one repository can use separate worktrees when isolation is actually needed; the same checkout remains single-writer.
- **Reuse valid verification** — equivalent checks can coalesce or reuse evidence while content or environment changes invalidate stale results.
- **Inspect explicit unregistered folders** — bounded one-off local workspace actions do not silently register a repository or initialize Git.
- **Recover execution state** — repository identity, work, processes, verification, release state, and recovery facts survive individual chat turns.
- **Keep hard boundaries explicit** — remote writes, destructive effects, outside-workspace access, and secrets remain policy-gated.
- **Extend through typed plugins** — optional capabilities reuse the same local Controller without widening the normal ChatGPT surface.

## How ChatGPT uses Forge

The normal ChatGPT connector exposes a bounded **19-tool** MCP surface. Five stable facades — `rh_status`, `rh_access`, `rh_inbox`, `rh_context`, and `rh_work` — cover most orchestration; repository, source/patch, check, Process, plugin-dispatch, and result tools complete the default surface.

You normally do not choose tools yourself. Ask for the outcome in natural language; Forge is designed to choose the shortest valid execution path.

```text
Small task:  inspect -> relevant context -> Direct Edit -> focused check -> commit
Long task:   resolve identity -> durable work only if needed -> Process/worktree -> verify -> integrate -> clean
```

Examples:
- “Use Forge to find why this test fails, fix it, run the focused tests, and commit.”
- “Compare these two registered repositories and update them independently.”
- “Run the build; if it takes time, keep using the same Process instead of starting it again.”
- “Inspect this local folder without registering it.”
- “Check the current Runtime and tell me what actually blocks release.”

## Why Forge

- **Real state lives outside the chat** — Git state, repository identity, execution state, checks, and evidence remain locally addressable.
- **Direct-first execution** — heavier workflow machinery is reserved for recovery, isolation, dependencies, long-running work, or real risk.
- **Explicit execution identity** — `repoId` plus `checkoutId` prevents one session from silently acting on another checkout.
- **Reviewable effects** — localized diffs, exact checks, Process receipts, and release evidence show what actually happened.
- **Local control** — the Canonical Runtime and recovery authority stay on the local machine.
- **Stable client contract** — tool-schema changes are fenced as recoverable reinitialization instead of silently using a stale schema.

## Release status

The current source version is `1.4.0-rc.6`. The npm package `@moretea-labs/forge` is **not public yet**. Source version, release readiness, GitHub Release, and npm publication are separate facts; an immutable revision must pass the release gate before publication.

## Quick start

Requirements: Git, Node.js 20.10 or newer, npm, and a writable home directory. Bun 1.0+ is optional for installed use and recommended for source development and the complete test suite.

```bash
git clone https://github.com/moretea-labs/forge.git
cd forge
npm ci --ignore-scripts --no-audit --no-fund
npm install -g . --omit=optional --no-audit --no-fund

forge --version
forge setup open --target both
# complete the printed action, then continue:
forge setup next
forge setup close
forge doctor
```

Register or adopt a repository:

```bash
forge adopt --repo /path/to/your-project --dry-run
forge adopt --repo /path/to/your-project
forge repo list --json
```

Maintained first-use path:
1. [Install and start](docs/tutorials/01-install-and-start.md)
2. [Connect ChatGPT](docs/tutorials/02-connect-chatgpt.md)
3. [Complete the first repository task](docs/tutorials/03-first-repository-task.md)

When the npm RC is published:

```bash
npm install -g @moretea-labs/forge@next
# or consume the same package with Bun:
bun add -g @moretea-labs/forge@next
```

## Execution model

**Direct** is the default for bounded, understood work. **Process Runtime** owns commands and checks that need a process lifecycle: a command is spawned once and later status/wait/log/cancel operations attach to that same execution. **Durable work and worktrees** are used when recovery, isolation, dependencies, concurrency, or a longer lifecycle actually requires them. **Canonical Runtime + Recovery** provide one active local Runtime authority and an independent recovery boundary.

See [Core Concepts](docs/wiki/Core-Concepts.md), [Work Lifecycle](docs/wiki/Work-Lifecycle.md), [Runtime Architecture](docs/wiki/Runtime-Architecture.md), and [Implementation](docs/wiki/Implementation.md).

## Safety and product identity

Forge separates observation, normal local changes, remote effects, destructive actions, outside-workspace access, and secrets. Full Access removes repetitive approval for ordinary local repository work; it does not weaken destructive, remote, or secret boundaries. See [Security Model](docs/wiki/Security-Model.md).

The active product identity is **Forge**. Public commands are `forge`, `forge-hook`, and `forge-runtime`. Historical legal attribution and explicit read-only migration fallbacks may retain former upstream identifiers because rewriting historical evidence would be incorrect.

## Documentation and support

- [Documentation hub](docs/README.md) · [Wiki](docs/wiki/Home.md) · [Architecture](docs/wiki/Architecture.md) · [Implementation](docs/wiki/Implementation.md)
- [Public usage guide](docs/public-usage-guide.md) · [Platform support](docs/operations/platform-support.md) · [Troubleshooting](docs/operations/troubleshooting.md) · [Release process](docs/operations/releasing.md)
- Bugs/docs: [GitHub Issues](https://github.com/moretea-labs/forge/issues) · Usage: [SUPPORT.md](SUPPORT.md) · Security: [SECURITY.md](SECURITY.md)
- Contributions: [CONTRIBUTING.md](CONTRIBUTING.md) · Releases: [CHANGELOG.md](CHANGELOG.md)

Forge remains in release-candidate hardening; releases are created only from a revision that passes the published release gate.

## License and attribution

Licensed under the [MIT License](LICENSE). Upstream copyright and permission notices remain part of the distribution; see [NOTICE](NOTICE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
