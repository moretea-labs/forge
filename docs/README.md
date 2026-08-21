# Forge Documentation

> Maintained documentation for the current Forge product and runtime. Executable behavior and [`architecture/CURRENT.md`](architecture/CURRENT.md) are authoritative for implementation facts and architecture contracts; historical notes are context, not active contracts.

[中文文档中心](README.zh-CN.md) · [GitHub](https://github.com/moretea-labs/forge) · [Releases](https://github.com/moretea-labs/forge/releases) · [Support](../SUPPORT.md)

## Start here

| Goal | Start | Next |
| --- | --- | --- |
| Install Forge | [Install and start](tutorials/01-install-and-start.md) | [Platform support](operations/platform-support.md) |
| Connect ChatGPT | [Connect ChatGPT](tutorials/02-connect-chatgpt.md) | [MCP setup](forge-chatgpt-mcp-setup.md) |
| Complete a first task | [First repository task](tutorials/03-first-repository-task.md) | [Public usage guide](public-usage-guide.md) |
| Install an official provider | [Plugin management](forge-plugin-management.md) | [Plugin management](forge-plugin-management.md) |
| Understand Forge | [Current architecture](architecture/CURRENT.md) | [Roadmap](ROADMAP.md) |
| Operate or recover | [Operations](wiki/Operations.md) | [Troubleshooting](operations/troubleshooting.md) |
| Contribute or release | [Contributing](../CONTRIBUTING.md) | [Release process](operations/releasing.md) |

## Product surface

The normal ChatGPT connector exposes a bounded **19-tool MCP surface**. The five preferred facades—`rh_status`, `rh_access`, `rh_inbox`, `rh_context`, and `rh_work`—cover the normal control loop; repository, source/patch, check, Process, plugin-dispatch, and result tools complete the default surface.

Forge is Direct-first: investigation does not create durable Work by itself, and worktrees are introduced only when isolation is needed. Long-running commands use one Process lifecycle and return bounded summaries plus durable references.

## Documentation map

### Learn
- [Tutorials](tutorials/README.md)
- [Public usage guide](public-usage-guide.md)
- [Features and setup levels](operations/features.md)
- [Platform support](operations/platform-support.md)

### Understand
- [Current architecture](architecture/CURRENT.md)
- [Roadmap](ROADMAP.md)
- [Architecture evolution](architecture/EVOLUTION.md)
- [Version architecture snapshots](architecture/versions/)
- [Core Concepts](wiki/Core-Concepts.md)

### Integrate
- [Plugin management](forge-plugin-management.md)
- [Browser provider](operations/controller-browser-plugin.md)
- [Desktop provider](operations/controller-desktop-plugin.md)
- [Local system assistant](operations/local-system-assistant.md)
- [iOS development assistant](forge-ios-development-assistant.md)

### Operate
- [Operations overview](wiki/Operations.md)
- [Troubleshooting](operations/troubleshooting.md)
- [Controller reliability runbook](operations/controller-reliability-runbook.md)
- [Runtime performance diagnostics](operations/runtime-performance-diagnostics.md)
- [Standalone disaster recovery](operations/standalone-disaster-recovery.md)

### Maintain
- [Roadmap](ROADMAP.md)
- [Release changelog](../CHANGELOG.md)
- [Release process](operations/releasing.md)
- [Open-source release hygiene](operations/open-source-release-hygiene.md)
- [Versioning](versioning.md)
- [Security policy](../SECURITY.md)

## Current runtime facts

- Controller is a global multi-repository service; repository work is explicitly scoped by stable `repoId` and, when needed, `checkoutId`.
- Controller Home owns service configuration, authentication, provider settings, durable runtime state, and release metadata.
- The public MCP endpoint is separate from the localhost-only Controller UI.
- Long-running work returns bounded summaries and durable references instead of unbounded logs.
- Stable runtime rollout uses immutable releases and exact revision identity; ambiguous ownership or release drift fails closed.

## Authority and history

Current architecture lives only in [`architecture/CURRENT.md`](architecture/CURRENT.md). [`ROADMAP.md`](ROADMAP.md) records current priorities, [`architecture/EVOLUTION.md`](architecture/EVOLUTION.md) records architecture history, and [`architecture/versions/`](architecture/versions/) stores release-family snapshots. Research notes and task records are evidence, not current contracts.
