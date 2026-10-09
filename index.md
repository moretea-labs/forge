---
layout: default
title: "Forge Wiki — ChatGPT MCP for local computer and software tasks"
description: "Forge: local-first ChatGPT MCP for secure computer use, browser automation, coding, and developer workflows."
permalink: /
---

# Forge Wiki — ChatGPT MCP for local computer and software tasks

Forge is a local-first, permission-scoped MCP action runtime for ChatGPT and other explicitly selected external controllers. It gives ChatGPT durable execution tools for local files, Git repositories, browsers, and authorized services—**without putting an additional AI agent inside Forge**. The product is intentionally Direct-first: ordinary bounded work stays lightweight, while Process Runtime, Work, worktrees, scheduling, and Recovery exist for the cases that actually need lifecycle or isolation.

## Get started with the latest stable version

Install [Forge v1.8.1](https://github.com/moretea-labs/forge/releases/tag/v1.8.1) from [npm](https://www.npmjs.com/package/@moretea-labs/forge):

```bash
npm install -g @moretea-labs/forge@latest
forge setup
forge setup configure --controller chatgpt --tunnel auto
forge setup next
```

macOS and Linux are supported; WSL2 is the recommended Windows path. Native Windows remains a preview. For upgrades and service setup, see [Installation](Installation.html).

## Start here

- New user: [Quick Start](Quick-Start.html)
- Installation choices: [Installation](Installation.html)
- Product model: [Core Concepts](Core-Concepts.html)
- Request-to-evidence flow: [Work Lifecycle](Work-Lifecycle.html)
- System boundaries: [Architecture](Architecture.html)
- Runtime behavior: [Runtime Architecture](Runtime-Architecture.html)
- Source implementation map: [Implementation](Implementation.html)
- Run and recover the service: [Operations](Operations.html)
- Computer and provider setup: [Computer and Plugins](Computer-and-Plugins.html) · [中文教程](Computer-and-Plugins.zh-CN.html)
- Optional capabilities: [Integrations](Integrations.html)
- Diagnose a problem: [Troubleshooting](Troubleshooting.html)
- Trust boundaries: [Security Model](Security-Model.html)
- Upgrade or publish: [Releases and Upgrades](Releases-and-Upgrades.html)

## Current baseline

The normal ChatGPT connector uses a bounded 19-tool surface with five preferred facades. Small understood work can go directly from context to patch to verification. Long commands and checks use the managed Process Runtime; separate worktrees are used when concurrency or isolation actually requires them. One Canonical Forge Runtime owns active execution authority, while standalone Recovery remains an independent failure domain.

Plugin capability completeness is deliberately separate from the core Runtime baseline: a plugin can be unavailable without redefining whether repository execution, Process Runtime, or Runtime recovery is correct.

## What belongs where

The Wiki explains stable concepts, architecture, implementation boundaries, and common operator decisions. Exact source contracts, compatibility matrices, tests, and incident procedures remain versioned in the [repository documentation](https://github.com/moretea-labs/forge/tree/main/docs). When Wiki content and repository source disagree, the versioned repository source is authoritative.

## Project links

- [Repository](https://github.com/moretea-labs/forge)
- [Documentation hub](https://github.com/moretea-labs/forge/blob/main/docs/README.md)
- [Issues](https://github.com/moretea-labs/forge/issues)
- [Support](https://github.com/moretea-labs/forge/blob/main/SUPPORT.md)
- [Security policy](https://github.com/moretea-labs/forge/blob/main/SECURITY.md)
