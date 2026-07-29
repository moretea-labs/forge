# Matea Documentation

This is the public documentation hub for Matea's current open-source and runtime surface. Executable behavior and [`docs/architecture/current/`](architecture/current/) are authoritative; historical notes are context, not current contracts.

## Choose a path

| You want to… | Start here | Continue with |
| --- | --- | --- |
| Install Matea | [Install and start](tutorials/01-install-and-start.md) | [Platform support](operations/platform-support.md) |
| Connect ChatGPT | [Connect ChatGPT](tutorials/02-connect-chatgpt.md) | [MCP setup](repo-harness-chatgpt-mcp-setup.md) |
| Finish a first task | [First repository task](tutorials/03-first-repository-task.md) | [Public usage guide](public-usage-guide.md) |
| Understand safety and work state | [Wiki: Core Concepts](wiki/Core-Concepts.md) | [Wiki: Work Lifecycle](wiki/Work-Lifecycle.md) |
| Operate or recover the runtime | [Wiki: Operations](wiki/Operations.md) | [Troubleshooting](operations/troubleshooting.md) |
| Contribute or release | [Contributing](../CONTRIBUTING.md) | [Release process](operations/releasing.md) |

Chinese entry points: [公开使用指南](public-usage-guide.zh-CN.md), [教程目录](tutorials/README.zh-CN.md), [平台支持](operations/platform-support.zh-CN.md), and [故障排查](operations/troubleshooting.zh-CN.md).

## Stable product surface

The default `advanced` connector surface exposes 133 stable tools. The five preferred facades—`rh_access`, `rh_status`, `rh_inbox`, `rh_context`, and `rh_work`—cover the normal control loop; Direct Edit, commands, Git, durable Work, agents, Campaigns, plugins, browser, iOS, artifacts, and recovery remain available when needed. `core` is a compatibility alias for the same stable schema, while `full` preserves exhaustive legacy compatibility.

## Documentation map

### Learn and install

- [Tutorials](tutorials/README.md)
- [Public usage guide](public-usage-guide.md)
- [Features and setup levels](operations/features.md)
- [Platform support](operations/platform-support.md)

### Operate and recover

- [Troubleshooting](operations/troubleshooting.md)
- [Controller reliability runbook](operations/controller-reliability-runbook.md)
- [Stable External Runtime Supervisor](operations/stable-external-runtime-supervisor.md)
- [Standalone disaster recovery](operations/standalone-disaster-recovery.md)
- [Controller performance and 502 troubleshooting](operations/controller-performance-and-502.md)

### Integrate

- [Provider configuration](operations/provider-configuration.md)
- [Browser plugin](operations/controller-browser-plugin.md)
- [Google assistant plugins](personal-assistant-google-plugins.md)
- [Local system assistant](operations/local-system-assistant.md)
- [iOS development assistant](repo-harness-ios-development-assistant.md)

### Maintain and release

- [Release process](operations/releasing.md)
- [Open-source release hygiene](operations/open-source-release-hygiene.md)
- [GitHub repository baseline](operations/github-repository.md)
- [Versioning](versioning.md)
- [Security policy](../SECURITY.md)

## Wiki

The versioned Wiki source is under [`docs/wiki/`](wiki/). It provides task-oriented summaries and links back to detailed repository docs:

- [Home](wiki/Home.md)
- [Quick Start](wiki/Quick-Start.md)
- [Core Concepts](wiki/Core-Concepts.md)
- [Work Lifecycle](wiki/Work-Lifecycle.md)
- [Runtime Architecture](wiki/Runtime-Architecture.md)
- [Operations](wiki/Operations.md)
- [Troubleshooting](wiki/Troubleshooting.md)
- [Security Model](wiki/Security-Model.md)
- [Releases and Upgrades](wiki/Releases-and-Upgrades.md)

## Current runtime facts

- The Controller is a global multi-repository service, while repository work remains explicitly scoped by stable `repoId` and, when needed, `checkoutId`.
- Controller Home owns service configuration, authentication, provider settings, durable runtime state, and stable runtime release metadata. Repository-local policy remains repository-scoped.
- The public MCP endpoint is separate from the localhost-only Controller UI.
- Long-running work returns bounded summaries and durable references instead of unbounded logs.
- Stable runtime rollout uses immutable releases and exact revision identity; ambiguous ownership or release drift fails closed.

## Authority and history

- Current architecture: [`architecture/current/README.md`](architecture/current/README.md)
- Architecture index: [`architecture/index.md`](architecture/index.md)
- Consolidated history: [`architecture/history.md`](architecture/history.md)
- Historical research: [`researches/`](researches/)

Detailed superseded documents remain recoverable from Git history and do not override the current architecture set.
